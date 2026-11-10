/**
 * 终止失败的**统一出口**：把任何上游原文收窄成「用户该看到的那一句」，code 保真。
 *
 * ## 为什么需要它
 *
 * issue #2：用户选的是 A 通道，界面里出现的却是 **B 通道**的上游原文
 * （`429: {"message":"... soft_rate ...","code":"soft_rate"}`）—— 排查方向当场被带偏。
 * 根因是「原样透出上游失败块」；只要某条链路（回退、翻译、兜底）把上游 chunk
 * 直接 yield 给宿主，这个洞就会换个地方复现。
 *
 * 所以本模块提供两个原语，供**所有**失败收尾路径共用：
 * - `sanitizeFailure()`：错误对象 → `{ code, message }`，message 只说人话；
 * - `scrubFailureChunk()`：上游 chunk → 同样的 chunk 形状，但失败块已被脱敏。
 *
 * ## 约定
 *
 * - **code 保留**：宿主的重试策略 / 错误上报 / 回退判定都只认 code，脱敏绝不能改它；
 * - **文案中性**：不出现上游厂商名、业务码、原始 JSON、URL、账号昵称以外的隐私；
 * - **完整原因只进日志**：调用方拿到 `{ code, message }` 后自己决定 `log()` 什么。
 */

import { isFallbackWorthyCode } from './errors.js'

/** 各类失败码面向用户的中性短句（不含任何上游原文）。 */
const FRIENDLY = Object.freeze({
  QUOTA: '模型通道额度已用尽，请等待额度重置或切换模型 / 通道。',
  TIMEOUT: '模型通道超时（上游未在预期时间内返回内容），请稍后重试或切换通道。',
  RATE_LIMIT: '模型通道当前并发限流，请稍后重试，不要连续重试。',
  /**
   * 风控拦截是**账号级**的，文案必须与额度 / 并发区分开，否则用户会去等额度重置、
   * 或反复点重试把冷却从 30 分钟推到 24 小时。这里只承诺「已自动清除限流标记」，
   * 不承诺「马上一定成功」。
   */
  RISK_BLOCKED: '模型通道触发了上游风控拦截（非额度问题），已自动清除本账号的限流标记，可稍后重试，请勿连续重试。',
  AUTH: '模型通道凭据失效，请重新登录该通道的账号。',
  CAPTCHA_FAILED: '模型通道验证码（captcha）产出失败，请检查验证码载体是否可用。',
  ABORTED: '请求已取消。',
  PROVIDER_ERROR: '模型通道暂时不可用，请稍后重试。',
})

/** 未知码的兜底短句（同样不给上游原文）。 */
const GENERIC = '模型通道暂时不可用，请稍后重试。'

/**
 * 把失败收窄成 `{ code, message }`。
 *
 * @param {{ code?: unknown, message?: unknown } | string | undefined | null} failure
 *   上游失败载荷、插件自己的 Error、或裸字符串。
 * @returns {{ code: string, message: string }} code 必定是非空字符串
 */
export function sanitizeFailure(failure) {
  if (failure === undefined || failure === null) return { code: 'PROVIDER_ERROR', message: GENERIC }
  if (typeof failure === 'string') {
    /** 裸字符串：上游原文不能直接给用户 —— 只保留其 code 语境（未知即 PROVIDER_ERROR）。 */
    return { code: 'PROVIDER_ERROR', message: GENERIC }
  }
  const code = typeof failure.code === 'string' && failure.code.length > 0 ? failure.code : 'PROVIDER_ERROR'
  return { code, message: FRIENDLY[code] ?? GENERIC }
}

/**
 * 这次失败是否该由**回退链路**接手（而不是直接把它抛给宿主）。
 *
 * @param {unknown} failure 失败载荷 / Error
 * @returns {boolean}
 */
export function shouldFallback(failure) {
  if (failure === undefined || failure === null) return false
  const code = typeof failure === 'object' ? failure.code : undefined
  return typeof code === 'string' && isFallbackWorthyCode(code)
}

/**
 * 脱敏一个上游 chunk（失败块才动，其余原样返回**同一引用**）。
 *
 * 认两种形状：
 * - `{ type: 'finish', reason: { kind: 'error', failure } }` —— DSH 协议终止块；
 * - `{ type: 'error', code?, message }` —— 流内错误事件。
 *
 * @template T
 * @param {T} chunk
 * @returns {T}
 */
export function scrubFailureChunk(chunk) {
  if (chunk === null || typeof chunk !== 'object') return chunk
  if (chunk.type === 'finish') {
    const reason = chunk.reason
    if (reason === null || typeof reason !== 'object' || reason.kind !== 'error') return chunk
    const failure = reason.failure
    if (failure === undefined || failure === null) return chunk
    return { ...chunk, reason: { ...reason, failure: sanitizeFailure(failure) } }
  }
  if (chunk.type === 'error') {
    const message = typeof chunk.message === 'string' ? chunk.message : undefined
    if (message === undefined || message.length === 0) return chunk
    const code = typeof chunk.code === 'string' && chunk.code.length > 0 ? chunk.code : 'PROVIDER_ERROR'
    return { ...chunk, code, message: sanitizeFailure({ code, message }).message }
  }
  return chunk
}

/** 失败码的中性短句（供调用方拼自己的上下文，如「额度用尽 → 已于 … 重置」）。 */
export function friendlyFailureMessage(code) {
  return FRIENDLY[code] ?? GENERIC
}

/**
 * 把一次**已经落定**的失败块统一脱敏后交给宿主。
 *
 * 这是所有失败收尾路径（本通道、回退通道、端点转发、错误翻译）应该用的唯一出口：
 * 调用方只负责搞清「code 是什么」，文案一律从这里出。
 *
 * @param {{ code?: string, message?: string } | undefined | null} failure
 * @returns {{ type: 'finish', reason: { kind: 'error', failure: { code: string, message: string } } }}
 */
export function terminalFailureChunk(failure) {
  return { type: 'finish', reason: { kind: 'error', failure: sanitizeFailure(failure) } }
}

export { FRIENDLY as FRIENDLY_FAILURE_MESSAGES }
