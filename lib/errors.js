/**
 * 上游错误判定与翻译（**切号策略的唯一判据来源**）。
 *
 * 判据必须窄：
 * - 「额度用尽」在 wire 上有多种形态，而「并发限流」**同样返回 429**；
 *   只按状态码分类会把 3009 误判成额度用尽 → 误伤一个完全可用的账号。
 * - 文案兜底只认 `exceed quota limit` / `quota exhausted` 这类**窄**关键词；
 *   用 `quota` / `balance` 泛词会误伤模型正文里恰好讨论额度的内容。
 *
 * 处置表（全部来自参考实现的实测）：
 *
 * | 形态 | 处置 |
 * |---|---|
 * | `1005` / `1113` / HTTP 200 但零内容 | 标记该账号×模型当日用尽 → **换号** |
 * | `3009` 并发限流 | 打 60s 忙标记 + 线性退避重试；穷尽后**换号**（钉定模式除外） |
 * | `3007` captcha 失败 | **换新 captcha** 重试（param 一次性），不换号 |
 * | `3012` 风控 | **不重试**（有账号冷却惩罚：30 分钟；24h 内第 3 次起 24 小时；5 次停用） |
 * | `401` / `1002` 凭据失效 | **不重试**，需重新登录该账号 |
 */

/**
 * 「账号×模型」忙标记（3009 并发限流）的窗口时长。
 *
 * ⚠ 忙标记是**软优先级**不是硬过滤：选号先避开忙账号，全部忙时仍回落排队。
 * 窗口取 60 秒 —— 3009 是秒级瞬态（退避 1.5/3s 内通常自愈），打 longer 只会
 * 在账号早已空闲后还绕着走；真正的持续占用由「额度用尽」的当日标记兜底。
 */
export const MODEL_BUSY_TTL_MS = 60_000

/** 上游并发限流的业务码。 */
export const ZCODE_CONCURRENCY_CODE = '3009'

/** 并发限流重试次数上限。 */
export const CONCURRENCY_RETRY_MAX = 2

/** 换号次数上限。 */
export const QUOTA_SWITCH_MAX = 3

/** 并发限流重试的退避基数（实测 900ms 仍撞 429，故用 1500ms 起步）。 */
export const CONCURRENCY_RETRY_BASE_MS = 1_500

/**
 * 从响应正文里取出**结构化业务码**（数字或纯数字字符串），取不到返回 undefined。
 *
 * ⚠ 为什么不能只看 `body.includes('1005')`：非 JSON 错误体（网关 HTML 500 页、
 * Request ID、甚至被回显的正文）里恰好含同一个数字串时会误分类 —— 实测
 * `<html>…Request ID 3f8a-1005-b27c…</html>` 被判成「额度用尽」，于是把一个健康
 * 账号标限流到**当日结束**。判据的优先级是：
 *
 * 1. 整体 `JSON.parse` 取 `code` / `error.code`（上游实测形态）；
 * 2. 正文里出现 `"code":NNNN` 这类**带 JSON 结构的片段**（被包裹的 JSON-safe 文本）；
 * 3. 都不是（`undefined`）→ 才允许第四步的「独立数字 token」兜底。
 *
 * @param {string} body
 * @returns {number | undefined}
 */
export function extractBusinessCode(body) {
  const text = String(body ?? '').trim()
  if (text.length === 0) return undefined
  try {
    const parsed = JSON.parse(text)
    return toCode(parsed?.code ?? parsed?.error?.code)
  } catch {
    // 不是完整 JSON：退到结构化片段匹配（仍然要求 JSON 键的引号与冒号）。
  }
  const match = /"code"\s*:\s*"?(\d+)"?/.exec(text)
  return match === null ? undefined : Number(match[1])
}

/** 业务码归一化：数字或纯数字字符串 → number，其余 undefined。 */
function toCode(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim())
  return undefined
}

/**
 * 判断正文是否带某个业务码。
 *
 * 结构化业务码**存在时以它为准**（出现别的 code = 不是这个错误）；不存在时才允许
 * 「独立数字 token」兜底 —— 且要求数字两侧都不是字母数字（`1005-b27c`、`3009x`、
 * `a1005` 都不算），把 Request ID / 十六进制片段这类误命中挡在外面。
 * ⚠ 兜底只对**短正文**生效：超过 8KB 的 HTML 错误页等不再猜（宁可归到 other）。
 */
export function hasBusinessCode(body, code) {
  const text = String(body ?? '')
  const structured = extractBusinessCode(text)
  if (structured !== undefined) return structured === Number(code)
  if (text.length > 8_192) return false
  /**
   * ⚠ 兜底只在**长得不像 HTML 文档**时生效：网关错误页/反代 502 页里常带
   * `Request ID 3f8a-1005-b27c` 这类片段，而这类页面结构上永远不是上游业务错误。
   * 用「是否存在 HTML 标签结构 + JSON 键」判定，比窄化数字边界更贴近真实形态。
   */
  if (/<\s*(?:!doctype|html|head|body|title|p|div|pre|center|h[1-6])\b/i.test(text)) return false
  /** 连 JSON 键都不出现的纯文本里，业务码只可能是裸串（`1005 exceed quota limit`）。 */
  return new RegExp(`(?<![0-9A-Za-z])${code}(?![0-9A-Za-z])`).test(text)
}

/** 判断是否是并发限流（3009）—— 等一下就能过，故重试且**不换号**。 */
export function isZcodeConcurrencyLimited(body) {
  return hasBusinessCode(body, ZCODE_CONCURRENCY_CODE) || /concurrency\s+limit/i.test(body)
}

/** 判断是否是额度用尽（确定性：等账期重置才恢复）。 */
export function isZcodeQuotaExhausted(body) {
  if (isZcodeConcurrencyLimited(body)) return false
  if (hasBusinessCode(body, 1113) || body.includes('余额不足')) return true
  if (hasBusinessCode(body, 1005)) return true
  return /exceed\s+quota\s+limit|quota\s+(?:has\s+been\s+)?exhausted/i.test(body)
}

/** 判断是否是 captcha 校验失败（3007）—— 换新 param 即可重试。 */
export function isZcodeCaptchaRejected(body) {
  return hasBusinessCode(body, 3007) || /captcha\s+verify\s+failed/i.test(body)
}

/** 判断是否是风控拦截（3012）—— **不要重试**。 */
export function isZcodeRiskBlocked(body) {
  return hasBusinessCode(body, 3012) || /unusual\s+activity/i.test(body)
}

/** 判断是否是鉴权失败（401 / 1002）—— 需用户重新登录该账号。 */
export function isZcodeAuthFailed(status, body) {
  if (status === 401) return true
  return hasBusinessCode(body, 1002) || /invalid\s+token|token\s+expired/i.test(body)
}

/**
 * 把上游错误翻成人能看懂的一句话。
 * 两个业务码必须单独说清，因为用户该做的事完全不同：3007 可重试，3012 不可重试。
 *
 * ⚠ 一律走 `hasBusinessCode`（结构化判据），不再用裸 `includes` —— 网关 HTML
 * 错误页里恰好含同一个数字串时不至于把用户引向错误的排查方向。
 */
export function describeUpstreamError(status, body) {
  const trimmed = String(body ?? '').trim()
  let message
  try {
    const parsed = JSON.parse(trimmed)
    message = parsed.msg ?? parsed.message ?? parsed.error?.message
  } catch {
    // 非 JSON：原样截断。
  }
  const suffix = typeof message === 'string' && message.length > 0 ? message : trimmed.slice(0, 200)
  const has = (code) => hasBusinessCode(trimmed, code)

  if (has(3009)) {
    return `上游并发限流（3009 model concurrency limit exceeded）——已按退避重试仍未通过，请稍后重试。原始响应：${suffix}`
  }
  if (has(1005)) {
    return `额度用尽（1005 exceed quota limit）——该账号在这个模型上的免费额度已用完，请等待额度重置或更换账号。原始响应：${suffix}`
  }
  if (has(3007)) {
    return '阿里云 captcha 校验失败（3007）。请重试；若持续失败，检查 ZCode 桌面端是否在运行（captcha 载体）。'
  }
  if (has(3012)) {
    return `上游风控拦截（3012 unusual activity）。⚠ 该错误有账号冷却惩罚（30 分钟，反复触发会升级到 24 小时乃至停用），请勿连续重试。原始响应：${suffix}`
  }
  if (has(1113)) {
    return `余额不足或无可用资源包（1113）。原始响应：${suffix}`
  }
  if (has(1002) || status === 401) {
    return `凭据失效（${status}）。请用 \`zcode-start-plan login\` 重新登录该账号。${suffix}`
  }
  return `HTTP ${status}：${suffix}`
}

/**
 * 上游错误分类（供重试循环直接路由）。
 *
 * @param {number} status HTTP 状态码
 * @param {string} body 响应正文
 * @returns {'quota' | 'concurrency' | 'captcha' | 'risk' | 'auth' | 'other'}
 */
export function classifyUpstreamError(status, body) {
  if (isZcodeRiskBlocked(body)) return 'risk'
  if (isZcodeAuthFailed(status, body)) return 'auth'
  if (isZcodeConcurrencyLimited(body)) return 'concurrency'
  if (isZcodeQuotaExhausted(body)) return 'quota'
  if (isZcodeCaptchaRejected(body)) return 'captcha'
  return 'other'
}

/**
 * 黑洞阈值的缺省值（毫秒）。
 *
 * - `DEFAULT_HEAD_TIMEOUT_MS`：**首内容超时**。请求发出后这么久还没见到
 *   第一个内容事件，就认为上游「不再出流」（额度用尽后本渠道的典型表现：
 *   HTTP 200 + 一个永不产出内容的 SSE 流），中止并按 TIMEOUT 分类。
 *   ⚠ 必须显著小于宿主的单次超时（实测 ~300s）：否则宿主的超时先落地，
 *   分类变成笼统的 `PROVIDER_ERROR`，回退链路连判断的机会都没有。
 * - `DEFAULT_READ_TIMEOUT_MS`：**流内**读超时。已经有内容之后，两个事件之间
 *   允许的最大静默 —— 长思考/长工具参数不该被首内容超时误杀。
 */
export const DEFAULT_HEAD_TIMEOUT_MS = 90_000
export const DEFAULT_READ_TIMEOUT_MS = 180_000

/**
 * 这次失败是否值得**先回退到别的通道**再报错（`fallback.js` 的默认回退码）。
 *
 * QUOTA / TIMEOUT / RATE_LIMIT 都是「本通道此刻给不出结果，但别的通道也许行」
 * 的瞬态或额度级失败；AUTH / CAPTCHA_FAILED / PROVIDER_ERROR / ABORTED 不是。
 * 宿主自己又有一套 `llm-retry` —— 这里只决定本插件是否**立刻**改道。
 */
export function isFallbackWorthyCode(code) {
  return code === 'QUOTA' || code === 'TIMEOUT' || code === 'RATE_LIMIT'
}

/** 并发限流重试的退避时长（线性：base、2×base、…）。 */
export function concurrencyRetryDelayMs(attempt, baseMs = CONCURRENCY_RETRY_BASE_MS) {
  const base = baseMs > 0 ? baseMs : CONCURRENCY_RETRY_BASE_MS
  return base * (Math.max(0, Math.floor(attempt)) + 1)
}

/** 构造 Anthropic 形态的错误体（DSH 侧只读 message，但保持形态一致）。 */
export function anthropicErrorPayload(message, type = 'api_error') {
  return { type: 'error', error: { type, message } }
}
