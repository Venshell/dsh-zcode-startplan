/**
 * 上游 API 客户端：设备授权登录 / 额度 / 领取 / 模型目录 / captcha 配置。
 *
 * 全部判据来自参考实现的实测：
 * - 登录三段式：`POST oauth/cli/init`（Bearer 是**我们自己生成的会话密钥**）→
 *   浏览器完成授权 → `GET oauth/cli/poll/{id}` 拿 `token` / `user.user_id` / `bigmodel.access_token`；
 * - `device_mid` 自己生成即可（服务端不绑定校验，只需稳定）；
 * - captcha 配置要 `platform=unknown`（`win32`/`windows`/… 一律 400 code 3001）；
 * - 领取前必须补 `app_launch` + `app_daily_active` 上报，否则 preview 恒为空；
 * - `1003` = 已领取过，是**幂等成功**而不是错误。
 */

import {
  ZCODE_BILLING_BALANCE_URL,
  ZCODE_BILLING_CLAIM_URL,
  ZCODE_CLIENT_CONFIGS_URL,
  ZCODE_EVENT_REPORT_URL,
  ZCODE_MARKETING_TOUCH_URL,
  ZCODE_OAUTH_CLI_INIT_URL,
  ZCODE_ORIGIN,
  ZCODE_APP_VERSION_FALLBACK,
  buildZcodeHeaders,
  generateDeviceMid,
  nextUtc8DayStartMs,
  toEpochMs,
  zcodeOauthCliPollUrl,
} from './upstream.js'

/** 登录渠道（默认国内站）。 */
export const ZCODE_LOGIN_PROVIDER = 'bigmodel'

/**
 * 两条登录渠道（实测，2026-10-23）。
 *
 * 两者**共用同一套设备授权协议**（同一个 `/api/v1/oauth/cli/init` 与 `poll/{id}`、
 * 相同的响应形状），只在 `provider` 参数与授权站点上不同：
 *
 * | provider | 站点 | authorize_url | 适用 |
 * |---|---|---|---|
 * | `bigmodel` | 国内 智谱 | `bigmodel.cn/login?appId=zcode&redirect=…/callback/bigmodel` | 国内账号 |
 * | `zai` | 国际 Z.AI | `chat.z.ai/api/oauth/authorize?client_id=…&redirect_uri=…/callback/zai` | 国际账号 |
 *
 * ⚠ 非法值会返回 **HTTP 500 `{"code":1000,"msg":"something went wrong"}`**
 * （实测 `z-ai` / `bigmodel-intl` 均如此）—— 所以这里做白名单，不做"猜"。
 */
export const LOGIN_CHANNELS = Object.freeze({
  bigmodel: Object.freeze({
    provider: 'bigmodel',
    aliases: Object.freeze(['bigmodel', 'cn', 'china', 'domestic', '智谱', '国内']),
    label: '智谱（国内站）',
    site: 'bigmodel.cn',
    apiKeyUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
    accountSettingUrl: 'https://bigmodel.cn/',
  }),
  zai: Object.freeze({
    provider: 'zai',
    aliases: Object.freeze(['zai', 'z-ai', 'intl', 'international', 'global', 'global站', '国际', '海外']),
    label: 'Z.AI（国际站）',
    site: 'z.ai',
    apiKeyUrl: 'https://z.ai/manage-apikey/apikey-list',
    accountSettingUrl: 'https://chat.z.ai/',
  }),
})

/** 默认渠道。 */
export const DEFAULT_LOGIN_CHANNEL = 'bigmodel'

/**
 * 把用户输入的渠道名（含别名/中文）归一成 `bigmodel` 或 `zai`。
 *
 * @param {string | undefined | null} input
 * @returns {'bigmodel' | 'zai'}
 */
export function normalizeLoginChannel(input) {
  const needle = String(input ?? '').trim().toLowerCase()
  if (needle.length === 0) return DEFAULT_LOGIN_CHANNEL
  for (const [id, channel] of Object.entries(LOGIN_CHANNELS)) {
    if (id === needle) return /** @type {'bigmodel' | 'zai'} */ (id)
    if (channel.aliases.some((alias) => alias.toLowerCase() === needle)) return /** @type {'bigmodel' | 'zai'} */ (id)
  }
  return DEFAULT_LOGIN_CHANNEL
}

/** 取渠道描述（未知值回退默认）。 */
export function resolveLoginChannel(input) {
  return LOGIN_CHANNELS[normalizeLoginChannel(input)]
}

/** 一次登录尝试的失败原因（人类可读）。 */
export class ZcodeLoginError extends Error {
  constructor(message, kind) {
    super(message)
    this.name = 'ZcodeLoginError'
    this.kind = kind
  }
}

/** fetch + 超时包装（外部输入必须有上限）。 */
async function fetchWithTimeout(fetchImpl, input, init, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

/**
 * 发起登录：立刻拿到 `authorize_url`。
 *
 * ⚠ 授权 URL 必须**立刻**返回（浏览器 `window.open` 只在用户手势窗口内有效）。
 *
 * @param {typeof fetch} [fetchImpl]
 * @param {{ appVersion?: string, provider?: string, channel?: string }} [options]
 *   `channel` 是友好名（`cn`/`intl`/`国内`/`国际` 都认），`provider` 是原始值。
 *   两者都给时 `provider` 优先（保持向后兼容）。
 */
export async function startZcodeLogin(fetchImpl = globalThis.fetch, options = {}) {
  const flowSecret = globalThis.crypto.randomBytes ? globalThis.crypto.randomBytes(32).toString('hex') : fallbackSecret()
  const appVersion = options.appVersion ?? ZCODE_APP_VERSION_FALLBACK
  const provider = options.provider ?? resolveLoginChannel(options.channel).provider

  let response
  try {
    response = await fetchImpl(ZCODE_OAUTH_CLI_INIT_URL, {
      method: 'POST',
      headers: {
        /** ⚠ 这里的 Bearer 是**我们自己生成的会话密钥**，不是用户凭据。 */
        Authorization: `Bearer ${flowSecret}`,
        'Content-Type': 'application/json',
        'User-Agent': `ZCode/${appVersion}`,
        'HTTP-Referer': ZCODE_ORIGIN,
        'X-ZCode-App-Version': appVersion,
        'X-Platform': 'win32',
      },
      body: JSON.stringify({ provider }),
      signal: AbortSignal.timeout(30_000),
    })
  } catch (error) {
    throw new ZcodeLoginError(
      `无法连接 ZCode 授权服务：${error instanceof Error ? error.message : String(error)}`,
      'init',
    )
  }

  const text = await response.text().catch(() => '')
  if (!response.ok) {
    /**
     * 非法 provider 会返回 500 code=1000（"something went wrong"）—— 把这句话翻译成
     * 可操作的原因，避免用户以为服务挂了。
     */
    const hint = /code"?\s*:\s*1000/.test(text) || response.status === 500
      ? `；渠道「${provider}」可能不被支持（合法值：bigmodel=国内、zai=国际）`
      : ''
    throw new ZcodeLoginError(`授权初始化失败（HTTP ${response.status}${hint}）：${text.slice(0, 200)}`, 'init')
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new ZcodeLoginError(`授权初始化响应不是 JSON：${text.slice(0, 200)}`, 'init')
  }
  const data = parsed.data
  const flowId = data?.flow_id
  const authorizeUrl = data?.authorize_url
  if (typeof flowId !== 'string' || flowId.length === 0) {
    throw new ZcodeLoginError(`授权初始化响应缺 flow_id：${typeof parsed.msg === 'string' ? parsed.msg : text.slice(0, 160)}`, 'init')
  }
  if (typeof authorizeUrl !== 'string' || !authorizeUrl.startsWith('https://')) {
    throw new ZcodeLoginError('授权初始化响应缺合法的 authorize_url', 'init')
  }
  /** ⚠ 服务端给的是**秒级**时间戳，必须归一再与毫秒比较。 */
  const expiresAt = toEpochMs(typeof data?.expires_at === 'number' ? data.expires_at : 0)
  const rawInterval = typeof data?.poll_interval_sec === 'number' ? data.poll_interval_sec : 2
  const pollIntervalSec = Number.isFinite(rawInterval) && rawInterval >= 1 ? rawInterval : 2
  return { flowId, authorizeUrl, expiresAt, pollIntervalSec, flowSecret }
}

function fallbackSecret() {
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * 轮询一次。
 *
 * ⚠ 网络抖动**不算失败**（返回 pending 让调用方继续轮询）；
 * HTTP 4xx（除 408/429）才是终态失败；5xx 与网络错误继续重试。
 */
export async function pollZcodeLogin(flow, fetchImpl = globalThis.fetch, appVersion = ZCODE_APP_VERSION_FALLBACK) {
  let response
  try {
    response = await fetchImpl(zcodeOauthCliPollUrl(flow.flowId), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${flow.flowSecret}`,
        'User-Agent': `ZCode/${appVersion}`,
        'HTTP-Referer': ZCODE_ORIGIN,
        'X-ZCode-App-Version': appVersion,
      },
      signal: AbortSignal.timeout(20_000),
    })
  } catch {
    return { kind: 'pending' }
  }

  if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
    const text = await response.text().catch(() => '')
    return { kind: 'failed', message: `轮询被拒（HTTP ${response.status}）：${text.slice(0, 200)}` }
  }
  if (!response.ok) return { kind: 'pending' }

  let parsed
  try {
    parsed = await response.json()
  } catch {
    return { kind: 'pending' }
  }
  const data = parsed.data
  if (parsed.code !== 0 || data === undefined || data === null) return { kind: 'pending' }
  const status = typeof data.status === 'string' ? data.status : undefined
  if (status === 'pending') return { kind: 'pending' }
  if (status === 'failed') return { kind: 'failed', message: '用户拒绝了授权或授权失败' }
  if (status !== 'ready') return { kind: 'failed', message: `轮询响应状态无法识别：${String(status)}` }

  /**
   * 容错取值：**两条渠道的字段名不完全一致**（国际站 z.ai 实测不返回
   * `bigmodel.access_token` 之外的同构字段，且 `user_id` 可能落在别的键上）。
   *
   * 判据只看**推理必需**的那两样：`zcode_jwt` 与 `user_id`。
   * `access_token` 是可选的备用身份 —— 缺了不该让登录失败（此前正是因为
   * 把它当成必需字段，国际站授权完成后直接报「缺关键字段」）。
   */
  const pick = (...values) => values.find((value) => typeof value === 'string' && value.length > 0)

  const zcodeJwt = pick(data.token, data.access_token, data.accessToken)
  const userId = pick(data.user?.user_id, data.user?.id, data.user_id, data.userId, data.uid)
  const bigmodelAccessToken = pick(
    data.bigmodel?.access_token,
    data.bigmodel?.accessToken,
    data.bigmodel_access_token,
  )

  if (zcodeJwt === undefined) {
    /**
     * 拿不到 JWT 就真的无法推理 —— 但要把「服务端到底给了什么键」报出来，
     * 否则排查只能靠猜（本次国际站的坑就是这样踩到的）。
     */
    const keys = Object.keys(data ?? {}).join(', ') || '(空)'
    return { kind: 'failed', message: `轮询响应里没有 token（实际字段：${keys}）` }
  }
  if (userId === undefined) {
    /** 没有 user_id 只影响「按账号去重」，不阻塞入池。 */
    return {
      kind: 'ready',
      result: {
        zcodeJwt,
        userId: zcodeJwt.slice(-12),
        displayName: pick(data.user?.name, data.user?.email, data.account?.name) ?? '未命名账号',
        bigmodelAccessToken: bigmodelAccessToken ?? '',
        note: '响应未返回 user_id，已用 JWT 尾段临时作账号标识（无法按账号去重）',
      },
    }
  }

  const displayName =
    pick(data.user?.name, data.user?.email, data.user?.username, data.account?.name) ?? userId
  return { kind: 'ready', result: { zcodeJwt, userId, displayName, bigmodelAccessToken: bigmodelAccessToken ?? '' } }
}

/**
 * 两段式登录：立即返回授权 URL，授权完成由 `result` 兑现。
 *
 * @param {{ fetchImpl?: typeof fetch, appVersion?: string, signal?: AbortSignal, now?: () => number, sleep?: (ms: number) => Promise<void>, channel?: string, provider?: string }} [options]
 */
export async function beginZcodeLogin(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const appVersion = options.appVersion ?? ZCODE_APP_VERSION_FALLBACK
  const now = options.now ?? (() => Date.now())
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  }))
  const channelId = normalizeLoginChannel(options.provider ?? options.channel)

  const flow = await startZcodeLogin(fetchImpl, { appVersion, channel: channelId })
  const result = (async () => {
    const deadline = flow.expiresAt > 0 ? flow.expiresAt : now() + 600_000
    for (;;) {
      if (options.signal?.aborted === true) throw new ZcodeLoginError('登录已取消', 'cancelled')
      if (now() >= deadline) throw new ZcodeLoginError('授权超时（请重新发起登录）', 'timeout')
      const outcome = await pollZcodeLogin(flow, fetchImpl, appVersion)
      if (outcome.kind === 'ready') {
        return {
          zcode_jwt: outcome.result.zcodeJwt,
          /** ⚠ 自己生成（服务端不绑定校验）；生成后持久化，登录一次即固定。 */
          device_mid: generateDeviceMid(),
          user_id: outcome.result.userId,
          bigmodel_access_token: outcome.result.bigmodelAccessToken,
          account_label: outcome.result.displayName,
          app_version: appVersion,
          /** 记下这条凭据来自哪条渠道（国内/国际），便于状态展示与排查。 */
          login_channel: channelId,
          source: 'plugin',
        }
      }
      if (outcome.kind === 'failed') throw new ZcodeLoginError(outcome.message, 'denied')
      await sleep(Math.max(1, flow.pollIntervalSec) * 1_000)
    }
  })()
  return { loginUrl: flow.authorizeUrl, result, channel: LOGIN_CHANNELS[channelId] }
}

/**
 * 查余额。
 *
 * ⚠ `Authorization` 必需（缺则 401）；`X-Device-Mid` 也必需（缺则 400 code 3001）。
 * 企业版不下发额度数字（`displayMode: "enterprise"`）—— 返回 `{enterprise:true}`，
 * **不要**显示成 0（0 是「已用光」的语义）。
 */
export async function fetchBalance(credential, fetchImpl = globalThis.fetch) {
  const response = await fetchWithTimeout(fetchImpl, ZCODE_BILLING_BALANCE_URL, {
    method: 'GET',
    headers: buildZcodeHeaders(credential, { authorization: `Bearer ${credential.zcode_jwt}` }),
  }, 30_000)
  if (!response.ok) return undefined
  let parsed
  try {
    parsed = await response.json()
  } catch {
    return undefined
  }
  const data = parsed.data
  if (data === undefined) return undefined
  if (typeof data.displayMode === 'string' && data.displayMode === 'enterprise') {
    return { enterprise: true, buckets: [], remaining: 0, total: 0 }
  }
  const buckets = []
  for (const item of Array.isArray(data.balances) ? data.balances : []) {
    if (typeof item !== 'object' || item === null) continue
    buckets.push({
      planId: typeof item.plan_id === 'string' ? item.plan_id : undefined,
      showName: typeof item.show_name === 'string' ? item.show_name : undefined,
      unitType: typeof item.unit_type === 'string' ? item.unit_type : undefined,
      totalUnits: num(item.total_units),
      usedUnits: num(item.used_units),
      remainingUnits: num(item.remaining_units),
      availableUnits: num(item.available_units),
      /**
       * ⚠ 上游给的是**秒级**，统一归一到毫秒（与 `pending[].effectiveAt` 同单位）。
       * 不归一会让 `new Date(x)` 落到 1970 年 —— 界面上就是「1970/1/21 到期」。
       */
      expiresAt: toEpochMs(num(item.expires_at) ?? 0),
    })
  }
  /**
   * 未生效的**计划权益**（pending entitlements）。
   *
   * 上游把「已领但还没到点」的额度放在 `plans[].entitlements[]`：
   * `balances` 只列**当前生效**的桶 —— 一个 23 点启用的 3 亿 token 包在 22 点的
   * `balances` 里不存在，于是面板显示 0/0，用户以为领取失败（2026-10-26 实测）。
   * 判据：`effective_at`（秒级）在 `server_time`（缺省取本地现在）之后，
   * 且 `grant_units` 为正数。已生效的 entitlement 不收（balances 已覆盖）。
   */
  const serverNowMs = toEpochMs(num(data.server_time) ?? 0) || Date.now()
  const pending = []
  for (const plan of Array.isArray(data.plans) ? data.plans : []) {
    if (typeof plan !== 'object' || plan === null) continue
    for (const item of Array.isArray(plan.entitlements) ? plan.entitlements : []) {
      if (typeof item !== 'object' || item === null) continue
      const effectiveAtMs = toEpochMs(num(item.effective_at) ?? 0)
      const grantUnits = num(item.grant_units)
      if (effectiveAtMs === 0 || !(grantUnits > 0) || effectiveAtMs <= serverNowMs) continue
      /** 未生效权益的到期时间 = 所属 plan 的 `ends_at`（整份 plan 一起作废）。 */
      const planEndsAtMs = toEpochMs(num(plan.ends_at) ?? 0)
      pending.push({
        planId: typeof plan.plan_id === 'string' ? plan.plan_id : undefined,
        showName: typeof item.show_name === 'string' ? item.show_name : undefined,
        unitType: typeof item.unit_type === 'string' ? item.unit_type : undefined,
        grantUnits,
        effectiveAt: effectiveAtMs,
        ...(planEndsAtMs > 0 ? { expiresAt: planEndsAtMs } : {}),
      })
    }
  }
  pending.sort((a, b) => a.effectiveAt - b.effectiveAt)
  let remaining = 0
  let total = 0
  for (const bucket of buckets) {
    const available = bucket.availableUnits ?? bucket.remainingUnits ?? 0
    remaining += available
    total += bucket.totalUnits ?? 0
  }
  /**
   * 有余额的桶按到期时间升序（面板逐桶画条，每桶带自己的到期时间；
   * 空桶沉底）。顶层 `expiresAt` 保留为「最早到期」的快捷值，兼容旧面板。
   */
  const active = buckets
    .filter((bucket) => (bucket.availableUnits ?? bucket.remainingUnits ?? 0) > 0)
    .sort((a, b) => (a.expiresAt || Infinity) - (b.expiresAt || Infinity))
  const empty = buckets.filter((bucket) => (bucket.availableUnits ?? bucket.remainingUnits ?? 0) <= 0)
  const ordered = [...active, ...empty]
  let expiresAt
  for (const bucket of active) {
    if (Number.isFinite(bucket.expiresAt) && bucket.expiresAt > 0) {
      expiresAt = bucket.expiresAt
      break
    }
  }
  return {
    buckets: ordered,
    remaining,
    total,
    ...(pending.length > 0 ? { pending } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(buckets[0]?.showName !== undefined ? { planName: buckets[0].showName } : {}),
  }
}

/** 补客户端活跃信号（不补则 preview 恒为空 plans）。 */
export async function reportActivation(credential, fetchImpl = globalThis.fetch) {
  const appVersion = credential.app_version ?? ZCODE_APP_VERSION_FALLBACK
  /** 两个事件相互独立，并行上报（省一个 RTT；失败不阻塞，下次调用会再补）。 */
  await Promise.all(['app_launch', 'app_daily_active'].map((event) =>
    fetchWithTimeout(fetchImpl, ZCODE_EVENT_REPORT_URL, {
      method: 'POST',
      headers: buildZcodeHeaders(credential, { json: true }),
      body: JSON.stringify({ event, device_mid: credential.device_mid, platform: 'win32', app_version: appVersion }),
    }, 20_000).catch(() => {}),
  ))
}

/**
 * 查当前可领的活动（priority 降序）。
 *
 * ## ⚠ 端点语义变更（0.6.0，来自 ZCode 客户端 3.16.3 反编译实证）
 *
 * `/billing/preview` **恒空**（官方客户端全天 0 次调用它），活动发现的真实来源是
 * **营销投放**：`GET /api/v1/marketing/touch?seq=<n>`（官方 `createMarketingTouchService`
 * 的 `query()`，约 10 分钟一次）。响应里的 banner/popup 按钮携带
 * `{type:"claim_zcode_plan", args:{plan_id}}` —— plan_id 就从这里来：
 *
 * ```
 * marketing/touch（GET，无需 captcha）→ 按钮里的 plan_id → billing/claim（POST，需 captcha）
 * ```
 *
 * 响应形状（`parseMarketingTouchResponse` 实测）：
 * `{code:0, data:{server_time, language, deliveries:[{campaign_id, priority,
 *   resource_position:"banner"|"popup", banner|popup:{buttons:[{action:{type,args}}]}}]}}`
 *
 * ⚠ 需要 `X-Client-Language: zh-CN`（服务端按语言过滤投放，缺省可能返回空 deliveries）；
 * `Authorization` 可选（营销是设备级的，但带上无害且与官方一致）。
 * 解析失败一律返回 `[]` —— 投放接口抖动不该让领取流程崩掉。
 * @param {any} credential
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<Array<{ planId: string, campaignId?: string, priority: number, name?: string }>>}
 */
export async function fetchClaimablePlans(credential, fetchImpl = globalThis.fetch) {
  const appVersion = credential.app_version ?? ZCODE_APP_VERSION_FALLBACK
  /** seq 是客户端自增的请求序号（官方从 0 起），服务端只用于排序/去重观测。 */
  const url = `${ZCODE_MARKETING_TOUCH_URL}?seq=0`
  let parsed
  try {
    const response = await fetchWithTimeout(fetchImpl, url, {
      method: 'GET',
      headers: buildZcodeHeaders(credential, {
        authorization: `Bearer ${credential.zcode_jwt}`,
        json: false,
        extra: { 'X-Client-Language': 'zh-CN' },
      }),
    }, 15_000)
    if (!response.ok) return []
    parsed = await response.json().catch(() => undefined)
  } catch {
    return []
  }
  const raw = Array.isArray(parsed?.data?.deliveries) ? parsed.data.deliveries : []
  /** 每个投放位的按钮里找 claim_zcode_plan action；同 planId 去重、按 priority 降序。 */
  const seen = new Map()
  for (const delivery of raw) {
    if (typeof delivery !== 'object' || delivery === null) continue
    const campaignId = typeof delivery.campaign_id === 'string' ? delivery.campaign_id : undefined
    const priority = typeof delivery.priority === 'number' ? delivery.priority : 0
    const position = delivery.resource_position === 'popup' ? delivery.popup : delivery.banner
    const buttons = Array.isArray(position?.buttons) ? position.buttons : []
    for (const button of buttons) {
      const action = button?.action
      if (action?.type !== 'claim_zcode_plan') continue
      const planId = typeof action.args?.plan_id === 'string' ? action.args.plan_id.trim() : ''
      if (planId.length === 0) continue
      const label = typeof button?.text?.content === 'string' ? button.text.content.trim() : ''
      const existing = seen.get(planId)
      if (existing === undefined || priority > existing.priority) {
        seen.set(planId, { planId, ...(campaignId !== undefined ? { campaignId } : {}), priority, ...(label.length > 0 ? { name: label } : {}) })
      }
    }
  }
  return [...seen.values()].sort((a, b) => b.priority - a.priority)
}

/**
 * 上报营销投放按钮的点击结果（官方点击 claim 按钮后会 POST confirm/cancel）。
 * 纯统计用途：失败静默吞掉，绝不影响领取本身。
 */
export async function reportMarketingAction(credential, campaignId, actionType, fetchImpl = globalThis.fetch) {
  if (typeof campaignId !== 'string' || campaignId.length === 0) return
  if (actionType !== 'confirm' && actionType !== 'cancel') return
  try {
    await fetchWithTimeout(fetchImpl, ZCODE_MARKETING_TOUCH_URL.replace(/\/touch$/, '/touch/action'), {
      method: 'POST',
      headers: buildZcodeHeaders(credential, { authorization: `Bearer ${credential.zcode_jwt}`, json: true }),
      body: JSON.stringify({ campaign_id: campaignId, action_type: actionType }),
    }, 15_000).catch(() => {})
  } catch {
    // 统计上报，失败无关紧要。
  }
}

/**
 * 领取一个 plan。
 *
 * ⚠ captcha **一次性**：每个 plan 都必须重新 mint（复用同一个会得 3007）。
 * ⚠ `1003` = 已领取过，是**幂等成功**而不是错误。
 */
export async function claimPlan(credential, planId, captcha, fetchImpl = globalThis.fetch) {
  let response
  try {
    response = await fetchWithTimeout(fetchImpl, ZCODE_BILLING_CLAIM_URL, {
      method: 'POST',
      headers: buildZcodeHeaders(credential, { authorization: `Bearer ${credential.zcode_jwt}`, captcha }),
      body: JSON.stringify({ plan_id: planId }),
    }, 60_000)
  } catch (error) {
    return { planId, ok: false, message: error instanceof Error ? error.message : String(error) }
  }
  const text = await response.text().catch(() => '')
  let code
  let message
  try {
    const parsed = JSON.parse(text)
    code = num(parsed.code)
    message = typeof parsed.msg === 'string' ? parsed.msg : typeof parsed.message === 'string' ? parsed.message : undefined
  } catch {
    message = text.slice(0, 200)
  }
  const alreadyClaimed = code === 1003
  return {
    planId,
    ...(code !== undefined ? { code } : {}),
    ok: response.ok && (code === 0 || alreadyClaimed),
    ...(alreadyClaimed ? { alreadyClaimed } : {}),
    httpStatus: response.status,
    ...(message !== undefined ? { message } : {}),
  }
}

/**
 * `GET /api/v1/client/configs` 的共享缓存（60s TTL，仅缓存成功结果 + in-flight 去重）。
 *
 * captcha 配置与模型目录**是同一端点的两个字段**，此前两条链路各打一次且缓存
 * 互相独立 —— 这里统一成一次请求、一份缓存。缓存键带上 `zcode_jwt` 与
 * `fetchImpl` 身份：不同账号不串味；测试里逐个注入的 mock fetch 也不互相污染。
 * **失败不缓存**（一次网络抖动不该把 sceneId 固化 60 秒）。
 */
const CLIENT_CONFIGS_CACHE_MS = 60_000
const clientConfigsCache = new Map()
const clientConfigsInflight = new Map()

/** 拉一次 client/configs 原文（不缓存）；非 2xx / 网络错误 → undefined。 */
async function fetchClientConfigsOnce(credential, fetchImpl) {
  const appVersion = credential.app_version ?? ZCODE_APP_VERSION_FALLBACK
  const url = `${ZCODE_CLIENT_CONFIGS_URL}?app_version=${encodeURIComponent(appVersion)}&platform=unknown`
  try {
    const response = await fetchWithTimeout(fetchImpl, url, {
      method: 'GET',
      headers: buildZcodeHeaders(credential, { authorization: `Bearer ${credential.zcode_jwt}`, json: false }),
    }, 20_000)
    if (!response.ok) return undefined
    return await response.json()
  } catch {
    return undefined
  }
}

/** 共享入口：命中缓存或复用在途请求；失败（undefined）不写缓存。 */
function fetchClientConfigs(credential, fetchImpl) {
  /**
   * 缓存/in-flight 去重只对**全局 fetch** 生效：注入的 fetchImpl 几乎都是测试
   * mock，没有稳定可区分的身份标识，按函数名拼 key 会串味 —— 直接透传。
   */
  if (fetchImpl !== globalThis.fetch) return fetchClientConfigsOnce(credential, fetchImpl)
  const key = String(credential?.zcode_jwt ?? '')
  const hit = clientConfigsCache.get(key)
  if (hit !== undefined && Date.now() - hit.at < CLIENT_CONFIGS_CACHE_MS) return hit.promise
  const pending = clientConfigsInflight.get(key)
  if (pending !== undefined) return pending
  const promise = fetchClientConfigsOnce(credential, fetchImpl).then((parsed) => {
    clientConfigsInflight.delete(key)
    if (parsed !== undefined) clientConfigsCache.set(key, { at: Date.now(), promise: Promise.resolve(parsed) })
    return parsed
  })
  clientConfigsInflight.set(key, promise)
  return promise
}

/**
 * 拉服务端下发的 captcha 配置（60 秒 TTL，失败返回 undefined 由调用方回退兜底值）。
 *
 * ⚠ `platform` 必须是 **`unknown`**（实测 win32/win64/windows/electron/desktop/linux 一律 400 code 3001）。
 */
export async function fetchCaptchaConfig(credential, fetchImpl = globalThis.fetch) {
  const parsed = await fetchClientConfigs(credential, fetchImpl)
  if (parsed === undefined) return undefined
  const captcha = parsed.data?.configs?.captcha
  if (captcha === undefined) return undefined
  const { region, prefix, sceneId } = captcha
  if (typeof region !== 'string' || typeof prefix !== 'string' || typeof sceneId !== 'string') return undefined
  return { region, prefix, sceneId }
}

/**
 * 从上游拉模型目录（含上下文窗口、最大输出、思考档位、视觉能力）。
 *
 * ⚠ `builtinModels` 是**对象**（键为序号）；用 Array.isArray 判定会得到假阴性。
 * ⚠ `reasoning.levels` 的键序不是展示序：必须显式排序。
 */
export async function fetchModels(credential, fetchImpl = globalThis.fetch) {
  const parsed = await fetchClientConfigs(credential, fetchImpl)
  if (parsed === undefined) return undefined
  const raw = parsed.data?.builtinModels
  if (typeof raw !== 'object' || raw === null) return undefined
  const entries = Array.isArray(raw) ? raw : Object.values(raw)
  const models = []
  for (const item of entries) {
    if (typeof item !== 'object' || item === null) continue
    const id = item.modelId ?? item.id
    if (typeof id !== 'string' || id.length === 0) continue
    const contextWindow = num(item.contextWindow)
    const maxCompletionTokens = num(item.maxCompletionTokens ?? item.maxTokens)
    const vision = typeof item.capabilities === 'object' && item.capabilities !== null ? item.capabilities.vision === true : false
    let reasoningLevels
    let defaultReasoningLevel
    if (typeof item.reasoning === 'object' && item.reasoning !== null) {
      const levels = item.reasoning.levels
      if (typeof levels === 'object' && levels !== null) {
        const keys = Object.keys(levels)
        if (keys.length > 0) reasoningLevels = orderReasoningLevels(keys)
      }
      if (typeof item.reasoning.defaultLevel === 'string' && item.reasoning.defaultLevel.length > 0) {
        defaultReasoningLevel = item.reasoning.defaultLevel
      }
    }
    models.push({
      id,
      name: typeof item.name === 'string' && item.name.length > 0 ? item.name : id,
      contextWindow: contextWindow !== undefined && contextWindow > 0 ? contextWindow : 200_000,
      maxTokens: maxCompletionTokens !== undefined && maxCompletionTokens > 0 ? maxCompletionTokens : 32_768,
      supportsImage: vision,
      ...(reasoningLevels !== undefined ? { reasoningLevels } : {}),
      ...(defaultReasoningLevel !== undefined ? { defaultReasoningLevel } : {}),
    })
  }
  return models.length > 0 ? models : undefined
}

/** 把档位键排成展示序（不能直接用 JSON 键序）。 */
export function orderReasoningLevels(keys) {
  const order = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  const known = order.filter((level) => keys.includes(level))
  const unknown = keys.filter((key) => !order.includes(key))
  return [...known, ...unknown]
}

export { nextUtc8DayStartMs }
