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
 * 3. 写操作（enable/disable/remove/reset/reorder/use/login）逐条校验参数形状。
 */

import { isIP } from 'node:net'
import {
  startZcodeLogin,
  pollZcodeLogin,
  normalizeLoginChannel,
  fetchClaimablePlans,
  claimPlan,
  reportActivation,
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
  }
}

/**
 * 构造管理路由。
 *
 * @param {{
 *   pool: import('./pool.js').AccountPool,
 *   fetchBalance?: (credential: any) => Promise<any>,
 *   client?: { mintCaptcha?: () => Promise<{ param: string, region: string }> },
 *   requestRestart?: (options: { debugPort: number, waitSeconds: number }) => Promise<void>,
 *   probeCaptcha?: () => Promise<{ mode?: string, debugPort?: number, reachable: boolean, reason?: string }>,
 *   log?: (message: string) => void,
 *   onChanged?: () => void,
 *   onSetUnifiedVisible?: (visible: boolean) => void,
 *   onSetAccountVisible?: (accountId: string, visible: boolean) => void,
 *   getAutoClaimEnabled?: () => boolean,
 *   getAutoClaimStats?: () => Record<string, any>,
 *   onSetAutoClaim?: (enabled: boolean) => void,
 *   settings?: { unifiedModelList?: boolean, hiddenModelLists?: string[], autoClaim?: boolean },
 * }} deps
 * @returns {Array<{ kind: 'exact', path: string, handler: (req: any, res: any) => Promise<void> }>}
 */
export function makeManageRoutes(deps) {
  const pool = deps.pool
  const fetchBalance = deps.fetchBalance
  const log = deps.log ?? (() => {})
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

  /** 池子当前状态（含每账号余额与栏位可见性，拉取失败给 null）。 */
  const summaryHandler = async (_req, res) => {
    const entries = pool.list({ withCredentials: true })
    const hidden = new Set(Array.isArray(deps.settings?.hiddenModelLists) ? deps.settings.hiddenModelLists : [])
    /**
     * 余额并行拉取（纯读、账号间无依赖）：串行时最坏 30s × N（fetchBalance
     * 每账号超时 30s），面板会一直「加载中…」。
     * fetchBalance 失败路径返回 undefined / 抛错都归一为 null —— 明确下发
     * `balance: null`，客户端（client.js load）只对缺键的账号补拉 /balance，
     * 避免同一端点被二次重试双倍消耗。
     */
    const balances = await Promise.all(
      entries.map(async (entry) => {
        if (typeof fetchBalance !== 'function' || entry.enabled !== true) return null
        try {
          const balance = await fetchBalance(entry.credential)
          if (balance === undefined) return null
          return balance.enterprise === true
            ? { enterprise: true, remaining: null, total: null, planName: null }
            : {
                enterprise: false,
                remaining: typeof balance.remaining === 'number' ? balance.remaining : null,
                total: typeof balance.total === 'number' ? balance.total : null,
                planName: balance.planName ?? null,
                /** 还有余额的桶里最早的那个到期时间（毫秒）；全用光则不给。 */
                ...(Number.isFinite(balance.expiresAt) ? { expiresAt: balance.expiresAt } : {}),
                /** 未生效的计划额度（如 23 点启用的领取包）；无则不下发该键。 */
                ...(Array.isArray(balance.pending) && balance.pending.length > 0
                  ? { pending: balance.pending }
                  : {}),
              }
        } catch {
          return null
        }
      }),
    )
    const accounts = entries.map((entry, index) => {
      const view = publicAccount(entry, index)
      /** 账号「模型栏位」是否显示（面板每卡片右侧的开关状态）。 */
      view.modelListVisible = !hidden.has(entry.id)
      view.balance = balances[index]
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
                /** 还有余额的桶里最早的那个到期时间（毫秒）；全用光则不给。 */
                ...(Number.isFinite(balance.expiresAt) ? { expiresAt: balance.expiresAt } : {}),
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
    notifyChanged()
    writeJson(res, 200, { ok: true, id })
  }

  /** 清限流标记（当日额度误标时的自救）。 */
  const resetLimitsHandler = async (req, res) => {
    const body = (await readJsonBody(req)) ?? {}
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    const model = typeof body.model === 'string' ? body.model.trim() : ''
    if (id.length === 0) {
      writeJson(res, 400, { ok: false, error: '需要 id（字符串）' })
      return
    }
    const removed = pool.clearModelRateLimits(id, model.length > 0 ? [model] : undefined)
    writeJson(res, 200, { ok: true, id, removed })
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
   * 置顶使用（「选择使用哪个账号」的落地）。
   *
   * 池子的既有约定：**手动顺序即选号优先级**（lib/pool.js 文件头第 1 条），
   * `pick()` 永远取第一个「启用且未限流」的账号。因此「下次请求用这个号」
   * = 把它排到首位。这里复用 `/reorder` 的集合校验，不另开写入口。
   */
  const useHandler = async (req, res) => {
    const body = (await readJsonBody(req)) ?? {}
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    if (id.length === 0) {
      writeJson(res, 400, { ok: false, error: '需要 id（字符串）' })
      return
    }
    const entries = pool.list()
    if (!entries.some((item) => item.id === id)) {
      writeJson(res, 404, { ok: false, error: `账号不存在：${id}` })
      return
    }
    const ids = [id, ...entries.map((item) => item.id).filter((existing) => existing !== id)]
    pool.reorder(ids)
    notifyChanged()
    writeJson(res, 200, { ok: true, id, order: ids })
  }

  /**
   * 领取赠送额度（一次性 captcha 的真正入口）。
   *
   * 两条路由（对应 `lib/upstream-api.js` 的两个上游调用）：
   * - `GET  /claimable?id=` → 查**官方活动发现端点**（`/api/v1/marketing/touch`，
   *   0.6.0 起；旧的 `/billing/preview` 实证恒空），返回投放按钮里的 plan_id 列表
   *   （零 captcha —— captcha 只在真正 claim 时才烧）；
   * - `POST /claim {id, planId}` → 直接领取；**每个 plan 重新 mint captcha**
   *   （param 一次性，复用必 3007）。
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
      const plans = await fetchClaimablePlans(entry.credential)
      writeJson(res, 200, { ok: true, plans })
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
    /** 忠实回传：业务码是服务端的裁决，不要翻译成含糊的「失败」。 */
    const result = {
      planId,
      ok: outcome.ok === true,
      ...(outcome.code !== undefined ? { code: outcome.code } : {}),
      ...(outcome.alreadyClaimed === true ? { alreadyClaimed: true } : {}),
      httpStatus: outcome.httpStatus,
      ...(outcome.message !== undefined ? { message: outcome.message } : {}),
      ...(outcome.ok === true ? {} : { error: outcome.message ?? `HTTP ${outcome.httpStatus ?? '?'}` }),
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
        /** 客户端兼容字段：老面板读它显示「稍后刷新」。 */
        estimatedReadyMs: 0,
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

  return [
    { kind: 'exact', path: `${MANAGE_PREFIX}/summary`, handler: guard(summaryHandler) },
    { kind: 'exact', path: `${MANAGE_PREFIX}/balance`, handler: guard(balanceHandler) },
    { kind: 'exact', path: `${MANAGE_PREFIX}/set-enabled`, handler: guard(setEnabledHandler) },
    { kind: 'exact', path: `${MANAGE_PREFIX}/remove`, handler: guard(removeHandler) },
    { kind: 'exact', path: `${MANAGE_PREFIX}/reset-limits`, handler: guard(resetLimitsHandler) },
    { kind: 'exact', path: `${MANAGE_PREFIX}/reorder`, handler: guard(reorderHandler) },
    { kind: 'exact', path: `${MANAGE_PREFIX}/rename`, handler: guard(renameHandler) },
    { kind: 'exact', path: `${MANAGE_PREFIX}/use`, handler: guard(useHandler) },
    { kind: 'exact', path: `${MANAGE_PREFIX}/unified-list`, handler: guard(unifiedListHandler) },
    { kind: 'exact', path: `${MANAGE_PREFIX}/model-list-visible`, handler: guard(modelListVisibleHandler) },
    { kind: 'exact', path: `${MANAGE_PREFIX}/auto-claim`, handler: guard(autoClaimHandler) },
    { kind: 'exact', path: `${MANAGE_PREFIX}/login/start`, handler: guard(loginStartHandler) },
    { kind: 'exact', path: `${MANAGE_PREFIX}/login/poll`, handler: guard(loginPollHandler) },
    { kind: 'exact', path: `${MANAGE_PREFIX}/claimable`, handler: guard(claimableHandler) },
    { kind: 'exact', path: `${MANAGE_PREFIX}/claim`, handler: guard(claimHandler) },
    { kind: 'exact', path: `${MANAGE_PREFIX}/restart-cdp`, handler: guard(restartCdpHandler) },
  ]
}
