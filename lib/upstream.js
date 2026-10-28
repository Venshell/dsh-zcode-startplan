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

/** ZCode 平台 origin。 */
export const ZCODE_ORIGIN = 'https://zcode.z.ai'

/** 免费额度通道的 Anthropic Messages 端点（推理主链路）。 */
export const ZCODE_PLAN_MESSAGES_URL = `${ZCODE_ORIGIN}/api/v1/zcode-plan/anthropic/v1/messages`

/** 额度余额。 */
export const ZCODE_BILLING_BALANCE_URL = `${ZCODE_ORIGIN}/api/v1/zcode-plan/billing/balance`

/** 可领活动预览（⚠ 0.6.0 实证恒空，官方客户端从不调用；保留常量仅为兼容）。 */
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
 * ⚠ `X-Device-Mid` 是 billing/* 与推理端点的硬需求（缺则 400 code 3001），
 * 但**不是账号标识**：同一账号重新登录会换一个，去重必须用 `user_id`。
 *
 * @param {{ device_mid: string, app_version?: string }} credential 凭据（或任何带 device_mid 的对象）
 * @param {{ authorization?: string, json?: boolean, captcha?: { param: string, region: string }, extra?: Record<string,string>, authHeader?: string }} [options]
 * @returns {Record<string, string>}
 */
export function buildZcodeHeaders(credential, options = {}) {
  const appVersion = credential.app_version ?? ZCODE_APP_VERSION_FALLBACK
  /** @type {Record<string, string>} */
  const headers = {
    'User-Agent': `ZCode/${appVersion}`,
    'HTTP-Referer': ZCODE_ORIGIN,
    'X-ZCode-App-Version': appVersion,
    'X-Release-Channel': 'stable',
    'X-Client-Language': 'zh-CN',
    'X-Client-Timezone': 'Asia/Shanghai',
    'X-Device-Mid': credential.device_mid,
    'X-Platform': 'win32',
    'X-Os-Category': 'windows',
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
