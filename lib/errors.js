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

/** 判断是否是并发限流（3009）—— 等一下就能过，故重试且**不换号**。 */
export function isZcodeConcurrencyLimited(body) {
  return body.includes(ZCODE_CONCURRENCY_CODE) || /concurrency\s+limit/i.test(body)
}

/** 判断是否是额度用尽（确定性：等账期重置才恢复）。 */
export function isZcodeQuotaExhausted(body) {
  if (isZcodeConcurrencyLimited(body)) return false
  if (body.includes('1113') || body.includes('余额不足')) return true
  if (body.includes('1005')) return true
  return /exceed\s+quota\s+limit|quota\s+(?:has\s+been\s+)?exhausted/i.test(body)
}

/** 判断是否是 captcha 校验失败（3007）—— 换新 param 即可重试。 */
export function isZcodeCaptchaRejected(body) {
  return body.includes('3007') || /captcha\s+verify\s+failed/i.test(body)
}

/** 判断是否是风控拦截（3012）—— **不要重试**。 */
export function isZcodeRiskBlocked(body) {
  return body.includes('3012') || /unusual\s+activity/i.test(body)
}

/** 判断是否是鉴权失败（401 / 1002）—— 需用户重新登录该账号。 */
export function isZcodeAuthFailed(status, body) {
  if (status === 401) return true
  return body.includes('1002') || /invalid\s+token|token\s+expired/i.test(body)
}

/**
 * 把上游错误翻成人能看懂的一句话。
 * 两个业务码必须单独说清，因为用户该做的事完全不同：3007 可重试，3012 不可重试。
 */
export function describeUpstreamError(status, body) {
  const trimmed = String(body ?? '').trim()
  let code
  let message
  try {
    const parsed = JSON.parse(trimmed)
    code = parsed.code
    message = parsed.msg ?? parsed.message
  } catch {
    // 非 JSON：原样截断。
  }
  const suffix = typeof message === 'string' && message.length > 0 ? message : trimmed.slice(0, 200)

  if (code === 3009 || trimmed.includes('3009')) {
    return `上游并发限流（3009 model concurrency limit exceeded）——已按退避重试仍未通过，请稍后重试。原始响应：${suffix}`
  }
  if (code === 1005 || trimmed.includes('1005')) {
    return `额度用尽（1005 exceed quota limit）——该账号在这个模型上的免费额度已用完，请等待额度重置或更换账号。原始响应：${suffix}`
  }
  if (code === 3007 || trimmed.includes('3007')) {
    return '阿里云 captcha 校验失败（3007）。请重试；若持续失败，检查 ZCode 桌面端是否在运行（captcha 载体）。'
  }
  if (code === 3012 || trimmed.includes('3012')) {
    return `上游风控拦截（3012 unusual activity）。⚠ 该错误有账号冷却惩罚（30 分钟，反复触发会升级到 24 小时乃至停用），请勿连续重试。原始响应：${suffix}`
  }
  if (code === 1113 || trimmed.includes('1113')) {
    return `余额不足或无可用资源包（1113）。原始响应：${suffix}`
  }
  if (code === 1002 || status === 401) {
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

/** 并发限流重试的退避时长（线性：base、2×base、…）。 */
export function concurrencyRetryDelayMs(attempt, baseMs = CONCURRENCY_RETRY_BASE_MS) {
  const base = baseMs > 0 ? baseMs : CONCURRENCY_RETRY_BASE_MS
  return base * (Math.max(0, Math.floor(attempt)) + 1)
}

/** 构造 Anthropic 形态的错误体（DSH 侧只读 message，但保持形态一致）。 */
export function anthropicErrorPayload(message, type = 'api_error') {
  return { type: 'error', error: { type, message } }
}
