/**
 * 上游协议常量与请求头构造。
 *
 * 全部取自参考实现 bonus-plan-4-open-zcode（`src/pool/upstream.ts`）的实测结论：
 *
 * | 端点 | 需要 Authorization | 需要 X-Device-Mid |
 * |---|---|---|
 * | GET  /api/v1/zcode-plan/billing/balance | 是（缺则 401） | 是（缺则 400 code 3001） |
 * | GET  /api/v1/zcode-plan/billing/preview   | 否 | 是 |
 * | POST /api/v1/event/report                 | 否 | 是 |
 * | POST /api/v1/zcode-plan/billing/claim     | 是 | 是（另需 captcha 头） |
 * | GET  /api/v1/client/configs               | 是 | 是 |
 * | POST /api/v1/zcode-plan/anthropic/v1/messages | 是（Bearer zcode_jwt） | 是（captcha 视情况） |
 */

import { release as osRelease } from 'node:os'

/** ZCode 平台 origin。 */
export const ZCODE_ORIGIN = 'https://zcode.z.ai'

/** 免费额度通道的 Anthropic Messages 端点（推理主链路）。 */
export const ZCODE_PLAN_MESSAGES_URL = `${ZCODE_ORIGIN}/api/v1/zcode-plan/anthropic/v1/messages`

/** 额度余额。 */
export const ZCODE_BILLING_BALANCE_URL = `${ZCODE_ORIGIN}/api/v1/zcode-plan/billing/balance`

/** 每日赠送来源（0.8.0 双来源合并：每日包只在这里，1024 类活动只在 marketing/touch）。 */
export const ZCODE_BILLING_PREVIEW_URL = `${ZCODE_ORIGIN}/api/v1/zcode-plan/billing/preview`

/**
 * 营销投放查询（活动发现的真实来源，0.6.0）。
 *
 * 官方 `createMarketingTouchService`（3.16.3 反编译实证）：
 * `GET /api/v1/marketing/touch?seq=<n>`，响应的 banner/popup 按钮携带
 * `{type:"claim_zcode_plan", args:{plan_id}}`；点击后
 * `POST /api/v1/marketing/touch/action`（`{campaign_id, action_type}`）。
 */
export const ZCODE_MARKETING_TOUCH_URL = `${ZCODE_ORIGIN}/api/v1/marketing/touch`

/** 领取活动（需要 Authorization + 一次性 captcha）。 */
export const ZCODE_BILLING_CLAIM_URL = `${ZCODE_ORIGIN}/api/v1/zcode-plan/billing/claim`

/** 客户端活跃上报（不补则 preview 恒为空 plans）。 */
export const ZCODE_EVENT_REPORT_URL = `${ZCODE_ORIGIN}/api/v1/event/report`

/** 客户端配置（captcha 配置 + 模型池）。 */
export const ZCODE_CLIENT_CONFIGS_URL = `${ZCODE_ORIGIN}/api/v1/client/configs`

/** 设备授权流：发起。 */
export const ZCODE_OAUTH_CLI_INIT_URL = `${ZCODE_ORIGIN}/api/v1/oauth/cli/init`

/** 设备授权流：轮询。 */
export const zcodeOauthCliPollUrl = (flowId) =>
  `${ZCODE_ORIGIN}/api/v1/oauth/cli/poll/${encodeURIComponent(flowId)}`

/** 客户端版本兜底值（官方 3.14.3 时代的取值；服务端只当展示/统计用）。 */
export const ZCODE_APP_VERSION_FALLBACK = '3.14.3'

/**
 * 构造 ZCode 的来源标识请求头。
 *
 * ## ★ 这些头的值以官方客户端的真实抓包为准（0.8.0 对齐参考实现）
 *
 * 官方 GUI 的一次 `/v1/messages` 带 **18 个头**。此前只发 10 个，且两个值不符：
 * `x-release-channel`（官方 `production`，我们发 `stable`）、`x-platform`
 * （官方 `win32-x64`，我们发 `win32`），并缺 7 个官方每次都带的头：
 * `x-title` / `x-os-version` / `x-zcode-agent` / `x-session-id` /
 * `x-zcode-session-type` / `x-request-id` / `x-zcode-trace-id`。
 * 2026-10-23 上游升级 3.16.3 后 `405 unusual activity` 稳定出现（跨账号跨会话）
 * 而官方客户端正常 ⇒ 头的形状是首要指纹，逐字对齐。
 *
 * ⚠ 会话 id **每账号一个、进程内稳定**（官方每会话一个 uuid；插件没有会话层，
 * 退而求其次按 device_mid 复用 —— 比每请求换新更接近真实客户端。⚠ 不能做成
 * 模块级常量：那样池里所有账号共用一个 session id，上游会把多账号轮换关联成
 * 「同一会话」—— 没有任何真实客户端会产出这种关联）。
 * ⚠ `X-Request-Id` / `X-ZCode-Trace-Id` 每请求新 UUID（官方语义）。
 * ⚠ `X-Device-Mid` 是 billing/* 与推理端点的硬需求（缺则 400 code 3001），
 * 但**不是账号标识**：同一账号重新登录会换一个，去重必须用 `user_id`。
 *
 * @param {{ device_mid: string, app_version?: string }} credential 凭据（或任何带 device_mid 的对象）
 * @param {{ authorization?: string, json?: boolean, captcha?: { param: string, region: string }, extra?: Record<string,string>, authHeader?: string, appVersion?: string }} [options]
 * @returns {Record<string, string>}
 */

/** 每账号一个、进程内稳定的伪会话 id（首见生成，复用）。 */
const ZCODE_SESSION_IDS = new Map()
function zcodeSessionId(deviceMid) {
  const key = typeof deviceMid === 'string' ? deviceMid : ''
  const existing = ZCODE_SESSION_IDS.get(key)
  if (existing !== undefined) return existing
  const created = globalThis.crypto.randomUUID()
  ZCODE_SESSION_IDS.set(key, created)
  return created
}

export function buildZcodeHeaders(credential, options = {}) {
  /**
   * `appVersion` 覆盖（0.8.0）：**只有实测过版本门控的两条路径**（marketing /
   * claim）才显式传 `zcodeVersionGatedAppVersion(credential)`；其余请求用凭据版本。
   * ⚠ 覆盖只影响本次请求头，**不得**改凭据本身。
   */
  const appVersion = options.appVersion ?? credential.app_version ?? ZCODE_APP_VERSION_FALLBACK
  /** 平台三件套（win32 宿主取真值；本插件只跑在 DSH 桌面端 = win32）。 */
  const osVersion = osRelease()
  /** @type {Record<string, string>} */
  const headers = {
    'User-Agent': `ZCode/${appVersion}`,
    'HTTP-Referer': ZCODE_ORIGIN,
    'X-Title': 'Z Code@electron',
    'X-ZCode-App-Version': appVersion,
    'X-Release-Channel': 'production',
    'X-Client-Language': 'zh-CN',
    'X-Client-Timezone': 'Asia/Shanghai',
    'X-Device-Mid': credential.device_mid,
    'X-Platform': 'win32-x64',
    'X-Os-Category': 'windows',
    'X-Os-Version': osVersion,
    'X-ZCode-Agent': 'glm',
    'X-Session-Id': zcodeSessionId(credential.device_mid),
    'X-ZCode-Session-Type': 'other',
    'X-Request-Id': globalThis.crypto.randomUUID(),
    'X-ZCode-Trace-Id': globalThis.crypto.randomUUID(),
    'anthropic-version': '2023-06-01',
  }
  if (options.json !== false) headers['Content-Type'] = 'application/json'
  if (options.authorization !== undefined) headers['Authorization'] = options.authorization
  if (options.authHeader !== undefined) headers['Authorization'] = options.authHeader
  if (options.captcha !== undefined) {
    headers['x-aliyun-captcha-verify-param'] = options.captcha.param
    headers['x-aliyun-captcha-verify-region'] = options.captcha.region
  }
  if (options.extra !== undefined) Object.assign(headers, options.extra)
  return headers
}

/** 生成自用的稳定设备标识。 */
export function generateDeviceMid() {
  return globalThis.crypto.randomUUID()
}

/**
 * 受版本门控的请求该用的 `app_version`：**凭据里的版本与最低版本取较大者**。
 *
 * ⚠ 实测门控（参考实现 deepseek-harness-codearts，真机一发定音）：
 * - `GET /marketing/touch`：`3.14.3` → `deliveries: []`（**投放为空**，与「没活动」同形）；
 * - `POST /billing/claim`：`3.14.3` → `400 / code 1004 "no permission"`
 *   （官方文案「当前账号或**客户端版本**不满足领取条件」—— 极易误判成账号没资格）。
 * 同账号同头只改版本：`3.16.2` → `200 / code 0`。
 *
 * ⚠ 只用于**实测过门控**的两条路径（marketing / claim）；推理路径维持
 * 凭据里的版本 —— 那边的 `3012` 消融矩阵是在 3.14.3 上取的，无证据整体抬版本
 * 会把既有结论作废。
 * ⚠ 取较大者（而非恒定 3.16.3）是向前兼容：更新官方版登录的凭据用它自己的版本。
 */
export const ZCODE_VERSION_GATED_MIN_APP_VERSION = '3.16.3'

/** 合法版本号形态（major.minor.patch，纯数字、无前导零 —— 脏值会注入请求头）。 */
const ZCODE_APP_VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/

/** 点分版本比较（只看数字段，缺失段按 0；非数字段取前导数字）。 */
export function compareZcodeAppVersion(a, b) {
  const segments = (value) =>
    String(value)
      .split('.')
      .map((part) => {
        const match = /^\s*(\d+)/.exec(part)
        return match === null ? 0 : Number(match[1])
      })
  const left = segments(a)
  const right = segments(b)
  const count = Math.max(left.length, right.length)
  for (let index = 0; index < count; index += 1) {
    const l = left[index] ?? 0
    const r = right[index] ?? 0
    if (l !== r) return l < r ? -1 : 1
  }
  return 0
}

/**
 * 门控版本：`app_version` 必须是干净 semver（安全闸 —— 它原样进
 * `User-Agent` / `X-ZCode-App-Version`，`Headers()` 对脏值抛 TypeError），
 * 然后与 `3.16.3` 取较大者。
 */
export function zcodeVersionGatedAppVersion(credential) {
  const stored = typeof credential?.app_version === 'string' ? credential.app_version.trim() : ''
  if (!ZCODE_APP_VERSION_PATTERN.test(stored)) return ZCODE_VERSION_GATED_MIN_APP_VERSION
  return compareZcodeAppVersion(stored, ZCODE_VERSION_GATED_MIN_APP_VERSION) < 0
    ? ZCODE_VERSION_GATED_MIN_APP_VERSION
    : stored
}

/**
 * **不受门控**的版本：凭据里的干净 semver，拿不到就用兜底值
 * （与门控版的分工：这条给 query/body 里的 `app_version`）。
 */
export function zcodeCredentialAppVersion(credential) {
  const stored = typeof credential?.app_version === 'string' ? credential.app_version.trim() : ''
  return ZCODE_APP_VERSION_PATTERN.test(stored) ? stored : ZCODE_APP_VERSION_FALLBACK
}

/**
 * 把服务端时间戳归一成毫秒。
 *
 * ⚠ 服务端的 `expires_at` 是**秒级**（实测 1790746234）；与 `Date.now()` 直接比会
 * 立即判超时。小于 1e12 视为秒。
 */
export function toEpochMs(value) {
  if (!Number.isFinite(value) || value <= 0) return 0
  return value < 1e12 ? Math.round(value * 1000) : Math.round(value)
}

/** 下一个 UTC+8 零点（毫秒）：免费额度按自然日结算。 */
export function nextUtc8DayStartMs(now = new Date()) {
  const OFFSET = 8 * 60 * 60 * 1000
  const shifted = now.getTime() + OFFSET
  const dayStartShifted = Math.floor(shifted / 86_400_000) * 86_400_000
  return dayStartShifted + 86_400_000 - OFFSET
}

/**
 * 兜底模型表（上游 client/configs 不可达时用；数值抄自实测，不是估值）。
 *
 * ⚠ `reasoningLevels` / `defaultReasoningLevel` 与上游目录一致（2026-10-25 实测）。
 * 缺它们时宿主拿到的模型无思考档位元数据：选档即抛 `UNSUPPORTED_REASONING_EFFORT`
 * （UI 报「不支持当前档位」且无输出）—— 这是 0.3.1 修复前「GLM-5.3 思考等级失效」
 * 的直接成因（目录间歇拉取失败 → 兜底表无档位 → 校验拒绝）。
 */
export const ZCODE_FALLBACK_MODELS = Object.freeze([
  Object.freeze({
    id: 'GLM-5.3-Flash',
    name: 'GLM-5.3-Flash',
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    supportsImage: true,
    reasoningLevels: ['low', 'high', 'max'],
    defaultReasoningLevel: 'max',
  }),
  Object.freeze({
    id: 'GLM-5.3',
    name: 'GLM-5.3',
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    supportsImage: false,
    reasoningLevels: ['low', 'high', 'max'],
    defaultReasoningLevel: 'max',
  }),
])
