import test from 'node:test'
import assert from 'node:assert/strict'

import { buildZcodeHeaders, nextUtc8DayStartMs, toEpochMs } from '../lib/upstream.js'
import {
  classifyUpstreamError,
  concurrencyRetryDelayMs,
  describeUpstreamError,
  isZcodeQuotaExhausted,
} from '../lib/errors.js'

test('buildZcodeHeaders: X-Device-Mid 与 anthropic-version 必定下发', () => {
  const headers = buildZcodeHeaders({ device_mid: 'dev-1', app_version: '3.14.3' })
  assert.equal(headers['X-Device-Mid'], 'dev-1')
  assert.equal(headers['anthropic-version'], '2023-06-01')
  assert.equal(headers['User-Agent'], 'ZCode/3.14.3')
  assert.equal(headers['Authorization'], undefined)
  assert.equal(headers['x-aliyun-captcha-verify-param'], undefined)
})

test('buildZcodeHeaders: captcha 与 authorization 只在传入时出现', () => {
  const headers = buildZcodeHeaders(
    { device_mid: 'dev-1' },
    { authorization: 'Bearer jwt', captcha: { param: 'p', region: 'cn' } },
  )
  assert.equal(headers['Authorization'], 'Bearer jwt')
  assert.equal(headers['x-aliyun-captcha-verify-param'], 'p')
  assert.equal(headers['x-aliyun-captcha-verify-region'], 'cn')
})

test('classifyUpstreamError: 3009 是并发限流，不是额度用尽', () => {
  const body = '{"code":3009,"msg":"model concurrency limit exceeded"}'
  assert.equal(classifyUpstreamError(429, body), 'concurrency')
  assert.equal(isZcodeQuotaExhausted(body), false)
})

test('classifyUpstreamError: 1005 / 1113 都算额度用尽', () => {
  assert.equal(classifyUpstreamError(429, '{"code":1005,"msg":"exceed quota limit"}'), 'quota')
  assert.equal(classifyUpstreamError(200, '{"code":1113,"msg":"余额不足"}'), 'quota')
})

test('classifyUpstreamError: 3007 换 captcha，3012 不重试，401 需重新登录', () => {
  assert.equal(classifyUpstreamError(403, '{"code":3007,"msg":"captcha verify failed"}'), 'captcha')
  assert.equal(classifyUpstreamError(403, '{"code":3012,"msg":"request has been blocked due to unusual activity."}'), 'risk')
  assert.equal(classifyUpstreamError(401, ''), 'auth')
  assert.equal(classifyUpstreamError(500, 'boom'), 'other')
})

test('describeUpstreamError: 3012 必须带冷却惩罚告警', () => {
  const text = describeUpstreamError(403, '{"code":3012,"msg":"unusual activity"}')
  assert.match(text, /3012/)
  assert.match(text, /请勿连续重试/)
})

test('concurrencyRetryDelayMs: 线性退避 1500 / 3000', () => {
  assert.equal(concurrencyRetryDelayMs(0), 1500)
  assert.equal(concurrencyRetryDelayMs(1), 3000)
})

test('toEpochMs: 秒级时间戳归一成毫秒（否则刚登录就报超时）', () => {
  assert.equal(toEpochMs(1_790_746_234), 1_790_746_234_000)
  assert.equal(toEpochMs(1_790_746_234_000), 1_790_746_234_000)
  assert.equal(toEpochMs(0), 0)
})

test('nextUtc8DayStartMs: 返回下一个 UTC+8 零点', () => {
  const at = new Date('2026-10-23T12:00:00Z') // = 2026-10-23 20:00 +08
  const next = nextUtc8DayStartMs(at)
  assert.equal(new Date(next).toISOString(), '2026-10-23T16:00:00.000Z')
})
