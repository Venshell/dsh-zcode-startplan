/**
 * issue #2：**回退 / 兜底路径的终止失败块必须脱敏**。
 *
 * 原事故：模型选择器里选的是 zcode，界面却返回 workbuddy 通道的上游原文
 * （`429: {"message":"workbuddy upstream soft_rate ...","type":"soft_rate"}`）。
 * 用户看到的是「另一个通道的判定」，排查方向当场被带偏。
 *
 * 本仓库的统一出口是 `lib/fallback.js`：
 * - `sanitizeFailure()`：`{ code, message }` → 中性文案 + **保真 code**；
 * - `scrubFailureChunk()`：任意上游 chunk → 失败块已脱敏，其余原样；
 * - `terminalFailureChunk()`：直接产出合规的终止块。
 *
 * 用例约束三件事：① 原文绝不外泄 ② code 绝不被改 ③ 非失败块不能被动过。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  sanitizeFailure,
  scrubFailureChunk,
  shouldFallback,
  terminalFailureChunk,
  friendlyFailureMessage,
} from '../lib/fallback.js'

/** issue #2 里真实流到聊天记录的那段文本。 */
const LEAKY = '429: {"message":"workbuddy upstream soft_rate (http 429): 您的使用量已超出频率限制，将在 2026-11-04 13:50:11 UTC+8 重置，您也可以切换其他模型继续使用。","type":"soft_rate","code":"soft_rate"}'

test('#2 sanitizeFailure：上游原文不外泄，code 保真', () => {
  for (const code of ['QUOTA', 'TIMEOUT', 'RATE_LIMIT', 'AUTH', 'PROVIDER_ERROR', 'CAPTCHA_FAILED', 'ABORTED']) {
    const out = sanitizeFailure({ code, message: LEAKY })
    assert.equal(out.code, code, 'code 必须原样保留（宿主的重试 / 回退 / 上报全靠它）')
    assert.doesNotMatch(out.message, /workbuddy|soft_rate|429|http/i, `code=${code} 仍然泄漏了上游原文`)
    assert.equal(out.message, friendlyFailureMessage(code))
  }
})

test('#2 sanitizeFailure：裸字符串与空值都给中性兜底', () => {
  assert.deepEqual(sanitizeFailure(LEAKY), {
    code: 'PROVIDER_ERROR',
    message: friendlyFailureMessage('PROVIDER_ERROR'),
  })
  const empty = sanitizeFailure(undefined)
  assert.equal(empty.code, 'PROVIDER_ERROR')
  assert.doesNotMatch(empty.message, /undefined|null/)
  /** 没有 code 的 Error 也要被归类，而不是吐 message。 */
  const bare = sanitizeFailure(new Error(LEAKY))
  assert.equal(bare.code, 'PROVIDER_ERROR')
  assert.doesNotMatch(bare.message, /soft_rate/)
})

test('#2 scrubFailureChunk：finish 失败块脱敏，kind 与 code 保真', () => {
  const chunk = {
    type: 'finish',
    reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: LEAKY } },
  }
  const out = scrubFailureChunk(chunk)
  assert.equal(out.type, 'finish')
  assert.equal(out.reason.kind, 'error')
  assert.equal(out.reason.failure.code, 'RATE_LIMIT')
  assert.doesNotMatch(out.reason.failure.message, /soft_rate|workbuddy/)
  /** 不改入参（下游可能还在用同一对象）。 */
  assert.match(chunk.reason.failure.message, /soft_rate/)
})

test('#2 scrubFailureChunk：裸字符串 failure 归类 PROVIDER_ERROR，不外泄', () => {
  const out = scrubFailureChunk({ type: 'finish', reason: { kind: 'error', failure: LEAKY } })
  assert.equal(out.reason.failure.code, 'PROVIDER_ERROR')
  assert.doesNotMatch(out.reason.failure.message, /soft_rate/)
})

test('#2 scrubFailureChunk：type:error 事件块脱敏；成功 finish 与非失败块原样返回', () => {
  const errorEvent = scrubFailureChunk({ type: 'error', code: 'QUOTA', message: LEAKY })
  assert.equal(errorEvent.code, 'QUOTA')
  assert.doesNotMatch(errorEvent.message, /soft_rate/)

  /** 成功块、文本块、非对象：**同一引用**返回（脱敏闸不能改动正常流）。 */
  const okFinish = { type: 'finish', reason: { kind: 'stop' } }
  assert.equal(scrubFailureChunk(okFinish), okFinish)
  const delta = { type: 'text-delta', text: 'soft_rate 只是正文里的普通词' }
  assert.equal(scrubFailureChunk(delta), delta)
  assert.equal(scrubFailureChunk(null), null)
  assert.equal(scrubFailureChunk('x'), 'x')
})

test('#2 terminalFailureChunk：产出合规终止块（宿主读 reason.kind）', () => {
  const chunk = terminalFailureChunk({ code: 'TIMEOUT', message: LEAKY })
  assert.deepEqual(chunk, {
    type: 'finish',
    reason: { kind: 'error', failure: { code: 'TIMEOUT', message: friendlyFailureMessage('TIMEOUT') } },
  })
})

test('#2 shouldFallback：只对「换通道也许能行」的失败码改道', () => {
  for (const code of ['QUOTA', 'TIMEOUT', 'RATE_LIMIT']) {
    assert.equal(shouldFallback({ code }), true, `${code} 应该触发回退`)
  }
  for (const code of ['AUTH', 'ABORTED', 'CAPTCHA_FAILED', 'PROVIDER_ERROR']) {
    /** 凭据失效 / 用户取消 / captcha 失败：换个通道解决不了问题，别静默改道。 */
    assert.equal(shouldFallback({ code }), false, `${code} 不该触发回退`)
  }
  assert.equal(shouldFallback(undefined), false)
  assert.equal(shouldFallback({}), false)
})
