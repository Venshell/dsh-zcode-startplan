/**
 * 账号池管理路由（供 Web UI 的 Client 半段调用）。
 *
 * ## 契约（照抄 @linxin666/dsh-client-ui-plugin-manager 的实证写法）
 *
 * - `inject: ['webServer']` → `ctx.webServer.register(route)` 逐条注册，返回 disposer；
 * - route 形状：`{ kind: 'exact', path, handler(req, res) }`；
 * - **loopback 防护**：仅允许本机回环地址访问（socket 与 Host 头都校验）；
 * - JSON 读写：请求体有上限，响应统一 `content-type: application/json`。
 *
 * ## 安全边界
 *
 * 这些路由能改账号池，因此：
 * 1. 只监听回环（webServer 本身就只在本地）+ 请求级 loopback 判定；
 * 2. **任何响应都不含凭据**（zcode_jwt / device_mid / token 一律不出网关）；
 *    设备授权流的 `flowSecret` 同样只留在 Host 内存（见 `/login/start`）；
 * 3. 写操作（enable/disable/remove/reset/reorder/rename/login）逐条校验参数形状。
 */

import { isIP } from 'node:net'
import {
  startZcodeLogin,
  pollZcodeLogin,
  normalizeLoginChannel,
  fetchClaimablePlans,
  fetchClaimedPlans,
  fetchClaimedPlanIds,
  claimPlan,
  reportActivation,
  reportMarketingAction,
} from './upstream-api.js'
import { generateDeviceMid, ZCODE_APP_VERSION_FALLBACK } from './upstream.js'

/** 路由前缀（Client 半段用同一常量拼 URL）。 */
export const MANAGE_PREFIX = '/api/zcode-start-plan'

/** 登录流寿命（上游 `expires_at` 语义：10 分钟）。 */
const LOGIN_FLOW_TTL_MS = 10 * 60_000
/** 同时挂起的登录流上限（防 Map 无限膨胀；超限驱逐最旧）。 */
const LOGIN_FLOW_MAX = 8

/**
 * 判断一个 IP 字面量是否回环地址。
 * ⚠ 不用 `node:net` 的 `isLoopbackAddress`：Node 22 没有该导出，静态 import
 * 加载即崩（engines 允许 `^22.19 || >=24`，必须兼容）；用 `isIP` 自己判。
 */
function isLoopbackAddress(value) {
  const text = String(value ?? '').trim()
  const kind = isIP(text)
  if (kind === 4) return text.startsWith('127.')
  if (kind === 6) {
    const lower = text.toLowerCase()
    return lower === '::1' || lower === '::ffff:127.0.0.1'
  }
  return false
}

/** 简化的回环判定（socket 地址 + Host 头，镜像 plugin-manager 的栅栏思路）。 */
function isLoopbackRequest(req) {
  const remote = req.socket?.remoteAddress ?? ''
  if (!isLoopbackAddress(remote)) return false
  const hostHeader = String(req.headers?.host ?? '')
  const hostname = hostHeader.startsWith('[')
    ? hostHeader.slice(1, hostHeader.indexOf(']'))
    : hostHeader.split(':')[0] ?? ''
  if (hostname.length === 0) return true
  if (hostname === 'localhost') return true
  return isLoopbackAddress(hostname)
}

/** 写一个 JSON 响应。 */
function writeJson(res, status, body) {
  if (res.writableEnded || res.destroyed) return
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  })
  res.end(text)
}

/** 读请求体（有上限），解析为对象；失败返回 null。 */
function readJsonBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        finish(null)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.length === 0) return finish(null)
      try {
        const parsed = JSON.parse(text)
        finish(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null)
      } catch {
        finish(null)
      }
    })
    req.on('error', () => finish(null))
  })
}

/** 把错误翻成字符串（不暴露堆栈给页面）。 */
const messageOf = (error) => (error instanceof Error ? error.message : String(error))

/**
 * 账号的脱敏视图：绝不包含凭据字段。
 *
 * `riskBlocked`（1.0.2）：该账号曾触发 3012 风控 —— 面板在**模型栏那一行**画一条
 * 橙黄 chip（「⚠ 曾触发风控 · 点清除限流恢复」）。放在这里而不是只放 `/routing`：
 * 账号卡片吃的是 `/summary`，`/routing` 只喂模型栏徽标，两处都要。
 */
function publicAccount(entry, index) {
  return {
    index: index + 1,
    id: entry.id,
    nickname: entry.nickname,
    enabled: entry.enabled === true,
    userIdTail: typeof entry.user_id === 'string' && entry.user_id.length > 0 ? entry.user_id.slice(-6) : null,
    channel: entry.credential?.login_channel ?? null,
    addedAt: typeof entry.added_at === 'number' ? entry.added_at : null,
    modelRateLimits: entry.model_rate_limits ?? {},
    lastError: entry.last_error ?? null,
    riskBlocked: riskBlockedOfEntry(entry),
  }
}

/**
 * 风控痕迹判据（`/summary` 与 `/routing` 共用的唯一实现）。
 *
 * ⚠ 判据只有 `last_error` 文本：池子里没有结构化的风控时间戳字段，1.0.2 也**不加**
 * 表结构（加列要迁移，而这条信息本来就是「历史痕迹」而非准入判据 ——
 * `pool.pick` 明确不看 `last_error`，见 pool.js 的「不是选号判据」注释）。
 *
 * 为什么要留在面板上：3012 的惩罚是**账号级冷却**（30 分钟 → 24 小时 → 停用），
 * 用户看不到任何提示就会反复重试，等于自己把冷却攒满。给出
 * 「该账号曾触发风控」+「点清除限流恢复」就够了，不参与取号。
 *
 * 文案来源：`describeUpstreamError`（lib/errors.js，含 "unusual activity"）或
 * 3012 的裸响应 / 拆词后的中文文案。三个判据取或，任一命中即为真。
 */
export function riskBlockedOfEntry(entry) {
  const text = typeof entry?.last_error === 'string' ? entry.last_error : ''
  if (text.length === 0) return false
  return /unusual\s+activity/i.test(text) || /3012/.test(text) || /风控/.test(text)
}

/**
 * 构造管理路由。
 *
 * @param {{
 *   pool: import('./pool.js').AccountPool,
 *   fetchBalance?: (credential: any) => Promise<any>,
 *   client?: { mintCaptcha?: () => Promise<{ param: string, region: string }> },
 *   probeCaptcha?: () => Promise<{ mode?: string, debugPort?: number, reachable: boolean, reason?: string }>,
 *   log?: (message: string) => void,
 *   onChanged?: () => void,
 *   onSetUnifiedVisible?: (visible: boolean) => void,
 *   onSetAccountVisible?: (accountId: string, visible: boolean) => void,
 *   getAutoClaimEnabled?: () => boolean,
 *   getAutoClaimStats?: () => Record<string, any>,
 *   onSetAutoClaim?: (enabled: boolean) => void,
 *   // 拨开自动领取后立即跑一轮（不 await）；assemble 注入。
 *   runAutoClaim?: () => Promise<any>,
 *   settings?: { unifiedModelList?: boolean, hiddenModelLists?: string[], autoClaim?: boolean },
 * }} deps
 * @returns {Array<{ kind: 'exact', path: string, handler: (req: any, res: any) => Promise<void> }>}
 */
export function makeManageRoutes(deps) {
  const pool = deps.pool
  const fetchBalance = deps.fetchBalance
  const log = deps.log ?? (() => {})
  /**
   * 额度占比缓存（1.0.1）：accountId → `{ usedRatio, fetchedAt }`。
   *
   * `/routing` 必须**立即返回**（它是模型栏旁徽标的数据源，2s 轮询一次），
   * 而上游余额拉取单账号可能等 30s —— 绝不能同步等。所以：
   * 请求时只读缓存；缓存过期的账号在**后台**异步刷新，下一次轮询自然看到新值。
   * 进程内状态，不落库（余额是上游现值，落库只会引入过期快照）。
   */
  const balanceCache = new Map()
  /** 单个账号缓存多久算新鲜（与面板手动刷新的心理预期一致）。 */
  const BALANCE_TTL_MS = 60_000
  /**
   * 失败后的退避（审计修复 1.0.1）：失败条目不参与「本轮是否过期」的判断，
   * 否则失败一次会立刻过期、2s 轮询每轮又重试一次，把上游打爆。
   */
  const BALANCE_FAIL_TTL_MS = 300_000
  /** 缓存条数上限：账号被删除/频繁重登时不让 Map 无限长。 */
  const BALANCE_CACHE_MAX = 64
  /** 同一账号同时只允许一个后台拉取（2s 轮询会把上游打爆）。 */
  const balanceInFlight = new Set()

  /** 后台刷新某账号的额度占比；失败按退避记录（下个失败 TTL 再试）。 */
  const refreshBalanceInBackground = (entry) => {
    if (typeof fetchBalance !== 'function') return
    if (balanceInFlight.has(entry.id)) return
    balanceInFlight.add(entry.id)
    Promise.resolve()
      .then(() => fetchBalance(entry.credential))
      .then((balance) => {
        /**
         * ⚠ 上游返回 `undefined` = **拿不到余额**（401/网络/非 JSON），不是「用光了」。
         * 审计修复（1.0.1）：此前它落进成功分支，被算成 `available:false` ——
         * 与「已用尽」不可区分，徽标会把一个健康账号标成没额度。
         * 必须与 `catch` 走同一条「未知 + 退避」路径。
         */
        if (balance === undefined) throw new Error('balance unavailable')
        /**
         * 企业版 / 拉不到余额：占比未知（`null` = 不画进度，**不是** 100%）。
         * 同时把「当前生效桶」的到期时间与可用性一并缓存 —— 这是面板
         * 「额度开启」与对话「额度耗尽」不一致时唯一的对话依据。
         */
        const remaining = typeof balance?.remaining === 'number' ? balance.remaining : null
        const total = typeof balance?.total === 'number' ? balance.total : null
        const usedRatio =
          remaining !== null && total !== null && total > 0
            ? Math.min(1, Math.max(0, (total - remaining) / total))
            : null
        /**
         * ⚠ 只认**还有余额**的桶（upstream-api 已把 active 桶排在前面，
         * 且顶层 `expiresAt` 取的是第一个 active 桶）—— 0 余额的旧桶不能
         * 让徽标看起来「还有额度」。企业版不下发数字，`available` 记 `null`
         * （未知），不能记成 false。
         */
        const enterprise = balance?.enterprise === true
        const quotaAvailable = enterprise ? null : remaining !== null && remaining > 0
        balanceCache.set(entry.id, {
          usedRatio,
          available: quotaAvailable,
          expiresAt: Number.isFinite(balance?.expiresAt) ? balance.expiresAt : null,
          fetchedAt: Date.now(),
        })
        /** 顺带回填到期缓存：统一选号「快过期先用」要靠它。 */
        pool.noteExpiry?.(entry.id, balance?.expiresAt ?? 0)
        trimBalanceCache()
      })
      .catch(() => {
        /** 失败也记一笔（带退避 TTL），避免每 2s 反复重试把上游打爆。 */
        balanceCache.set(entry.id, { usedRatio: null, available: null, failedAt: Date.now() })
        trimBalanceCache()
      })
      .finally(() => {
        balanceInFlight.delete(entry.id)
      })
  }

  /** 丢弃已不在池中的账号缓存，并按访问顺序截断到上限。 */
  const trimBalanceCache = () => {
    const live = new Set((pool.list?.() ?? []).map((entry) => entry.id))
    for (const id of balanceCache.keys()) {
      if (!live.has(id)) balanceCache.delete(id)
    }
    while (balanceCache.size > BALANCE_CACHE_MAX) {
      const oldest = balanceCache.keys().next().value
      if (oldest === undefined) break
      balanceCache.delete(oldest)
    }
  }

  /** 命中且新鲜就直接给，否则触发后台刷新并给旧值。 */
  const quotaCacheOf = (entry) => {
    /** 防御：preview 可能指向一个刚被删掉的账号，拿不到 entry 就不刷新。 */
    if (typeof entry?.id !== 'string' || entry.id.length === 0) return undefined
    const cached = balanceCache.get(entry.id)
    const ttl = cached?.failedAt !== undefined ? BALANCE_FAIL_TTL_MS : BALANCE_TTL_MS
    const stale = cached === undefined || Date.now() - (cached.fetchedAt ?? cached.failedAt ?? 0) > ttl
    if (stale) refreshBalanceInBackground(entry)
    return cached
  }

  /** 取某账号的额度占比（0..1 已用；null = 未知）。 */
  const quotaRatioOf = (entry) => quotaCacheOf(entry)?.usedRatio ?? null

  /**
   * 该账号是否**曾经**触发上游风控（3012 unusual activity）。
   * 判据与实现见模块级 `riskBlockedOfEntry`（与 `/summary` 共用同一套，
   * 避免两处口径漂移：徽标说「有」而卡片说「没有」）。
   */
  const riskBlockedOf = riskBlockedOfEntry
  /**
   * 池子变更后的通知：账号栏位的路由集合随启用账号增删而变 —— 通知
   * assemble 用 `handle.replace()` 原子换路由（内部自动广播
   * `llm/adapters-updated`，模型选择器随即重拉目录）。
   */
  const notifyChanged = () => {
    try {
      deps.onChanged?.()
    } catch {
      // 通知失败不影响管理操作本身。
    }
  }

  /** 「统一选号」栏位开关（POST /unified-list）。 */
  const unifiedListHandler = async (req, res) => {
    const body = (await readJsonBody(req)) ?? {}
    if (typeof body.visible !== 'boolean') {
      writeJson(res, 400, { ok: false, error: '需要 visible（布尔）' })
      return
    }
    try {
      deps.onSetUnifiedVisible?.(body.visible)
    } catch (error) {
      writeJson(res, 500, { ok: false, error: messageOf(error) })
      return
    }
    writeJson(res, 200, { ok: true, visible: body.visible })
  }

  /**
   * 自动领取开关（POST /auto-claim {enabled}）。
   *
   * **探测永远自动**（`/claimable` 是 GET、零 captcha）；领取花掉活动资格 +
   * 一次设备 captcha，所以做成显式开关。状态由 assemble 持久化到 settings.json，
   * 重启后保持。
   */
  const autoClaimHandler = async (req, res) => {
    const body = (await readJsonBody(req)) ?? {}
    if (typeof body.enabled !== 'boolean') {
      writeJson(res, 400, { ok: false, error: '需要 enabled（布尔）' })
      return
    }
    if (typeof deps.onSetAutoClaim !== 'function') {
      writeJson(res, 501, { ok: false, error: '当前宿主不支持自动领取开关' })
      return
    }
    try {
      const enabled = deps.onSetAutoClaim(body.enabled) !== false
      /**
       * 拨开后**立即跑一轮**（不等 1 分钟心跳、更不等满间隔）。
       *
       * 旧实现只改标志位：`ctx.timer.interval` 的首轮要等一个完整周期（默认 6 小时），
       * 用户拨开开关后 `lastRunAt` 一直是 0，看起来「自动领取无作用」。
       * 这里同步触发一次（不 await，避免面板请求被 captcha 拖住）；
       * 结果通过 `/summary` 的 `autoClaim.lastRunAt` 反映出来。
       */
      if (enabled === true && typeof deps.runAutoClaim === 'function') {
        Promise.resolve()
          .then(() => deps.runAutoClaim())
          .catch((error) => log(`[manage] 自动领取首轮失败：${messageOf(error)}`))
      }
      writeJson(res, 200, { ok: true, enabled })
    } catch (error) {
      writeJson(res, 500, { ok: false, error: messageOf(error) })
    }
  }

  /** 单个账号「模型栏位」开关（POST /model-list-visible，每卡片右侧的开关）。 */  const modelListVisibleHandler = async (req, res) => {
    const body = (await readJsonBody(req)) ?? {}
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    if (id.length === 0 || typeof body.visible !== 'boolean') {
      writeJson(res, 400, { ok: false, error: '需要 id（字符串）与 visible（布尔）' })
      return
    }
    if (!pool.list().some((entry) => entry.id === id)) {
      writeJson(res, 404, { ok: false, error: `账号不存在：${id}` })
      return
    }
    try {
      deps.onSetAccountVisible?.(id, body.visible)
    } catch (error) {
      writeJson(res, 500, { ok: false, error: messageOf(error) })
      return
    }
    writeJson(res, 200, { ok: true, id, visible: body.visible })
  }

  // ── 登录流（两段式设备授权：Client 拿 URL → 浏览器授权 → Client 轮询）──
  //
  // ⚠ `flowSecret` 是本轮授权会话的密钥，**必须留在 Host 内存**（和 CLI 的
  // `beginZcodeLogin` 一样），绝不随 /login/start 响应下发 —— 下发它等于把
  // 「完成别人授权」的能力交给页面里任意脚本。
  // 流程：Client 先 POST /login/start {channel} 拿 authorizeUrl（自己渲染成链接，
  // 不用 window.open 以免被弹窗拦截），再隔 pollIntervalMs POST /login/poll
  // {flowId} 查状态；ready 时 Host 组装凭据入池，凭据不出网关。
  // 每条流 10 分钟过期，Map 上限 8 条，随手清理。

  /** 进行中的登录流：flowId → { flow, channel, createdAt }。 */
  const loginFlows = new Map()

  /** 驱逐过期/多余的流。 */
  function pruneLoginFlows() {
    const now = Date.now()
    for (const [key, value] of loginFlows) {
      if (now - value.createdAt > LOGIN_FLOW_TTL_MS) loginFlows.delete(key)
    }
    while (loginFlows.size > LOGIN_FLOW_MAX) {
      const oldest = [...loginFlows.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0]
      loginFlows.delete(oldest[0])
    }
  }

  /** 包一层 loopback 栅栏 + 异常兜底。 */
  const guard = (handler) => async (req, res) => {
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
      return
    }
    try {
      await handler(req, res)
    } catch (error) {
      log(`[manage] ${req.method} ${req.url} 失败：${messageOf(error)}`)
      writeJson(res, 500, { ok: false, error: messageOf(error) })
    }
  }

  /** 池子当前状态（**立即返回**账号列表；余额由客户端逐账号补拉）。 */
  const summaryHandler = async (_req, res) => {
    const entries = pool.list({ withCredentials: true })
    const hidden = new Set(Array.isArray(deps.settings?.hiddenModelLists) ? deps.settings.hiddenModelLists : [])
    /**
     * ⚠ 余额**不再在 summary 里拉**（0.6.7）。
     *
     * 旧行为：`Promise.all` 并行拉全部账号的余额再返回 —— fetchBalance 每账号
     * 超时 30s，上游慢/不可用时 summary 要等 30s+ 才吐，面板一直「加载中…」，
     * 看起来就是「账号列表消失了」（数据其实在，只是被阻塞的请求挡住）。
     *
     * 新契约：summary 只读 SQLite（毫秒级）立即返回；`balance: null` 表示
     * 「未拉取」，客户端对 null 的账号**逐个**打 `/balance?id=` 懒加载
     * （单账号超时只拖慢自己那张卡，不影响列表出现）。
     */
    const accounts = entries.map((entry, index) => {
      const view = publicAccount(entry, index)
      /** 账号「模型栏位」是否显示（面板每卡片右侧的开关状态）。 */
      view.modelListVisible = !hidden.has(entry.id)
      /** null = 未拉取（客户端懒加载），不是「失败」。 */
      view.balance = null
      return view
    })
    /**
     * captcha 载体状态：面板据此决定「领取」前要不要先给一个
     * 「以调试模式重启」按钮（而不是让用户去手抄 param）。
     * `probeCaptcha` 现探、不缓存；探测失败只是意味着领取暂时不可用。
     */
    let captcha
    if (typeof deps.probeCaptcha === 'function') {
      try {
        captcha = await deps.probeCaptcha()
      } catch (error) {
        captcha = { reachable: false, reason: messageOf(error) }
      }
    }
    writeJson(res, 200, {
      ok: true,
      accounts,
      enabledCount: accounts.filter((account) => account.enabled).length,
      unifiedModelList: deps.settings?.unifiedModelList !== false,
      ...(captcha !== undefined ? { captcha } : {}),
      /** 自动领取开关（面板拨盘）与观测。探测永远可用；领取可开关。 */
      autoClaim: {
        enabled: deps.getAutoClaimEnabled?.() === true,
        ...(deps.getAutoClaimStats?.() ?? {}),
      },
      /** 统一选号顺序策略（0.7.0）：面板据此显示「使用」按钮的实际作用。 */
      selectionOrder: pool.selectionOrder ?? 'expiry',
      /** OpenAI 网关状态（0.9.3）：面板配置区直接渲染，不再单独请求。apiKey 不进 summary。 */
      openAiGateway: {
        running: deps.getOpenAiGateway?.() !== undefined,
        enabledInSettings: deps.getOpenAiGatewayEnabled?.() === true,
        baseUrl: deps.getOpenAiGateway?.()?.baseUrl ?? null,
        port: deps.getOpenAiGateway?.()?.port ?? null,
      },
      fetchedAt: Date.now(),
    })
  }

  /**
   * **实时路由状态**（1.0.0）：模型栏旁「当前使用账号」的数据源。
   *
   * 统一选号每请求自动换号，所以这里读的是 `pool.lastRouted()` ——
   * 每次真实派发前由 plan-client 回填的进程内记录。
   *
   * **没有派发记录时不停留在「未知」**：`preview` 用与 `pick` **同一套筛选 +
   * 排序**给出「下一条会用的账号」，让 UI 一上来就能显示具体是哪个号，
   * 后续真实路由再覆盖它。钉定栏位则由客户端直接用所选账号，不看这里。
   *
   * 1.0.1 审计修复：
   * - `?model=` 参与候选筛选（限流/忙是按模型判的，不带模型必然说谎）；
   * - 每个账号带 `quota`（准入判定依据），用来解释「面板有额度、对话却耗尽」；
   * - `lastRouted.outcome` 区分「正在服务 / 已被判耗尽」，不再把失败账号
   *   显示成健康账号。
   */
  const routingHandler = async (req, res) => {
    const model = new URL(req.url ?? '/', 'http://localhost').searchParams.get('model')?.trim() ?? ''
    const routed = typeof pool.lastRouted === 'function' ? pool.lastRouted() : undefined
    const entries = pool.list()
    const preview = typeof pool.previewOrder === 'function' ? pool.previewOrder(model, 1) : []
    /** 池里的 entry（无凭据）→ 缓存里的「生效桶」视图。 */
    const quotaView = (entry, quotient) => {
      const state = {
        available: quotient?.available ?? null,
        expiresAt: quotient?.expiresAt ?? null,
        source: quotient === undefined ? 'pending' : quotient.failedAt !== undefined ? 'failed' : 'upstream',
      }
      /** 再叠加准入判定：1005 硬过滤 / 缓存桶过期都会给出否决位。 */
      const admission = typeof pool.quotaState === 'function'
        ? pool.quotaState(entry.id, model.length > 0 ? model : routed?.modelId ?? '', {
            /** 面板口径必须传进去：available 是 quotaState 里唯一的事实来源。 */
            available: quotient?.available ?? null,
            expiresAt: state.expiresAt,
          })
        : { available: state.available, usable: state.available, limited: false, expired: false, reason: null }
      /**
       * ⚠ 合并方向固定：`quotaState` 是**唯一**的合并点。
       * `available`（面板口径）原样透传 —— `true`/`false`/`null`（未知），
       * 准入否决**不洗掉它**：`limited=true && available=true` 就是
       * 「面板显示有额度、对话却已耗尽」的显式冲突组合，UI 靠它出警告；
       * 综合结论看 `usable`（准入已拒 = false；未知 = null）。
       */
      return {
        available: admission.available,
        usable: admission.usable,
        expiresAt: state.expiresAt,
        source: state.source,
        limited: admission.limited === true,
        expired: admission.expired === true,
        reason: admission.reason ?? null,
        /**
         * 风控痕迹（1.0.2）：该账号曾触发 3012 unusual activity。
         * **不是**准入判据，只供模型栏徽标画 ⚠ 与提示「点清除限流恢复」；
         * 3012 的惩罚是账号级冷却，用户需要看见它才不会反复重试把冷却攒满。
         */
        riskBlocked: riskBlockedOf(entry),
      }
    }
    writeJson(res, 200, {
      ok: true,
      /** 最近一次**真实派发**的账号；null = 本进程还没发过请求。 */
      lastRouted: routed ?? null,
      /** 尚未派发时预测的下一条账号（与 pick 同筛选同排序的第一个，只读）。 */
      preview: preview[0] === undefined
        ? null
        : {
            accountId: preview[0].accountId,
            nickname: preview[0].nickname,
            /** 同 `accounts[].usedRatio`；取整表里的 entry 才能拉额度。 */
            usedRatio: quotaRatioOf(entries.find((item) => item.id === preview[0].accountId) ?? {}),
            model: model.length > 0 ? model : null,
          },
      /**
       * 账号 id → 昵称 + 额度占比的最小映射：钉定栏位要靠它把
       * `zcode-start-plan-acct-<id>` 换成「账号昵称」；圆环要靠 `usedRatio`
       * 画占用弧。**不含任何凭据**。
       *
       * `usedRatio`：0..1 = 已用占比（圆环顺时针占比），null = 未知/企业版。
       * `quota.available`：面板口径（上游余额接口的**生效**桶是否还有余额）。
       * `quota.limited`：对话口径（是否已被上游判 1005/1113 并硬过滤）。
       * 两者同时为真 = 当前这一轮「显示有额度但实际用不了」。
       * `quota.riskBlocked`（1.0.2）：该账号曾触发 3012 风控 —— 面板据此在模型栏
       * 徽标上加 ⚠ 并提示「点清除限流恢复」；**不参与取号**。
       */
      accounts: entries.map((entry) => ({
        accountId: entry.id,
        nickname: entry.nickname,
        usedRatio: quotaRatioOf(entry),
        quota: quotaView(entry, quotaCacheOf(entry)),
      })),
      selectionOrder: pool.selectionOrder ?? 'expiry',
      enabledCount: entries.filter((entry) => entry.enabled === true).length,
      totalCount: entries.length,
      /** 请求里带的模型：客户端未带时回落到最近一次实发模型，便于排查。 */
      model: model.length > 0 ? model : routed?.modelId ?? null,
      fetchedAt: Date.now(),
    })
  }

  /** 单账号余额（点「刷新」时用，避免整表全拉）。 */
  const balanceHandler = async (req, res) => {
    const id = new URL(req.url ?? '/', 'http://localhost').searchParams.get('id')?.trim() ?? ''
    const entry = id.length > 0 ? pool.list({ withCredentials: true }).find((item) => item.id === id) : undefined
    if (entry === undefined) {
      writeJson(res, 404, { ok: false, error: `账号不存在：${id}` })
      return
    }
    if (typeof fetchBalance !== 'function') {
      writeJson(res, 200, { ok: true, balance: null })
      return
    }
    try {
      const balance = await fetchBalance(entry.credential)
      /**
       * 0.7.0：拉取成功即回填池子的到期缓存 —— 统一选号按「快过期先用」
       * 排序时消费这个值（pool.noteExpiry）。enterprise / 全用光（无 expiresAt）
       * 都回填 0 = 移除缓存（该账号按无穷大排后）。
       */
      pool.noteExpiry?.(id, balance?.expiresAt ?? 0)
      /**
       * 面板手动刷新 = 用户眼里的「最新事实」，徽标缓存必须同步，
       * 否则会出现「面板刷新后有余量、徽标还显示耗尽」的对立状态。
       */
      if (balance !== undefined && balance.enterprise !== true) {
        const remaining = typeof balance.remaining === 'number' ? balance.remaining : null
        const total = typeof balance.total === 'number' ? balance.total : null
        balanceCache.set(id, {
          usedRatio:
            remaining !== null && total !== null && total > 0
              ? Math.min(1, Math.max(0, (total - remaining) / total))
              : null,
          available: remaining !== null && remaining > 0,
          expiresAt: Number.isFinite(balance.expiresAt) ? balance.expiresAt : null,
          fetchedAt: Date.now(),
        })
        trimBalanceCache()
      }
      writeJson(res, 200, {
        ok: true,
        balance: balance === undefined
          ? null
          : balance.enterprise === true
            ? { enterprise: true, remaining: null, total: null, planName: null }
            : {
                enterprise: false,
                remaining: typeof balance.remaining === 'number' ? balance.remaining : null,
                total: typeof balance.total === 'number' ? balance.total : null,
                planName: balance.planName ?? null,
                /** 汇总条沿用「最早到期」（兼容旧客户端）。 */
                ...(Number.isFinite(balance.expiresAt) ? { expiresAt: balance.expiresAt } : {}),
                /**
                 * ⚠ 逐桶下发（0.6.8）：每个桶带自己的 remaining/total/expiresAt，
                 * 面板按桶画条 —— 多个额度桶到期时间不同，汇总条只会显示最早的
                 * 那个，其余桶的到期时间被吞掉（用户实测反馈）。
                 */
                ...(Array.isArray(balance.buckets) && balance.buckets.length > 0
                  ? {
                      buckets: balance.buckets.map((bucket) => ({
                        planId: bucket.planId ?? null,
                        showName: bucket.showName ?? null,
                        remaining:
                          typeof bucket.availableUnits === 'number'
                            ? bucket.availableUnits
                            : typeof bucket.remainingUnits === 'number'
                              ? bucket.remainingUnits
                              : null,
                        total: typeof bucket.totalUnits === 'number' ? bucket.totalUnits : null,
                        ...(Number.isFinite(bucket.expiresAt) && bucket.expiresAt > 0
                          ? { expiresAt: bucket.expiresAt }
                          : {}),
                      })),
                    }
                  : {}),
                /** 未生效的计划额度（如 23 点启用的领取包）；无则不下发该键。 */
                ...(Array.isArray(balance.pending) && balance.pending.length > 0
                  ? { pending: balance.pending }
                  : {}),
              },
      })
    } catch (error) {
      writeJson(res, 200, { ok: true, balance: null, error: messageOf(error) })
    }
  }

  /** 启用 / 停用。 */
  const setEnabledHandler = async (req, res) => {
    const body = (await readJsonBody(req)) ?? {}
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    const enabled = body.enabled
    if (id.length === 0 || typeof enabled !== 'boolean') {
      writeJson(res, 400, { ok: false, error: '需要 id（字符串）与 enabled（布尔）' })
      return
    }
    pool.setEnabled(id, enabled)
    notifyChanged()
    writeJson(res, 200, { ok: true, id, enabled })
  }

  /** 删除。 */
  const removeHandler = async (req, res) => {
    const body = (await readJsonBody(req)) ?? {}
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    if (id.length === 0) {
      writeJson(res, 400, { ok: false, error: '需要 id（字符串）' })
      return
    }
    const removed = pool.remove(id)
    if (!removed) {
      writeJson(res, 404, { ok: false, error: `账号不存在：${id}` })
      return
    }
    /** 审计修复：账号删除后额度缓存必须同步丢弃（否则 Map 只增不减）。 */
    balanceCache.delete(id)
    notifyChanged()
    writeJson(res, 200, { ok: true, id })
  }

  /**
   * 清限流标记（当日额度误标时的自救）。
   *
   * 面板只有在 `modelRateLimits` 里有未过期标记时才显示 × 按钮（client.js
   * AccountCard），所以「清了几条、清的是哪个模型」必须回给面板 —— 旧实现只回
   * `removed`，用户点完看不到任何具体信息，无法判断是不是点错了账号。
   *
   * ⚠ 同时清掉 `last_error`（1.0.2）：限流/风控之后宿主会把可读错误写进
   * `last_error`，卡片上的红字就从那里渲染。标记清了、红字还挂着 = 用户以为
   * 「点了没生效」。所以先取出旧值回报（`lastErrorBefore`，让用户知道当初为什么
   * 被限），再把它清空。
   *
   * @returns 200 `{ ok, id, removed, clearedModels, lastErrorBefore }`
   */
  const resetLimitsHandler = async (req, res) => {
    const body = (await readJsonBody(req)) ?? {}
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    const model = typeof body.model === 'string' ? body.model.trim() : ''
    if (id.length === 0) {
      writeJson(res, 400, { ok: false, error: '需要 id（字符串）' })
      return
    }
    /**
     * 清除前的快照：`removed` 与 `clearedModels` 都从它算 ——
     * `pool.clearModelRateLimits` 只回一个数字，回不了「清了哪些模型」。
     */
    const before = pool.get?.(id) ?? pool.list().find((entry) => entry.id === id)
    const limitsBefore = { ...(before?.model_rate_limits ?? {}) }
    const targets = model.length > 0 ? [model] : Object.keys(limitsBefore)
    /** 只有**真的在表里**的模型才算被清掉（切模型后再点全清不该报假数字）。 */
    const clearedModels = targets.filter((modelId) => Object.prototype.hasOwnProperty.call(limitsBefore, modelId))
    const lastErrorBefore = typeof before?.last_error === 'string' && before.last_error.length > 0
      ? before.last_error
      : null
    const removed = pool.clearModelRateLimits(id, model.length > 0 ? [model] : undefined)
    /**
     * 清标记同时清错误文案：否则卡片上仍显示「额度已用尽」之类的旧原因，
     * 用户只会认为清除按钮坏了。`noteError` 缺省（老池子实例）时静默跳过。
     */
    if (removed > 0 || lastErrorBefore !== null) {
      try {
        pool.noteError?.(id, '')
      } catch (error) {
        log(`[manage] 清除 last_error 失败（${id}）：${messageOf(error)}`)
      }
    }
    if (removed > 0) log(`[manage] 清除限流标记：${before?.nickname ?? id} × ${clearedModels.join(', ')}`)
    notifyChanged()
    writeJson(res, 200, {
      ok: true,
      id,
      removed,
      /** 具体清了哪些模型（面板据此提示「清了 N 条 · 哪个模型」）。 */
      clearedModels,
      /**
       * 清除前的 last_error（null = 本来就没有）。给面板展示「当初为什么被限」，
       * 用户点完 × 之后仍能看到原因，而不是信息一起被抹掉。
       */
      lastErrorBefore,
    })
  }

  /** 重排（顺序即选号优先级）。 */
  const reorderHandler = async (req, res) => {
    const body = (await readJsonBody(req)) ?? {}
    const ids = Array.isArray(body.ids) ? body.ids : []
    if (!ids.every((id) => typeof id === 'string' && id.trim().length > 0)) {
      writeJson(res, 400, { ok: false, error: '需要 ids（非空字符串数组，且为当前集合的排列）' })
      return
    }
    pool.reorder(ids)
    notifyChanged()
    writeJson(res, 200, { ok: true, ids })
  }

  /** 重命名备注。 */
  const renameHandler = async (req, res) => {
    const body = (await readJsonBody(req)) ?? {}
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    const nickname = typeof body.nickname === 'string' ? body.nickname.trim() : ''
    if (id.length === 0 || nickname.length === 0) {
      writeJson(res, 400, { ok: false, error: '需要 id 与 nickname（均非空）' })
      return
    }
    const entry = pool.get?.(id) ?? pool.list({ withCredentials: true }).find((item) => item.id === id)
    if (entry === undefined) {
      writeJson(res, 404, { ok: false, error: `账号不存在：${id}` })
      return
    }
    pool.patchAccount(id, { nickname })
    notifyChanged()
    writeJson(res, 200, { ok: true, id, nickname })
  }

  /**
   * ⚠ 0.9.7 移除 `/use`（置顶）路由：0.7.0 起 `selectionOrder: 'expiry'` 为默认，
   * 取号按快过期先后，置顶不再决定取号；client.js 自 0.7.0 起就没有「使用」按钮，
   * 该路由已无任何调用方。改顺序统一走 `/reorder`。
   */

  /**
   * 领取赠送额度（一次性 captcha 的真正入口）。
   *
   * 两条路由（对应 `lib/upstream-api.js` 的两个上游调用）：
   * - `GET  /claimable?id=` → 查**官方活动发现端点**（`/api/v1/marketing/touch`，
   *   0.6.0 起；旧的 `/billing/preview` 实证恒空），返回投放按钮里的 plan_id 列表
   *   （零 captcha —— captcha 只在真正 claim 时才烧）；
   * - `POST /claim {id, planId, campaignId?}` → 直接领取；**每个 plan 重新 mint captcha**
   *   （param 一次性，复用必 3007）。`campaignId` 供领取成功后的 confirm 回执。
   *
   * ⚠ 为什么 captcha 走 `deps.client.mintCaptcha`（ZcodePlanClient 的串行队列）：
   * 面板点击与推理链路可能同时要 captcha，产出是**设备级**的，两条链路各自
   * 起一份会互相踩 CDP 页面。复用同一个实例 = 同一把闸门。
   */
  const claimableHandler = async (req, res) => {
    const id = new URL(req.url ?? '/', 'http://localhost').searchParams.get('id')?.trim() ?? ''
    const entry = id.length > 0 ? pool.list({ withCredentials: true }).find((item) => item.id === id) : undefined
    if (entry === undefined) {
      writeJson(res, 404, { ok: false, error: `账号不存在：${id}` })
      return
    }
    if (typeof fetchClaimablePlans !== 'function') {
      writeJson(res, 200, { ok: true, plans: [] })
      return
    }
    try {
      /** 活动发现走 marketing/touch（官方同款）；补活跃上报无害且与官方启动行为一致。 */
      await reportActivation?.(entry.credential)
      /**
       * ⚠ 服务端行为（2026-10-31 实测）：**领取成功后 marketing/touch 不再给该账号
       * 投放**（deliveries 变空）⇒ 只看投放，已领账号显示「无可领」、未领账号显示
       * 「可领」——用户预期一视同仁，看到的却是参差不齐。
       *
       * 对策：合并 `billing/balance` 的领取记录（`data.plans[]`，含 entitlements
       * 元数据）。无投放但记录里有的活动照样下发，标 `claimed: true` 并带上
       * 名称/单位/额度/生效期；面板据此显示「已领取」或「已领取 · 待生效」。
       *
       * ⚠ 回填仍走 `^zcode-v3-start-plan-` 前缀白名单（恢复 1.0.x 语义）：
       * `data.plans[]` 还包含**订阅类 plan**（非活动），整表回填会把它们拉进
       * 活动面板造成误读；前缀是实测的活动 id 形态（1103 / 1106-wk 两代一致）。
       * 「待生效」由 `fetchClaimedPlans` 按 `effective_at > server_time` 判定。
       */
      const [plans, claimed] = await Promise.all([
        fetchClaimablePlans(entry.credential),
        typeof fetchClaimedPlans === 'function'
          ? fetchClaimedPlans(entry.credential)
          : typeof fetchClaimedPlanIds === 'function'
            ? fetchClaimedPlanIds(entry.credential).then((ids) => new Map([...ids].map((planId) => [planId, { plan_id: planId, claimed: true, pending: false }])))
            : Promise.resolve(new Map()),
      ])
      const merged = new Map()
      for (const plan of plans) {
        const record = claimed.get(plan.planId)
        merged.set(plan.planId, {
          ...plan,
          claimed: record !== undefined,
          ...(record?.pending === true ? { pending: true } : {}),
        })
      }
      for (const [planId, record] of claimed) {
        if (merged.has(planId)) continue
        /** 只有活动前缀的记录才回填（plans[] 里的订阅类 plan 不是活动）。 */
        if (!/^zcode-v3-start-plan-/.test(planId)) continue
        merged.set(planId, {
          planId,
          priority: typeof record.priority === 'number' ? record.priority : 0,
          claimed: true,
          ...(record.name !== undefined ? { name: record.name } : {}),
          ...(record.unitType !== undefined ? { unitType: record.unitType } : {}),
          ...(record.grantUnits !== undefined ? { grantUnits: record.grantUnits } : {}),
          ...(record.effectiveAt !== undefined ? { effectiveAt: record.effectiveAt } : {}),
          ...(record.expiresAt !== undefined ? { expiresAt: record.expiresAt } : {}),
          ...(record.pending === true ? { pending: true } : {}),
        })
      }
      const list = [...merged.values()].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
      /**
       * `sources` 给面板三种状态用（否则「探测失败」与「确实没有」不可区分）：
       * - `campaign` 投放源条数、`records` 领取记录条数（含 pending）；
       * - 两者皆 0 且 `ok:true` = 服务端此刻确实没有活动，不是故障。
       */
      writeJson(res, 200, {
        ok: true,
        plans: list,
        sources: { campaign: plans.length, records: claimed.size },
      })
    } catch (error) {
      writeJson(res, 200, { ok: false, plans: [], error: messageOf(error) })
    }
  }

  /**
   * 领取赠送额度。
   *
   * ## ⚠ 设计变更（2026-10-28，来自官方客户端日志实证）
   *
   * 早先的实现是「先查 `preview` 拿列表 → 有才领」。日志分析证明这条路是错的：
   *
   * | 客户端行为 | 实测 |
   * |---|---|
   * | `getManualClaimPlanPreviews`（即 `/billing/preview`） | **全天 0 次调用** |
   * | `claimManualPlan`（即 `/billing/claim`） | 点击即调，不看 preview |
   *
   * 官方客户端**从不预判有没有活动**：它直接发 claim，用服务端返回的
   * `code`/`msg` 告诉用户结果。我们的 `preview` 恒空，导致面板永远显示
   * 「暂无可领取」、按钮根本不出现 —— 而实际活动是存在的（用户已领到过）。
   *
   * 故改为：**`planId` 必填，直接 claim，忠实回传业务码**。
   * 让「有没有名额」由服务端裁决（`1003` 已领过 / `1005` 领完 / `0` 成功），
   * 而不是由我们猜。`/claimable` 路由保留（preview 语义待进一步求证），
   * 但**不再作为领取的前置条件**。
   */
  const claimHandler = async (req, res) => {
    const body = (await readJsonBody(req)) ?? {}
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    const planId = typeof body.planId === 'string' ? body.planId.trim() : ''
    /** 可选：领取成功后的 marketing/touch/action confirm 回执需要它（0.9.7）。 */
    const campaignId = typeof body.campaignId === 'string' ? body.campaignId.trim() : ''
    if (id.length === 0) {
      writeJson(res, 400, { ok: false, error: '需要 id（字符串）' })
      return
    }
    if (planId.length === 0) {
      writeJson(res, 400, { ok: false, error: '需要 planId（字符串）：用 /claimable 探测，或从活动页抄' })
      return
    }
    const entry = pool.list({ withCredentials: true }).find((item) => item.id === id)
    if (entry === undefined) {
      writeJson(res, 404, { ok: false, error: `账号不存在：${id}` })
      return
    }
    if (typeof claimPlan !== 'function' || typeof deps.client?.mintCaptcha !== 'function') {
      writeJson(res, 500, { ok: false, error: '领取链路未就绪（captcha 载体或上游客户端不可用）' })
      return
    }

    /**
     * captcha 产出**重试一次**。
     *
     * 官方客户端日志实证（2026-10-28 21:00）：一次点击里
     * `send_preflight outcome=error` → 6 秒后 `outcome=success` → 才发 claim。
     * 失败原因是阿里云 CDN 连续 4 次 `resource.failed`（几十到两百毫秒级抖动）。
     * 也就是说「按两次才领到」的体验在官方客户端同样存在，它靠**原地重试**消化。
     *
     * ⚠ 只重试一次：mint 有独立退避闸门，无限重试会烧设备信誉。
     */
    let captcha
    let attempts = 0
    for (let attempt = 0; attempt < 2; attempt += 1) {
      attempts += 1
      try {
        captcha = await deps.client.mintCaptcha()
        break
      } catch (error) {
        if (attempt === 1) {
          writeJson(res, 200, {
            ok: false,
            results: [{ planId, ok: false, error: `captcha 产出失败（尝试 ${attempts} 次）：${messageOf(error)}` }],
          })
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 800))
      }
    }

    const outcome = await claimPlan(entry.credential, planId, captcha)
    /**
     * confirm 回执纪律（docs/upstream-protocol.md）：**只在 `0`/`1003` 后发**。
     * 成功不发 = 服务端重复投放（每轮白烧 captcha）；失败发 = 叫服务端别再投了
     * （白丢机会）。campaignId 来自面板探测结果（/claimable 下发）。
     */
    if (outcome.ok === true || outcome.code === 0 || outcome.code === 1003) {
      await reportMarketingAction(entry.credential, campaignId, 'confirm')
    }
    /**
     * 忠实回传业务码，`1004` 给出**克制**的解释。
     *
     * ⚠ 2026-11-06/07 的对照实验未能把 `1004` 归因到「设备配额已用」：
     * - 同账号（Ye Send）本机 claim 得 1004，但几小时后在另一环境领取成功 ——
     *   「换设备导致」与「投放延迟到达」在时间上混杂，无法归因；
     * - 控制变量（同账号同 Chrome 只换 device_mid）三种 device_mid 的
     *   `deliveries` 全为空，无资格差可观察；
     * - 客户端领取成功前同样只有 `deliveries` 空的记录（按钮是后来出现的）。
     *
     * ⚠ 2026-11-10 版本门控消融把主因钉在了**客户端版本**上
     * （docs/claim-forensics-2026-11.md §2.1：同账号同 device_mid 下，
     * `3.16.3` 全部拿不到投放/拿 1004，`3.17.2` 起全部成功；门控历史上每次都随
     * 官方发版抬高）。插件启动时会把门控版本跟到官方当前版本（version-probe，
     * 只抬不降），所以「先确认版本」是第一条排查动作，而不是最后一条。
     *
     * 剩下的失败只可能是「该活动没分配到这台账号」（§4 已确认投放按账号分配），
     * 所以文案不再写「机制未定论」。
     */
    const explain = (outcome) => {
      if (outcome.ok === true || outcome.code === 1003) return undefined
      if (outcome.code === 1004) {
        return (
          'no permission（1004）：服务端判定不满足领取条件。最常见原因是客户端版本' +
          '低于官方当前版本（版本门控），插件已在启动时自动跟随官方版本；若仍失败，' +
          '可能是该活动未分配到此账号。'
        )
      }
      if (outcome.code === 1005) return '名额已领完（1005）：该活动本批已被领满。'
      return outcome.message ?? `HTTP ${outcome.httpStatus ?? '?'}`
    }
    const result = {
      planId,
      ok: outcome.ok === true,
      ...(outcome.code !== undefined ? { code: outcome.code } : {}),
      ...(outcome.alreadyClaimed === true ? { alreadyClaimed: true } : {}),
      httpStatus: outcome.httpStatus,
      /** 服务端原文保留在 message，另给 readable 供面板展示。 */
      ...(outcome.message !== undefined ? { message: outcome.message } : {}),
      ...(explain(outcome) !== undefined ? { readable: explain(outcome) } : {}),
      ...(outcome.ok === true ? {} : { error: explain(outcome) }),
    }
    log(
      `[manage] 领取 ${entry.nickname} × ${planId}：` +
      `${outcome.ok ? '成功' : `失败(${outcome.code ?? outcome.httpStatus})`}，captcha 尝试 ${attempts} 次`,
    )
    writeJson(res, 200, { ok: result.ok, results: [result] })
  }

  /**
   * 重启指引（0.6.6 起**不再替用户执行重启**）。
   *
   * ## 为什么从「自动重启」改为「给命令让用户自己重启」
   *
   * 旧实现 spawn PowerShell 脚本做「杀宿主 → 等退出 → 拉起」，并叠加了
   * 计划任务、`-ExecutionPolicy Bypass`、隐藏窗口、临时 .cmd 等手段 ——
   * 这组特征与恶意软件高度重合，被火绒等 AV 拦截是**正确行为**（用户实际报毒）。
   * 技术上也是死路：脚本在宿主的 Job Object 内，宿主一死脚本跟着死
   * （实测日志停在 `forcing pid N` 之后），能逃出 job 的手段恰是 AV 最敏感的。
   *
   * 现在只做两件事：校验参数 → 返回用户可直接复制的启动命令。
   * 重启是用户的决定，插件不越权。
   *
   * 路由名保留 `/restart-cdp`（0.5.x 语义），面板据此展示指引；
   * `deps.buildRestartCommand` 由 assemble 注入（探测宿主 exe 并生成命令）。
   */
  const restartCdpHandler = async (req, res) => {
    const body = (await readJsonBody(req)) ?? {}
    const wantsDebugPort = body.debugPort !== undefined && body.debugPort !== null
    const debugPort = Number.isInteger(body.debugPort) ? body.debugPort : undefined
    if (wantsDebugPort && !(debugPort >= 1 && debugPort <= 65_535)) {
      writeJson(res, 400, { ok: false, error: 'debugPort 必须是 1-65535 的整数（或省略 = 普通重启）' })
      return
    }
    if (typeof deps.buildRestartCommand !== 'function') {
      writeJson(res, 501, { ok: false, error: '重启指引不可用（缺少命令生成实现）' })
      return
    }
    try {
      const guide = deps.buildRestartCommand(debugPort !== undefined ? { debugPort } : {})
      log(
        `[manage] 生成重启指引：${guide.note} 命令：${guide.command}`,
      )
      writeJson(res, 200, {
        ok: true,
        mode: debugPort !== undefined ? 'debug' : 'plain',
        command: guide.command,
        port: guide.port,
        note: guide.note,
      })
    } catch (error) {
      writeJson(res, 500, { ok: false, error: messageOf(error) })
    }
  }

  /** /login/start：向渠道申请设备授权，返回 authorizeUrl + flowId（不含 secret）。 */
  const loginStartHandler = async (req, res) => {
    const body = (await readJsonBody(req)) ?? {}
    const channel = normalizeLoginChannel(body.channel)
    const flow = await startZcodeLogin(globalThis.fetch, { channel })
    pruneLoginFlows()
    loginFlows.set(flow.flowId, { flow, channel, createdAt: Date.now() })
    log(`[manage] 登录流已发起：${channel}（flowId=${flow.flowId.slice(0, 8)}…）`)
    writeJson(res, 200, {
      ok: true,
      flowId: flow.flowId,
      authorizeUrl: flow.authorizeUrl,
      expiresAt: flow.expiresAt > 0 ? flow.expiresAt : Date.now() + LOGIN_FLOW_TTL_MS,
      pollIntervalMs: Math.max(1, flow.pollIntervalSec) * 1_000,
    })
  }

  /** /login/poll：查一次授权状态；ready 时组装凭据入池（凭据不回传）。 */
  const loginPollHandler = async (req, res) => {
    const body = (await readJsonBody(req)) ?? {}
    const flowId = typeof body.flowId === 'string' ? body.flowId.trim() : ''
    if (flowId.length === 0) {
      writeJson(res, 400, { ok: false, error: '需要 flowId（字符串）' })
      return
    }
    const record = loginFlows.get(flowId)
    if (record === undefined) {
      writeJson(res, 404, { ok: false, error: '登录流不存在或已过期，请重新发起' })
      return
    }
    const outcome = await pollZcodeLogin(record.flow, globalThis.fetch, ZCODE_APP_VERSION_FALLBACK)
    if (outcome.kind === 'pending') {
      writeJson(res, 200, { ok: true, status: 'pending' })
      return
    }
    loginFlows.delete(flowId)
    if (outcome.kind === 'failed') {
      writeJson(res, 200, { ok: true, status: 'failed', error: outcome.message })
      return
    }
    // ready：凭据组装与 beginZcodeLogin 逐字段一致（绝不把凭据发回页面）。
    const credential = {
      zcode_jwt: outcome.result.zcodeJwt,
      device_mid: generateDeviceMid(),
      user_id: outcome.result.userId,
      bigmodel_access_token: outcome.result.bigmodelAccessToken,
      account_label: outcome.result.displayName,
      app_version: ZCODE_APP_VERSION_FALLBACK,
      login_channel: record.channel,
      source: 'plugin-web',
    }
    const { entry, created } = pool.add(credential)
    notifyChanged()
    log(`[manage] 通过 Web UI ${created ? '添加' : '更新'}账号：${entry.nickname}（${record.channel}）`)
    writeJson(res, 200, {
      ok: true,
      status: 'ready',
      created,
      account: { id: entry.id, nickname: entry.nickname },
    })
  }

  /**
   * OpenAI 兼容网关：状态 + 开关（0.9.3；0.9.5 去掉主 key 的 reveal）。
   *
   * - 状态实时读 `deps.getOpenAiGateway()`（assemble 注入，运行时句柄或 undefined）；
   * - 拨动开关写 `settings.json` 的 `openaiGatewayEnabled` —— **重启后生效**
   *   （网关是 HTTP server，热启停会牵扯端口占用，不做运行时切换）；
   * - 0.9.5 起鉴权**只认分发 key**（主 apiKey 已废除），apiKey 展示随之移除。
   */
  const openAiGatewayHandler = async (req, res) => {
    if (req.method === 'GET') {
      const runtime = deps.getOpenAiGateway?.()
      writeJson(res, 200, {
        ok: true,
        running: runtime !== undefined,
        baseUrl: runtime?.baseUrl ?? null,
        port: runtime?.port ?? null,
        enabledInSettings: deps.getOpenAiGatewayEnabled?.() === true,
        restartRequired: (deps.getOpenAiGatewayEnabled?.() === true) !== (runtime !== undefined),
      })
      return
    }
    const body = (await readJsonBody(req)) ?? {}
    if (typeof body.enabled !== 'boolean') {
      writeJson(res, 400, { ok: false, error: '需要 enabled（布尔）' })
      return
    }
    deps.setOpenAiGatewayEnabled?.(body.enabled)
    log(`[manage] OpenAI 兼容端点已${body.enabled ? '开启' : '关闭'}（重启宿主后生效）`)
    writeJson(res, 200, { ok: true, enabled: body.enabled, restartRequired: true })
  }

  /**
   * 分发 key CRUD（0.9.4）。**token 只在创建响应里出现一次**——之后所有列表
   * 都是脱敏形态（尾 4 位）；这是「服务端不保存明文可复现」之外的唯一取回机会，
   * 用户复制后自行保管（丢了只能删了重建）。
   */
  const distKeysHandler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    /** GET：脱敏列表（含用量与剩余额度）。 */
    if (req.method === 'GET') {
      writeJson(res, 200, {
        ok: true,
        keys: deps.listDistributionKeys?.() ?? [],
      })
      return
    }
    const body = (await readJsonBody(req)) ?? {}
    if (url.searchParams.get('op') === 'create') {
      const created = deps.createDistributionKey?.({
        name: body.name,
        quotaTotal: body.quotaTotal,
        accountId: body.accountId,
      })
      if (created === undefined) {
        writeJson(res, 500, { ok: false, error: '分发 key 创建失败（存储不可写？）' })
        return
      }
      /** 唯一一次明文下发。 */
      writeJson(res, 200, { ok: true, key: { ...created.public, token: created.token } })
      return
    }
    /**
     * update/delete 按 **id** 定位（0.9.5）：列表里只有 id（token 完全不下发）——
     * 旧版用掩码 token 定位，前端永远删不掉任何 key（后端按明文找不到）。
     */
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    if (id.length === 0) {
      writeJson(res, 400, { ok: false, error: '需要 id' })
      return
    }
    if (url.searchParams.get('op') === 'update') {
      const updated = deps.updateDistributionKey?.(id, {
        enabled: body.enabled,
        quotaTotal: body.quotaTotal,
        name: body.name,
      })
      if (updated === false) {
        writeJson(res, 404, { ok: false, error: '分发 key 不存在' })
        return
      }
      writeJson(res, 200, { ok: true })
      return
    }
    if (url.searchParams.get('op') === 'delete') {
      const removed = deps.deleteDistributionKey?.(id)
      if (removed === false) {
        writeJson(res, 404, { ok: false, error: '分发 key 不存在' })
        return
      }
      writeJson(res, 200, { ok: true })
      return
    }
    writeJson(res, 400, { ok: false, error: '未知操作（支持 ?op=create / ?op=update / ?op=delete）' })
  }

  return [
    { kind: 'exact', path: `${MANAGE_PREFIX}/summary`, handler: guard(summaryHandler) },
    { kind: 'exact', path: `${MANAGE_PREFIX}/routing`, handler: guard(routingHandler) },
    { kind: 'exact', path: `${MANAGE_PREFIX}/balance`, handler: guard(balanceHandler) },
    { kind: 'exact', path: `${MANAGE_PREFIX}/set-enabled`, handler: guard(setEnabledHandler) },
    { kind: 'exact', path: `${MANAGE_PREFIX}/remove`, handler: guard(removeHandler) },
    { kind: 'exact', path: `${MANAGE_PREFIX}/reset-limits`, handler: guard(resetLimitsHandler) },
    { kind: 'exact', path: `${MANAGE_PREFIX}/reorder`, handler: guard(reorderHandler) },
    { kind: 'exact', path: `${MANAGE_PREFIX}/rename`, handler: guard(renameHandler) },
    { kind: 'exact', path: `${MANAGE_PREFIX}/unified-list`, handler: guard(unifiedListHandler) },
    { kind: 'exact', path: `${MANAGE_PREFIX}/model-list-visible`, handler: guard(modelListVisibleHandler) },
    { kind: 'exact', path: `${MANAGE_PREFIX}/auto-claim`, handler: guard(autoClaimHandler) },
    { kind: 'exact', path: `${MANAGE_PREFIX}/login/start`, handler: guard(loginStartHandler) },
    { kind: 'exact', path: `${MANAGE_PREFIX}/login/poll`, handler: guard(loginPollHandler) },
    { kind: 'exact', path: `${MANAGE_PREFIX}/claimable`, handler: guard(claimableHandler) },
    { kind: 'exact', path: `${MANAGE_PREFIX}/claim`, handler: guard(claimHandler) },
    { kind: 'exact', path: `${MANAGE_PREFIX}/restart-cdp`, handler: guard(restartCdpHandler) },
    { kind: 'exact', path: `${MANAGE_PREFIX}/openai-gateway`, handler: guard(openAiGatewayHandler) },
    { kind: 'exact', path: `${MANAGE_PREFIX}/distribution-keys`, handler: guard(distKeysHandler) },
  ]
}
