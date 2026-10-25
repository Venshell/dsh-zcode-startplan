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
 *        ├─ 并发限流 → 退避重试（不换号）
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
  CONCURRENCY_RETRY_MAX,
  QUOTA_SWITCH_MAX,
  classifyUpstreamError,
  concurrencyRetryDelayMs,
  describeUpstreamError,
} from './errors.js'
import { readContentHead } from './sse.js'
import { buildZcodeHeaders, ZCODE_PLAN_MESSAGES_URL, ZCODE_FALLBACK_MODELS, nextUtc8DayStartMs } from './upstream.js'
import { ZCODE_CAPTCHA_FALLBACK } from './captcha/sdk-page.js'
import { parsePinnedModelId } from './pinned-model.js'
import { isUsableCredential } from './pool.js'

/** 「该账号×模型当前需要 captcha」的记忆时长（避免每条消息都白吃一次 3007）。 */
const CAPTCHA_REQUIRED_TTL_MS = 2 * 60_000

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
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
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

  constructor(options) {
    this.#pool = options.pool
    this.#minter = options.minter
    this.#fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.#log = options.log ?? (() => {})
    this.#now = options.now ?? (() => Date.now())
    this.#cwd = options.cwd ?? process.cwd()
    this.#captchaConfig = options.captchaConfig
    this.#resolveDeps = options
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
    if (!isUsableCredential(entry.credential)) {
      throw Object.assign(
        new Error(`钉定的账号「${entry.nickname}」凭据不可用，请重新登录。`),
        { code: 'AUTH' },
      )
    }
    return { entry, credential: entry.credential }
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
       */
      const picked = pinned === null ? this.#pool.pick(model, tried) : this.#pickPinned(pinned.accountId, model)
      if (picked === null) {
        const detail = lastQuotaDetail.length > 0 ? `最后一次上游响应：${lastQuotaDetail}。` : ''
        /**
         * 区分三种「选不到号」的情况 —— 用户该做的事完全不同：
         *   ① 池子真的空       → 去登录
         *   ② 池子有号但本模型都限流 → 等重置 / 换模型 / 领额度
         *   ③ 本次请求已逐个试完 → 汇报试了几个
         * 统一报「账号池为空」会把人带去错误的排查方向（实测踩过）。
         */
        const total = this.#pool.list()
        const enabledCount = total.filter((entry) => entry.enabled).length
        let message
        if (total.length === 0) {
          message = '账号池为空。请先运行 `zcode-start-plan login` 添加 ZCode 账号。'
        } else if (tried.size === 0) {
          message = enabledCount === 0
            ? `账号池里有 ${total.length} 个账号，但全部被停用。用 \`zcode-start-plan enable <序号>\` 启用，或登录新账号。`
            : `模型「${model}」在 ${enabledCount} 个启用账号上都已限流（免费额度按自然日 UTC+8 结算）。` +
              `${detail}可等次日重置、换一个模型（config.models），或用 \`zcode-start-plan claim\` 领取当日额度。`
        } else {
          message = `${lastFailure}（本次已逐个尝试 ${tried.size} 个账号）。${detail}` +
            '免费额度按自然日结算，请等待重置、领取当日额度（node bin/cli.mjs claim）或用 `zcode-start-plan login` 添加新账号。'
        }
        throw Object.assign(new Error(message), { code: 'QUOTA' })
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
      const captchaKey = `${accountId}|${model}`
      let probeRejected = false
      let switched = false

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
                '请以 --remote-debugging-port 启动宿主（DSH 桌面端），或把 config.captcha.mode 设为 "manual"。',
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
          throw Object.assign(new Error(`上游请求失败：${error instanceof Error ? error.message : String(error)}`), {
            code: 'PROVIDER_ERROR',
          })
        }

        if (!response.ok) {
          const text = await response.text().catch(() => '')
          const kind = classifyUpstreamError(response.status, text)
          this.#log(`[zcode] 账号 ${accountId} 上游 ${response.status}（${kind}）：${text.slice(0, 200)}`)

          if (kind === 'quota') {
            this.#pool.markModelRateLimited(accountId, model, nextUtc8DayStartMs(new Date(this.#now())))
            this.#pool.noteError(accountId, describeUpstreamError(response.status, text))
            if (pinned !== null) failPinnedQuota(text.slice(0, 200))
            tried.add(accountId)
            switched = true
            break
          }
          if (kind === 'concurrency' && attempt < CONCURRENCY_RETRY_MAX) {
            const waitMs = concurrencyRetryDelayMs(attempt)
            this.#log(`[zcode] 并发限流（3009），退避 ${waitMs}ms 后重试（不换号）`)
            request.onRetry?.({ reason: 'concurrency', attempt, message: describeUpstreamError(response.status, text) })
            await sleep(waitMs)
            continue
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
            throw Object.assign(new Error(describeUpstreamError(response.status, text)), { code: 'AUTH' })
          }
          throw Object.assign(new Error(describeUpstreamError(response.status, text)), { code: 'PROVIDER_ERROR' })
        }

        if (response.body === null) {
          this.#log(`[zcode] 账号 ${accountId} 返回 200 但 body 为空 → 视为无权益，换号`)
          this.#pool.markModelRateLimited(accountId, model, nextUtc8DayStartMs(new Date(this.#now())))
          if (pinned !== null) failPinnedQuota('HTTP 200 但响应体为空')
          tried.add(accountId)
          switched = true
          break
        }

        const head = await readContentHead(response.body, {
          contentType: response.headers.get('content-type') ?? undefined,
        })
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
            if (pinned !== null) failPinnedQuota(text.slice(0, 200))
            tried.add(accountId)
            switched = true
            break
          }
          if (kind === 'concurrency' && attempt < CONCURRENCY_RETRY_MAX) {
            const waitMs = concurrencyRetryDelayMs(attempt)
            this.#log(`[zcode] 并发限流（3009，HTTP 200），退避 ${waitMs}ms 后重试（不换号）`)
            request.onRetry?.({ reason: 'concurrency', attempt, message: describeUpstreamError(200, text) })
            await sleep(waitMs)
            continue
          }
          if (kind === 'captcha' && attempt < 2) {
            if (captcha === undefined) this.#captchaRequiredUntil.set(captchaKey, this.#now() + CAPTCHA_REQUIRED_TTL_MS)
            probeRejected = true
            request.onRetry?.({ reason: 'captcha', attempt, message: describeUpstreamError(200, text) })
            continue
          }
          /** 风控 / 鉴权 / 其它：如实报错，不重试。 */
          const code = kind === 'risk' ? 'RATE_LIMIT' : kind === 'auth' ? 'AUTH' : 'PROVIDER_ERROR'
          this.#pool.noteError(accountId, describeUpstreamError(200, text))
          throw Object.assign(new Error(describeUpstreamError(200, text)), { code })
        }

        if (!head.hasContent) {
          this.#log(`[zcode] 账号 ${accountId} 在模型 ${model} 上返回 200 但零内容（${head.elapsedMs}ms）→ 视为无权益，换号`)
          this.#pool.markModelRateLimited(accountId, model, nextUtc8DayStartMs(new Date(this.#now())))
          this.#pool.noteError(accountId, `200 但零内容（${head.elapsedMs}ms）`)
          if (pinned !== null) failPinnedQuota(`HTTP 200 但零内容（${head.elapsedMs}ms）`)
          tried.add(accountId)
          switched = true
          break
        }

        if (captcha === undefined) {
          /** 没带 captcha 就成功 ⇒ 上游当前不要验证，清掉记忆回到最省路径。 */
          this.#captchaRequiredUntil.delete(captchaKey)
        }
        this.#log(
          `[zcode] ${accountId} × ${model} 命中（首帧 ${head.elapsedMs}ms，${captcha === undefined ? '未带 captcha' : '带 captcha'}）`,
        )
        return { head: head.head, decoder: head.decoder, accountId, model, credential, body }
      }

      if (!switched) throw Object.assign(new Error('请求编排内部状态异常：内层循环意外退出'), { code: 'PROVIDER_ERROR' })
      lastFailure = `模型「${model}」的可用账号已用尽`
    }

    throw Object.assign(new Error(`${lastFailure}（已尝试 ${tried.size} 个账号，上限 ${QUOTA_SWITCH_MAX}）。`), { code: 'QUOTA' })
  }
}

/** 兜底模型表（面板/工具在拉不到上游目录时用）。 */
export { ZCODE_FALLBACK_MODELS }
