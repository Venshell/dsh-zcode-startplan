/**
 * ZCode 免费 plan 通道的一次请求编排（切号 / captcha / 退避的唯一实现）。
 *
 * ```
 * 选号（手动顺序，跳过该模型限流中的账号）
 *   → 本轮是否需要 captcha（"要了才取"：被 3007 拒过才产出）
 *   → 组 body（官方身份块 + 日期块 + tools 断点）
 *   → 直发上游
 *   → 200：先读「是否真的产出了内容」
 *        ├─ 有内容 → 交给调用方流式消费（此后禁止换号）
 *        └─ 无内容 → 标记该账号×模型 → 换号重试（调用方零 chunk）
 *   → 非 200：按错误表处置
 *        ├─ 额度用尽 → 标号 + 换号
 *        ├─ 并发限流 → 打忙标记 + 退避重试（穷尽后换号，钉定模式除外）
 *        ├─ captcha 失败 → 换新 captcha 重试
 *        └─ 风控 / 鉴权 / 其它 → 如实报错（不重试）
 * ```
 *
 * ## 两条不可动摇的约定
 *
 * 1. **`emitted` 闸**：一旦把 chunk 交给调用方，绝不再换号/重试（防两份输出）。
 * 2. **每轮重试都必须重新 mint captcha**：param 一次性，复用必 3007。
 */

import { buildUpstreamBody, resolveImages } from './anthropic-body.js'
import {
  CONCURRENCY_RETRY_BASE_MS,
  CONCURRENCY_RETRY_MAX,
  DEFAULT_HEAD_TIMEOUT_MS,
  DEFAULT_READ_TIMEOUT_MS,
  QUOTA_SWITCH_MAX,
  classifyUpstreamError,
  concurrencyRetryDelayMs,
  describeUpstreamError,
} from './errors.js'
import { isHeadTimeoutError, readContentHead } from './sse.js'
import { buildZcodeHeaders, ZCODE_PLAN_MESSAGES_URL, ZCODE_FALLBACK_MODELS, nextUtc8DayStartMs } from './upstream.js'
import { ZCODE_CAPTCHA_FALLBACK } from './captcha/sdk-page.js'
import { launchCommand } from './captcha/minter.js'
import { parsePinnedModelId } from './pinned-model.js'
import { isUsableCredential } from './pool.js'

/** 「该账号×模型当前需要 captcha」的记忆时长（避免每条消息都白吃一次 3007）。 */
const CAPTCHA_REQUIRED_TTL_MS = 2 * 60_000

/**
 * 零内容短窗（1.0.1 审计修复）：首次 `200 + 零内容` 只打这个时长的限流标记，
 * 过期自动恢复。窗口内再吃一次零内容才升级为「当日用尽」。
 * 10 分钟 = 上游瞬时抖动的典型恢复尺度，远小于误判一整天的代价。
 */
const EMPTY_CONTENT_WINDOW_MS = 10 * 60_000

/**
 * 上游黑洞的默认分类（issue #4）。
 *
 * 额度用尽之后，本渠道的上游对该账号**不再出流**：既不回 4xx，也不产出任何事件。
 * 这类失败必须落成 `TIMEOUT` 而不是 `PROVIDER_ERROR`：
 * - `TIMEOUT` 在 `fallback.js` 的回退名单里，回退链路才有机会**静默改道**；
 * - 文案能说清是「没拿到内容」，而不是笼统的「超时或不可用」。
 *
 * 可在 config 里经 `headTimeoutMs` / `readTimeoutMs` 覆盖（见 index.js 的 config schema）。
 */
const TIMEOUT_CODE = 'TIMEOUT'

/** 串行队列：captcha 产出是设备级的，并发无益且会互相踩页面。 */
class SerialQueue {
  #tail = Promise.resolve()
  run(task) {
    const next = this.#tail.then(task, task)
    /** 队列本身不因一次失败而卡死。 */
    this.#tail = next.catch(() => {})
    return next
  }
}

/** captcha 产出失败的指数退避闸门（保护设备信誉）。 */
class CaptchaBackoff {
  #streak = 0
  #until = 0
  noteFailure(now = Date.now()) {
    this.#streak += 1
    const cooldown = Math.min(60_000 * 2 ** (this.#streak - 1), 30 * 60_000)
    this.#until = now + cooldown
    return cooldown
  }
  noteSuccess() {
    this.#streak = 0
    this.#until = 0
  }
  remainingMs(now = Date.now()) {
    return Math.max(0, this.#until - now)
  }
  get failureStreak() {
    return this.#streak
  }
}

/** 发车闸门：全局串行 + 按模型间隔（GLM-5.3 需 350ms，Flash 不需要）。 */
class ModelGate {
  #chain = Promise.resolve()
  #lastVerdict = { model: '', at: 0 }
  #gaps
  constructor(gaps) {
    this.#gaps = gaps
  }
  async run(model, task) {
    const previous = this.#chain
    let release
    this.#chain = new Promise((resolve) => {
      release = resolve
    })
    try {
      await previous
      const gap = this.#gaps[String(model).toLowerCase()] ?? 0
      if (gap > 0 && this.#lastVerdict.model === model) {
        const wait = gap - (Date.now() - this.#lastVerdict.at)
        if (wait > 0) await sleep(wait)
      }
      try {
        return await task()
      } finally {
        this.#lastVerdict = { model, at: Date.now() }
      }
    } finally {
      release()
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 正数就用它，其余一律回落缺省（`0` / `NaN` / 负值 / 非数字都算「没配」）。 */
function positiveOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * 一次「zcode-plan」调用的可复用客户端。
 *
 * 进程内应是**单实例**（captcha 产出、闸门、需求记忆都是设备级/全局状态）。
 */
export class ZcodePlanClient {
  #pool
  #minter
  #fetchImpl
  #log
  #now
  #cwd
  #queue = new SerialQueue()
  #backoff = new CaptchaBackoff()
  #gate = new ModelGate({ 'glm-5.3': 350 })
  #captchaRequiredUntil = new Map()
  #captchaConfig
  #captchaConfigAt = 0
  /** 附件服务回调（`() => ctx.get('attachments')`，可选）：图片引用 → 请求字节。 */
  #resolveDeps
  /** 并发限流退避基数（生产 1500ms；测试可注入小值，避免用例跑 4.5 秒真实退避）。 */
  #concurrencyBaseMs
  /** 首内容超时 / 流内静默超时（issue #4；缺省 90s / 180s，生产远小于宿主 ~300s）。 */
  #headTimeoutMs
  #readTimeoutMs
  // 零内容两级证据的计数**不在本类**：1.0.1 修复把它挪进了 pool 的
  // `noteEmptyContentWatch / isEmptyContentWatched`（软优先观察窗）。
  // 原因：放进 `model_rate_limits`（当日硬过滤表）会让唯一账号在短窗内
  // 被 pick 硬过滤掉 → 第二次零内容永远发生不了 → 升级逻辑形同虚设。

  constructor(options) {
    this.#pool = options.pool
    this.#minter = options.minter
    this.#fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.#log = options.log ?? (() => {})
    this.#now = options.now ?? (() => Date.now())
    this.#cwd = options.cwd ?? process.cwd()
    this.#captchaConfig = options.captchaConfig
    this.#resolveDeps = options
    this.#concurrencyBaseMs =
      typeof options.concurrencyRetryBaseMs === 'number' && options.concurrencyRetryBaseMs >= 0
        ? options.concurrencyRetryBaseMs
        : CONCURRENCY_RETRY_BASE_MS
    this.#headTimeoutMs = positiveOr(options.headTimeoutMs, DEFAULT_HEAD_TIMEOUT_MS)
    this.#readTimeoutMs = positiveOr(options.readTimeoutMs, DEFAULT_READ_TIMEOUT_MS)
  }

  /** 供状态工具读取观测值。 */
  observability() {
    return {
      captchaFailureStreak: this.#backoff.failureStreak,
      captchaCooldownRemainingMs: this.#backoff.remainingMs(this.#now()),
      captchaRequiredAccounts: [...this.#captchaRequiredUntil.keys()].length,
    }
  }

  /**
   * 钉定模式选号：只取指定账号，**绝不换号**。
   *
   * 与 `pool.pick` 的差异：不按手动顺序、不看其他账号；但同样跳过「该模型
   * 限流中」的账号 —— 限流标记意味着额度已尽，硬发只会吃一个 1005。
   * 账号缺失 / 停用 / 凭据不可用 / 限流中都以**明确报错**收场（各自给出路），
   * 不静默回退到别的账号 —— 那会让「钉定」名存实亡。
   */
  #pickPinned(accountId, modelId) {
    const entry = this.#pool.get(accountId, { withCredentials: true })
    if (entry === undefined) {
      throw Object.assign(
        new Error(`钉定的账号已不存在（可能已被删除）。请重新登录添加，或改选不带账号后缀的自动选号条目。`),
        { code: 'QUOTA' },
      )
    }
    if (entry.enabled !== true) {
      throw Object.assign(
        new Error(`钉定的账号「${entry.nickname}」已被停用。请在插件面板重新启用，或改选自动选号条目。`),
        { code: 'QUOTA' },
      )
    }
    const resetAt = entry.model_rate_limits?.[modelId]
    if (typeof resetAt === 'number' && resetAt > 0 && this.#now() < resetAt) {
      const at = new Date(resetAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      throw Object.assign(
        new Error(
          `钉定的账号「${entry.nickname}」在模型「${modelId}」上处于限流期（至 ${at}）。` +
          '可等待重置、在面板「清除限流」后重试，或改选自动选号条目换用其它账号。',
        ),
        { code: 'QUOTA' },
      )
    }
    /**
     * issue #4：钉定模式下 `last_error` 已是 1005/1113，也必须在**发请求之前**拒绝。
     * 否则照发 → 上游黑洞 → 挂满宿主的两次 ~300s → 用户只看到「超时或不可用」。
     */
    if (this.#pool.hasQuotaError?.(accountId) === true) {
      throw Object.assign(
        new Error(
          `钉定的账号「${entry.nickname}」已判额度用尽（上游 1005/1113），本次请求未发出。` +
          '免费额度按自然日 UTC+8 结算：可等次日重置、领取当日额度（`zcode-start-plan claim`）后重试，' +
          '或改选自动选号条目换用其它账号。',
        ),
        { code: 'QUOTA' },
      )
    }
    if (!isUsableCredential(entry.credential)) {
      throw Object.assign(
        new Error(`钉定的账号「${entry.nickname}」凭据不可用，请重新登录。`),
        { code: 'AUTH' },
      )
    }
    return { entry, credential: entry.credential }
  }

  /**
   * 3009 并发限流的统一处置（非 200 与 HTTP-200 业务错误两条路径共用）。
   *
   * 流程：立刻打 60s 忙标记（让**并行发起**的其它统一选号请求直接路由到空闲
   * 账号，而不是跟着一起撞这个忙账号）→ 未穷尽退避则休眠后原地重试 →
   * 穷尽后换号；钉定模式绝不换号，如实报错。
   *
   * @returns {Promise<'retry'|'switch'|Error>} retry=已休眠，原地重试；
   *   switch=换号；Error=钉定模式下的终态异常（调用方直接 throw）。
   */
  async #handleConcurrency({ accountId, model, attempt, pinned, picked, status, text, onRetry, fromHttp200 = false }) {
    const where = fromHttp200 ? '，HTTP 200' : ''
    this.#pool.markModelBusy?.(accountId, model)
    if (attempt < CONCURRENCY_RETRY_MAX) {
      const waitMs = concurrencyRetryDelayMs(attempt, this.#concurrencyBaseMs)
      this.#log(`[zcode] 并发限流（3009${where}），退避 ${waitMs}ms 后重试（穷尽后换号）`)
      onRetry?.({ reason: 'concurrency', attempt, message: describeUpstreamError(status, text) })
      await sleep(waitMs)
      return 'retry'
    }
    /** 退避穷尽仍 3009 → 换下一个账号（钉定模式绝不换号，如实报错）。 */
    this.#pool.noteError(accountId, describeUpstreamError(status, text))
    if (pinned !== null) {
      return Object.assign(
        new Error(
          `钉定的账号「${picked.entry.nickname}」在模型「${model}」上持续并发限流（3009）。` +
          '该账号可能正被其它会话占用：可稍后重试，或改选自动选号条目换用其它账号。',
        ),
        { code: 'RATE_LIMIT' },
      )
    }
    this.#log(`[zcode] 账号 ${accountId} 退避穷尽仍 3009${where} → 换号`)
    return 'switch'
  }

  /** 拉 captcha 配置（60 秒 TTL；失败不缓存 —— 一次网络抖动不该让 sceneId 永久固化）。 */
  async #resolveCaptchaConfig() {
    const now = this.#now()
    if (this.#captchaConfig !== undefined && now - this.#captchaConfigAt < 60_000) return this.#captchaConfig
    try {
      const first = this.#pool.list({ withCredentials: true })[0]
      if (first?.credential !== undefined && typeof this.#minter.fetchConfig === 'function') {
        const fetched = await this.#minter.fetchConfig(first.credential)
        if (fetched !== undefined) {
          this.#captchaConfig = fetched
          this.#captchaConfigAt = now
          return fetched
        }
      }
    } catch {
      // 回退兜底值。
    }
    return ZCODE_CAPTCHA_FALLBACK
  }

  /** 产出一个 captcha param（串行 + 退避闸门）。 */
  async mintCaptcha(signal) {
    const cooldown = this.#backoff.remainingMs(this.#now())
    if (cooldown > 0) {
      throw new Error(
        `captcha 产出处于冷却中（连续 ${this.#backoff.failureStreak} 次失败），约 ${Math.ceil(cooldown / 1000)} 秒后可重试。` +
        '这通常意味着设备信誉不足（上游把无感验证降级为滑块），继续重试只会让信誉更差。',
      )
    }
    const config = await this.#resolveCaptchaConfig()
    try {
      const outcome = await this.#queue.run(() => this.#minter.mint(config, { signal }))
      this.#backoff.noteSuccess()
      if (outcome.interactive === true) {
        this.#log('[zcode] ⚠ captcha 被要求交互式验证（滑块/拼图）—— 设备信誉可能已下降')
      }
      return { param: outcome.param, region: config.region ?? 'cn' }
    } catch (error) {
      this.#backoff.noteFailure(this.#now())
      throw error
    }
  }

  /**
   * 执行一次模型调用。
   *
   * @param {{
   *   options: any,
   *   model?: any,
   *   maxTokens?: number,
   *   signal?: AbortSignal,
   *   onRetry?: (info: { reason: string, attempt: number, message: string }) => void,
   * }} request
   * @returns {Promise<{
   *   head: Array<any>,
   *   decoder: { read(): Promise<{ done: boolean, value?: any }>, cancel(): Promise<void> } | undefined,
   *   accountId: string,
   *   model: string,
   *   credential: any,
   *   body: any,
   * }>}
   */
  async call(request) {
    let options = request.options
    /**
     * 钉定账号的两个来源（优先级：provider 路由 > 模型 id 后缀）：
     *
     * 1. **provider 路由**（`request.pinnedAccountId`）：每个账号一个独立
     *    provider 栏位（`zcode-start-plan-acct-<id>`，像 workbuddy 一样），
     *    路由本身就把「哪个账号出额度」钉死；
     * 2. **模型 id 后缀**（`<base>@acct:<账号id>`，0.3.0 形态）：保留兼容 ——
     *    旧会话里保存的钉定模型继续可用。
     *
     * 上游永远只见基础模型 id；选号不再按手动顺序轮换，只走钉定账号。
     */
    const routePin =
      typeof request.pinnedAccountId === 'string' && request.pinnedAccountId.trim().length > 0
        ? request.pinnedAccountId.trim()
        : null
    const idPin = parsePinnedModelId(options.model)
    const pinned = routePin !== null ? { accountId: routePin } : idPin
    const model = idPin === null ? options.model : idPin.baseModelId
    if (pinned !== null) {
      options = { ...options, model }
      if (typeof request.model?.id === 'string') {
        request = { ...request, model: { ...request.model, id: model } }
      }
    }
    const tried = new Set()
    let lastFailure = '所有账号在模型「' + model + '」上都已用尽或无可用权益'
    /**
     * 本轮编排里每个账号的失败计数（key = 账号 id）。
     *
     * ⚠ 0.9.9 韧性语义：统一选号下，**同一账号连续失败 2 次（无论错误类）就
     * 换下一个账号**。此前只有 quota/concurrency/captcha 会换号，`other`
     * （500、网络抖动、上游临时故障）与 `auth` 当场 throw —— 而宿主压缩
     * （compaction）的摘要是**一次性直调**（不走 agent-loop 重试瀑布，失败仅
     * warn 后继续主请求），同一坏账号会被压缩与主请求各撞一次，两次都不换号
     * ⇒ 整轮失败、对话被阻断（真实报障：压缩时额度恰好用完）。
     * 钉定模式不受影响：钉定本来就只有一个账号，失败如实报错。
     */
    const accountFailCounts = new Map()
    /**
     * 换轮原因（决定「选不到号」与最终报错的**错误码**与出路提示）：
     * `'quota'` 额度用尽 / `'concurrency'` 并发限流 3009 / `'timeout'` 上游黑洞（不出流）/
     * `'other'` 其它（500、凭据失效、网络抖动）。
     *
     * ⚠ 初值 `'none'`：以前是 `'quota'`，结果「一次都没换过轮就选不到号」
     * （池子空 / 账号已被额度前置检查挡掉）会被**误标**成 quota —— 文案与
     * 错误码都跟着错。初值必须表达「上一轮没发生过失败」。
     */
    let lastSwitchReason = 'none'
    /**
     * 统一选号下同一账号的失败容忍次数（无论错误类；见 accountFailCounts 注释）。
     * 2 = 同一账号撞两次就换下一个 —— 第一次可能是该账号的偶发问题，
     * 第二次还在它身上失败就不再给它机会（凭据类 401/1002 换号也无妨：
     * 下次轮到它时依旧失败，只是不再阻断其它账号）。
     */
    const PER_ACCOUNT_FAIL_MAX = 2
    /**
     * 最近一次**额度类**失败的上游原文（含业务码）。
     *
     * ⚠ 必须带到最终报错里：否则用户只看到笼统的「已用尽」，而真正的原因
     * （`1005 exceed quota limit` / `1113 余额不足` / `200 但零内容`）被吞掉，
     * 排查时会误以为是插件 bug。
     */
    let lastQuotaDetail = ''

    for (let quotaRound = 0; quotaRound < QUOTA_SWITCH_MAX; quotaRound += 1) {
      /**
       * 选号：钉定模式只看指定账号（选不到直接报错，见 `#pickPinned`）；
       * 自动模式按手动顺序取第一个可用账号，逐个试到有产出为止。
       *
       * `quotaExhausted` 收集「因为 last_error 已是额度用尽而被滤掉」的账号 ——
       * 只用于把「为什么选不到号」说清（issue #4），不改变选号语义。
       */
      const quotaSink = { exhausted: new Set() }
      const picked =
        pinned === null ? this.#pool.pick(model, tried, quotaSink) : this.#pickPinned(pinned.accountId, model)
      if (picked === null) {
        const detail = lastQuotaDetail.length > 0 ? `最后一次上游响应：${lastQuotaDetail}。` : ''
        /**
         * 区分三种「选不到号」的情况 —— 用户该做的事完全不同：
         *   ① 池子真的空       → 去登录
         *   ② 池子有号但本模型都限流 → 等重置 / 换模型 / 领额度
         *   ③ 本次请求已逐个试完 → 汇报试了几个
         * 统一报「账号池为空」会把人带去错误的排查方向（实测踩过）。
         */
        const total = this.#pool.list().length
        const enabledCount = this.#pool.list().filter((entry) => entry.enabled).length
        /**
         * issue #4：池子不空、却因为**已有 1005/1113 记录**被全部滤掉 ——
         * 必须走「额度已用尽」的明确文案 + QUOTA，绝不能落到「超时或不可用」。
         */
        const quotaBlocked = quotaSink.exhausted.size
        let message
        if (total === 0) {
          message = '账号池为空。请先运行 `zcode-start-plan login` 添加 ZCode 账号。'
        } else if (tried.size === 0 && quotaBlocked > 0 && quotaBlocked >= enabledCount) {
          message =
            `模型「${model}」在全部 ${enabledCount} 个启用账号上均已判额度用尽（上游 1005 exceed quota limit / 1113 余额不足），` +
            `本次请求未发出（已秒级快速失败）。免费额度按自然日 UTC+8 结算：` +
            `可等次日重置、用 \`zcode-start-plan claim\` 领取当日额度，或换一个模型（config.models）。`
        } else if (tried.size === 0) {
          if (enabledCount === 0) {
            message = `账号池里有 ${total} 个账号，但全部被停用。用 \`zcode-start-plan enable <序号>\` 启用，或登录新账号。`
          } else if (lastSwitchReason === 'concurrency') {
            message =
              `模型「${model}」的 ${enabledCount} 个启用账号当前都在并发限流中（3009，忙标记 60s 内自动过期）。` +
              `${detail}稍等片刻重试即可，无需等待额度重置。`
          } else {
            message = `模型「${model}」在 ${enabledCount} 个启用账号上都已限流（免费额度按自然日 UTC+8 结算）。` +
              `${detail}可等次日重置、换一个模型（config.models），或用 \`zcode-start-plan claim\` 领取当日额度。`
          }
        } else {
          const guidance = lastSwitchReason === 'concurrency'
            ? '并发限流是瞬态的，请稍后重试；或登录新账号。'
            : '免费额度按自然日结算，请等待重置、领取当日额度（node bin/cli.mjs claim）或用 `zcode-start-plan login` 添加新账号。'
          message = `${lastFailure}（本次已逐个尝试 ${tried.size} 个账号）。${detail}${guidance}`
        }
        const pickFailureCode = lastSwitchReason === 'concurrency'
          ? 'RATE_LIMIT'
          : lastSwitchReason === 'timeout'
            ? TIMEOUT_CODE
            : 'QUOTA'
        throw Object.assign(new Error(message), { code: pickFailureCode })
      }
      const accountId = picked.entry.id
      const credential = picked.credential
      /**
       * 钉定模式下额度耗尽：如实报错而不是换号 —— 换号会让「钉定」名存实亡
       * （用户选了「GLM-5.3 · 主号」就该知道失败意味着主号的额度尽了）。
       */
      const failPinnedQuota = (upstreamText) => {
        const detail = upstreamText.length > 0 ? `上游响应：${upstreamText}。` : ''
        throw Object.assign(
          new Error(
            `钉定的账号「${picked.entry.nickname}」在模型「${model}」上的额度已用尽（免费额度按自然日 UTC+8 结算）。` +
            `${detail}可等次日重置、在面板把其它账号置顶后改选，或改选不带账号后缀的自动选号条目。`,
          ),
          { code: 'QUOTA' },
        )
      }
      /**
       * 钉定模式吃零内容时的如实文案（1.0.1）：模型实际可用时，零内容大概率是
       * 瞬时异常 —— 报「额度已用尽」会把人带去错误的方向。这里给可操作的出路。
       */
      const failPinnedEmptyContent = (upstreamText) => {
        const isSecond = previousZeroContentMark !== undefined
        throw Object.assign(
          new Error(
            `钉定的账号「${picked.entry.nickname}」在模型「${model}」上返回了空响应（${upstreamText}）。` +
            (isSecond
              ? '短时间内连续两次，已按当日无权益处理：可等额度重置、在面板「清除限流」后重试，或改选自动选号条目换用其它账号。'
              : '这通常是一次瞬时异常（账号额度未必用尽）：稍等几分钟重试即可；若反复出现，可在面板「清除限流」后重试，或改选自动选号条目。'),
          ),
          { code: 'QUOTA' },
        )
      }
      const captchaKey = `${accountId}|${model}`
      let probeRejected = false
      let switched = false
      /**
       * 零内容两级证据（1.0.1）：进入这个账号前它是否已在零内容观察窗内。
       * 在 = 本次再吃零内容就是第二次 → 升级当日硬标记；不在 = 首次 → 只打观察窗。
       * 计数由 pool 持有（软优先，pick 第一档避开但不硬过滤）。
       */
      const wasWatched = this.#pool.isEmptyContentWatched?.(accountId, model) ?? false

      const supportsImages = request.model?.inputModalities?.includes?.('image') ?? true
      /**
       * 宿主契约：DSH 的 image 块是持久引用（`{ type: 'image', attachment: ref }`），
       * 字节须经附件服务 `readImageRequest` 解析（官方 `dsh-llm-deepseek` 同款链路）。
       * 附件服务不可用 / 解析失败时 `resolvedImages` 缺项，`convertContent` 用
       * 占位文本替换 —— 不再静默丢弃。
       */
      const resolvedImages = await resolveImages(options.messages, {
        resolveAttachments: this.#resolveDeps?.resolveAttachments,
        signal: request.signal,
      })

      const body = buildUpstreamBody({
        options,
        cwd: this.#cwd,
        provider: 'zcode-start-plan',
        supportsImages,
        resolvedImages,
        maxTokens: request.maxTokens,
      })

      for (let attempt = 0; ; attempt += 1) {
        if (request.signal?.aborted === true) {
          throw Object.assign(new Error('请求已取消'), { code: 'ABORTED' })
        }
        const knownRequired = (this.#captchaRequiredUntil.get(captchaKey) ?? 0) > this.#now()
        const needCaptcha = knownRequired || probeRejected
        let captcha
        if (needCaptcha) {
          try {
            captcha = await this.mintCaptcha(request.signal)
          } catch (error) {
            throw Object.assign(
              new Error(
                `captcha 产出失败：${error instanceof Error ? error.message : String(error)}。` +
                '需要宿主带调试端口启动：先彻底退出 DSH，再用 ' +
                `${launchCommand(9229)} 重新打开，` +
                '或把 config.captcha.mode 设为 "manual"。',
              ),
              { code: 'CAPTCHA_FAILED' },
            )
          }
        }

        const headers = buildZcodeHeaders(credential, {
          authorization: `Bearer ${credential.zcode_jwt}`,
          ...(captcha !== undefined ? { captcha: { param: captcha.param, region: captcha.region } } : {}),
        })

        let response
        /**
         * 实时路由记录（1.0.0 / 审计修复 1.0.1）：**紧贴真正发出去的这次调用**，
         * 且每次重试都覆盖 —— 放在账号轮次入口只能反映「打算用谁」，
         * 换号、同账号重试、钉定失败都会让它停在错误的人身上。
         */
        this.#pool.noteRouted?.(accountId, model, { outcome: 'attempting' })
        try {
          response = await this.#gate.run(model, () =>
            this.#fetchImpl(ZCODE_PLAN_MESSAGES_URL, {
              method: 'POST',
              headers,
              body: JSON.stringify(body),
              signal: request.signal,
            }),
          )
        } catch (error) {
          if (request.signal?.aborted === true) throw Object.assign(new Error('请求已取消'), { code: 'ABORTED' })
          /**
           * 网络层异常的分流（issue #4）：`AbortError` / `TimeoutError`（fetch 自行超时、
           * 宿主 signal 超时、连接被上游静默掐断）一律落 TIMEOUT —— 它在回退名单里，
           * 回退链路与用户文案都能给出「没拿到响应」，而不是笼统的 PROVIDER_ERROR。
           */
          const timedOut = error?.name === 'AbortError' || error?.name === 'TimeoutError'
          const networkError = Object.assign(
            new Error(
              timedOut
                ? `上游在 ${Math.round(this.#readTimeoutMs / 1000)}s 内没有返回任何响应（可能已被上游限流 / 不再出流）。`
                : `上游请求失败：${error instanceof Error ? error.message : String(error)}`,
            ),
            { code: timedOut ? TIMEOUT_CODE : 'PROVIDER_ERROR' },
          )
          if (pinned !== null) throw networkError
          const fails = (accountFailCounts.get(accountId) ?? 0) + 1
          accountFailCounts.set(accountId, fails)
          lastSwitchReason = timedOut ? 'timeout' : 'other'
          lastFailure = networkError.message.slice(0, 200)
          if (fails >= PER_ACCOUNT_FAIL_MAX) {
            this.#log(`[zcode] 账号 ${accountId} 连续 ${fails} 次第${timedOut ? '超时' : '网络失败'} → 换下一个账号`)
            tried.add(accountId)
            switched = true
            break
          }
          this.#log(`[zcode] 账号 ${accountId} ${timedOut ? '超时' : '网络失败'} ${fails}/${PER_ACCOUNT_FAIL_MAX}，同账号重试`)
          continue
        }

        if (!response.ok) {
          const text = await response.text().catch(() => '')
          const kind = classifyUpstreamError(response.status, text)
          this.#log(`[zcode] 账号 ${accountId} 上游 ${response.status}（${kind}）：${text.slice(0, 200)}`)

          if (kind === 'quota') {
            this.#pool.markModelRateLimited(accountId, model, nextUtc8DayStartMs(new Date(this.#now())))
            this.#pool.noteError(accountId, describeUpstreamError(response.status, text))
            /** 徽标要能说「这个号已耗尽」，而不是继续显示它像在服务。 */
            this.#pool.noteRouted?.(accountId, model, { outcome: 'exhausted', reason: '上游额度用尽' })
            if (pinned !== null) failPinnedQuota(text.slice(0, 200))
            tried.add(accountId)
            switched = true
            break
          }
          if (kind === 'concurrency') {
            const action = await this.#handleConcurrency({
              accountId,
              model,
              attempt,
              pinned,
              picked,
              status: response.status,
              text,
              onRetry: request.onRetry,
            })
            if (action === 'retry') continue
            if (action === 'switch') {
              tried.add(accountId)
              switched = true
              lastSwitchReason = 'concurrency'
              lastFailure = `模型「${model}」的可用账号都处于并发限流（3009）`
              break
            }
            throw action
          }
          if (kind === 'captcha' && attempt < 2) {
            if (captcha === undefined) {
              this.#captchaRequiredUntil.set(captchaKey, this.#now() + CAPTCHA_REQUIRED_TTL_MS)
              this.#log('[zcode] 上游要求 captcha（3007）→ 本轮才产出并重试')
            } else {
              this.#log('[zcode] captcha 被拒（3007），换新 param 重试')
            }
            probeRejected = true
            request.onRetry?.({ reason: 'captcha', attempt, message: describeUpstreamError(response.status, text) })
            continue
          }
          if (kind === 'risk') {
            throw Object.assign(new Error(describeUpstreamError(response.status, text)), { code: 'RATE_LIMIT' })
          }
          if (kind === 'auth') {
            this.#pool.noteError(accountId, describeUpstreamError(response.status, text))
          }
          /**
           * 统一选号的韧性兜底（0.9.9）：auth / other 不再当场 throw ——
           * 记失败计数，同账号连续 PER_ACCOUNT_FAIL_MAX 次失败就换下一个。
           * 宿主压缩摘要是一次性直调（不走重试瀑布），同一坏账号会被压缩与
           * 主请求各撞一次：此前两次都当场 throw，对话被直接阻断。
           * auth 换号合理（凭据失效不影响其它账号）；3012 风控已在上方
           * 绝不重试地抛出（连续触发有账号冷却惩罚）。
           */
          if (pinned !== null) {
            throw Object.assign(new Error(describeUpstreamError(response.status, text)), {
              code: kind === 'auth' ? 'AUTH' : 'PROVIDER_ERROR',
            })
          }
          const fails = (accountFailCounts.get(accountId) ?? 0) + 1
          accountFailCounts.set(accountId, fails)
          lastSwitchReason = 'other'
          lastFailure = describeUpstreamError(response.status, text).slice(0, 200)
          if (fails >= PER_ACCOUNT_FAIL_MAX) {
            this.#log(`[zcode] 账号 ${accountId} 连续 ${fails} 次失败（${kind}）→ 换下一个账号`)
            tried.add(accountId)
            switched = true
            break
          }
          this.#log(`[zcode] 账号 ${accountId} 失败 ${fails}/${PER_ACCOUNT_FAIL_MAX}（${kind}），同账号重试`)
          continue
        }

        if (response.body === null) {
          this.#log(`[zcode] 账号 ${accountId} 返回 200 但 body 为空 → 视为无权益，换号`)
          this.#pool.markModelRateLimited(accountId, model, nextUtc8DayStartMs(new Date(this.#now())))
          this.#pool.noteRouted?.(accountId, model, { outcome: 'exhausted', reason: 'HTTP 200 但响应体为空' })
          if (pinned !== null) failPinnedQuota('HTTP 200 但响应体为空')
          tried.add(accountId)
          switched = true
          break
        }
        const head = await readContentHead(response.body, {
          contentType: response.headers.get('content-type') ?? undefined,
          headTimeoutMs: this.#headTimeoutMs,
          timeoutMs: this.#readTimeoutMs,
        })
        /**
         * 🕳 **上游黑洞**（issue #4）：HTTP 200 拿到了响应头，但流里**一个事件都没出来**。
         * 额度用尽后本渠道就是这个形态，宿主侧只会在 ~300s × 重试次数后报「超时或不可用」。
         *
         * 处置顺序故意如此：
         * 1. 先记一次 TIMEOUT 级失败（账号级，不写 model_rate_limits —— 黑洞**不证明**额度用尽，
         *    上游抖动也是这个形态）；
         * 2. 同账号撞满 `PER_ACCOUNT_FAIL_MAX` 次才换号/报错 —— 也就是最多等 `2 × headTimeoutMs`
         *    （默认 180s，仍小于宿主一次 ~300s 超时）；
         * 3. 钉定模式如实报 TIMEOUT（不换号，钉定只有一个号）。
         */
        if (head.timeoutError !== undefined) {
          const detail = isHeadTimeoutError(head.timeoutError)
            ? `上游在 ${Math.round(this.#headTimeoutMs / 1000)}s 内没有产出任何内容`
            : `读取上游响应中断（${head.timeoutError?.message ?? '未知原因'}）`
          this.#log(`[zcode] 账号 ${accountId} 黑洞：${detail}（已等 ${head.elapsedMs}ms）`)
          this.#pool.noteRouted?.(accountId, model, { outcome: 'attempting', reason: detail })
          /**
           * ⚠ 刻意**不写** `noteError`：`last_error` 是「最近一次失败原因」面板字段。
           * 黑洞的成因未定（额度用尽 / 上游抖动都是这个形态），写进去只会让面板
           * 说一个未经证实的结论；真因由下方 `lastFailure` 与日志给出。
           */
          const failure = Object.assign(
            new Error(
              `${detail}。这通常意味着该账号在该模型上已无可用的出流（额度用尽）或上游临时故障：` +
              `可稍后重试、换一个模型，或 \`zcode-start-plan claim\` 领取当日额度。`,
            ),
            { code: TIMEOUT_CODE },
          )
          if (pinned !== null) throw failure
          const fails = (accountFailCounts.get(accountId) ?? 0) + 1
          accountFailCounts.set(accountId, fails)
          lastSwitchReason = 'timeout'
          lastFailure = failure.message.slice(0, 200)
          if (fails >= PER_ACCOUNT_FAIL_MAX) {
            this.#log(`[zcode] 账号 ${accountId} 连续 ${fails} 次黑洞 → 换下一个账号`)
            tried.add(accountId)
            switched = true
            break
          }
          this.#log(`[zcode] 账号 ${accountId} 黑洞 ${fails}/${PER_ACCOUNT_FAIL_MAX}，同账号重试`)
          continue
        }
        /**
         * ⚠ **HTTP 200 里的业务错误**：本渠道实测会返回
         * `200 + application/json + {"code":1005,"msg":"exceed quota limit"}`。
         * 必须先按错误表处置（该换号就换号、该报错就报错），否则会被当成
         * 「零内容 → 无权益」，既丢掉真正的原因，也无法据此做正确决策。
         */
        if (head.upstreamError !== undefined) {
          const text = head.upstreamError.text
          const kind = classifyUpstreamError(200, text)
          this.#log(`[zcode] 账号 ${accountId} 在 HTTP 200 里返回业务错误（${kind}）：${text.slice(0, 200)}`)

          if (kind === 'quota') {
            lastQuotaDetail = text.slice(0, 200)
            this.#pool.markModelRateLimited(accountId, model, nextUtc8DayStartMs(new Date(this.#now())))
            this.#pool.noteError(accountId, describeUpstreamError(200, text))
            this.#pool.noteRouted?.(accountId, model, { outcome: 'exhausted', reason: '上游额度用尽（HTTP 200 包裹）' })
            if (pinned !== null) failPinnedQuota(text.slice(0, 200))
            tried.add(accountId)
            switched = true
            break
          }
          if (kind === 'concurrency') {
            const action = await this.#handleConcurrency({
              accountId,
              model,
              attempt,
              pinned,
              picked,
              status: 200,
              text,
              onRetry: request.onRetry,
              fromHttp200: true,
            })
            if (action === 'retry') continue
            if (action === 'switch') {
              tried.add(accountId)
              switched = true
              lastSwitchReason = 'concurrency'
              lastFailure = `模型「${model}」的可用账号都处于并发限流（3009）`
              break
            }
            throw action
          }
          if (kind === 'captcha' && attempt < 2) {
            if (captcha === undefined) this.#captchaRequiredUntil.set(captchaKey, this.#now() + CAPTCHA_REQUIRED_TTL_MS)
            probeRejected = true
            request.onRetry?.({ reason: 'captcha', attempt, message: describeUpstreamError(200, text) })
            continue
          }
          /** HTTP 200 包裹的风控：同样绝不重试（账号冷却惩罚）。 */
          if (kind === 'risk') {
            throw Object.assign(new Error(describeUpstreamError(200, text)), { code: 'RATE_LIMIT' })
          }
          /**
           * 统一选号的韧性兜底（0.9.9，与非 200 路径同口径）：auth / other
           * 计失败数，同账号连续 PER_ACCOUNT_FAIL_MAX 次失败换下一个，
           * 不再当场 throw（宿主压缩摘要一次性直调，两次 throw = 对话阻断）。
           */
          this.#pool.noteError(accountId, describeUpstreamError(200, text))
          if (pinned !== null) {
            throw Object.assign(new Error(describeUpstreamError(200, text)), {
              code: kind === 'auth' ? 'AUTH' : 'PROVIDER_ERROR',
            })
          }
          const fails = (accountFailCounts.get(accountId) ?? 0) + 1
          accountFailCounts.set(accountId, fails)
          lastSwitchReason = 'other'
          lastFailure = describeUpstreamError(200, text).slice(0, 200)
          if (fails >= PER_ACCOUNT_FAIL_MAX) {
            this.#log(`[zcode] 账号 ${accountId} 连续 ${fails} 次失败（${kind}，HTTP 200）→ 换下一个账号`)
            tried.add(accountId)
            switched = true
            break
          }
          this.#log(`[zcode] 账号 ${accountId} 失败 ${fails}/${PER_ACCOUNT_FAIL_MAX}（${kind}，HTTP 200），同账号重试`)
          continue
        }

        if (!head.hasContent) {
          /**
           * ⚠ 「模型实际在 ZCode 可用，对话却报额度耗尽」的根因修复（1.0.1）：
           *
           * 零内容是多义的 —— 真无权益，**或**上游瞬时异常（抖动 / captcha
           * 边缘情况）。此前首次零内容就把账号×模型标限流到**次日零点**
           * （落库），一次抖动 = 一整天不可用，且面板余额与对话结论永远矛盾。
           *
           * 两级证据：首次 → 只打观察窗（pool 软优先，10 分钟自动过期）；
           * 窗口内同一账号×模型再吃一次零内容 → 才升级为当日硬标记。
           * 无论哪一级，本次请求都换号（拿到的是坏响应，交给别的账号是安全的）。
           */
          const escalate = wasWatched
          if (escalate) {
            this.#log(`[zcode] 账号 ${accountId} 在模型 ${model} 上观察窗内第二次零内容 → 升级为当日标记`)
            this.#pool.clearEmptyContentWatch?.(accountId, model)
            this.#pool.markModelRateLimited(accountId, model, nextUtc8DayStartMs(new Date(this.#now())))
          } else {
            this.#log(
              `[zcode] 账号 ${accountId} 在模型 ${model} 上返回 200 但零内容（${head.elapsedMs}ms）→ 观察窗 ${EMPTY_CONTENT_WINDOW_MS / 1000}s（软优先），本次换号`,
            )
            this.#pool.noteEmptyContentWatch?.(accountId, model, this.#now() + EMPTY_CONTENT_WINDOW_MS)
          }
          this.#pool.noteError(accountId, `200 但零内容（${head.elapsedMs}ms${escalate ? '，观察窗内第二次 → 当日' : '，观察窗'}）`)
          this.#pool.noteRouted?.(accountId, model, {
            outcome: escalate ? 'exhausted' : 'attempting',
            reason: escalate ? '观察窗内连续两次零内容' : 'HTTP 200 但零内容（首次，观察窗）',
          })
          if (pinned !== null) failPinnedEmptyContent(`HTTP 200 但零内容（${head.elapsedMs}ms）`)
          tried.add(accountId)
          switched = true
          break
        }

        /** 有产出 = 账号×模型健康，清掉观察窗。 */
        this.#pool.clearEmptyContentWatch?.(accountId, model)

        if (captcha === undefined) {
          /** 没带 captcha 就成功 ⇒ 上游当前不要验证，清掉记忆回到最省路径。 */
          this.#captchaRequiredUntil.delete(captchaKey)
        }
        /** 命中即清忙标记：退避期间账号已空闲，别让后续请求白白绕开它。 */
        this.#pool.clearModelBusy?.(accountId, model)
        /** 真实命中的账号 = 徽标该显示的人（覆盖之前所有 attempt 记录）。 */
        this.#pool.noteRouted?.(accountId, model, { outcome: 'ok' })
        this.#log(
          `[zcode] ${accountId} × ${model} 命中（首帧 ${head.elapsedMs}ms，${captcha === undefined ? '未带 captcha' : '带 captcha'}）`,
        )
        return { head: head.head, decoder: head.decoder, accountId, model, credential, body }
      }

      if (!switched) throw Object.assign(new Error('请求编排内部状态异常：内层循环意外退出'), { code: 'PROVIDER_ERROR' })
      /**
       * 换轮时的失败文案：
       * - 3009 换轮保留并发限流文案（上方按 lastSwitchReason 已写好）；
       * - 0.9.9 起 `other` / auth / **timeout** 换轮保留真实上游错误（lastFailure 已在
       *   失败处写好）——覆盖成泛化的「已用尽」会把凭据失效 / 上游 500 / 黑洞
       *   这类真正原因抹掉，用户会被带去「等额度重置」的错误排查方向；
       * - 只有 quota 换轮（原因就是额度）才换成「已用尽」的标准文案。
       */
      if (lastSwitchReason === 'quota') {
        lastFailure = `模型「${model}」的可用账号已用尽`
      }
    }

    /**
     * 终态错误码（issue #4）：**保真**，不再一律落 QUOTA。
     *
     * - `concurrency` → RATE_LIMIT（稍后重试即可）
     * - `timeout`     → TIMEOUT（上游黑洞 / 不出流；在回退名单里，宿主可改道）
     * - 其余          → QUOTA（额度用尽是确定性的）
     *
     * 错误码直接决定宿主的重试策略与回退判定，混用会把用户带去错误的排查方向。
     */
    const exhaustedCode = lastSwitchReason === 'concurrency'
      ? 'RATE_LIMIT'
      : lastSwitchReason === 'timeout'
        ? TIMEOUT_CODE
        : 'QUOTA'
    throw Object.assign(new Error(`${lastFailure}（已尝试 ${tried.size} 个账号，上限 ${QUOTA_SWITCH_MAX}）。`), { code: exhaustedCode })
  }
}

/** 兜底模型表（面板/工具在拉不到上游目录时用）。 */
export { ZCODE_FALLBACK_MODELS }
