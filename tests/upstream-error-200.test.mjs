/**
 * 「HTTP 200 里包裹业务错误」的识别。
 *
 * 实测（2026-10-23，本渠道）：额度用尽时上游返回
 * `200 + application/json + {"code":1005,"msg":"exceed quota limit"}`。
 *
 * 若把它当成「空响应」处理，会：
 *   ① 丢掉真正的错误码，用户只看到误导性的「200 但零内容」；
 *   ② 无法据此正确决策（1005 该标号换号；3012 该直接失败不重试）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { extractUpstreamError, readContentHead } from '../lib/sse.js'
import { classifyUpstreamError, extractBusinessCode, hasBusinessCode } from '../lib/errors.js'
import { ZcodePlanClient } from '../lib/plan-client.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (file) => readFileSync(join(here, 'fixtures', file))

/**
 * 回归：数字业务码必须按**结构**判定，不能裸子串匹配。
 *
 * 实测踩点：网关 502 页正文里带 `Request ID 3f8a-1005-b27c`，旧实现
 * `body.includes('1005')` 判成「额度用尽」→ 把一个健康账号标限流到**当日结束**。
 */
test('classifyUpstreamError: 非 JSON 错误页里的数字片段不再误判为额度用尽', () => {
  const html = '<html><head><title>502 Bad Gateway</title></head><body><p>Request ID 3f8a-1005-b27c</p></body></html>'
  assert.equal(classifyUpstreamError(500, html), 'other')
  assert.equal(hasBusinessCode(html, 1005), false)
  const another = '<html><body>Error 1113 detected in upstream module</body></html>'
  assert.equal(classifyUpstreamError(502, another), 'other')
})

test('classifyUpstreamError: 结构化业务码（数字/字符串/嵌套）照旧识别', () => {
  assert.equal(classifyUpstreamError(200, '{"code":1005,"msg":"exceed quota limit"}'), 'quota')
  assert.equal(classifyUpstreamError(200, '{"code":"1005"}'), 'quota')
  assert.equal(classifyUpstreamError(200, '{"error":{"code":3012}}'), 'risk')
  assert.equal(classifyUpstreamError(200, '{"code":3009}'), 'concurrency')
  assert.equal(classifyUpstreamError(200, '{"code":3007}'), 'captcha')
})

test('extractBusinessCode: 只认 JSON 结构，纯文本/HTML 一律 undefined', () => {
  assert.equal(extractBusinessCode('{"code":0}'), 0)
  assert.equal(extractBusinessCode('{"msg":"ok"}'), undefined)
  assert.equal(extractBusinessCode('<html>1005</html>'), undefined)
  /** 被包裹的 JSON 片段仍能取出（上游偶有前后缀）。 */
  assert.equal(extractBusinessCode('gateway: {"code":3007} trailing'), 3007)
})

test('hasBusinessCode: 结构化 code 优先于兜底数字 token', () => {
  /** 有结构化 code 时，出现别的数字串不算。 */
  assert.equal(hasBusinessCode('{"code":3009,"msg":"1005 is a doc id"}', 1005), false)
  assert.equal(hasBusinessCode('{"code":3009,"msg":"1005 is a doc id"}', 3009), true)
  /** 无结构时裸业务码仍可识别（上游偶尔回纯文本）。 */
  assert.equal(hasBusinessCode('1005 exceed quota limit', 1005), true)
  assert.equal(hasBusinessCode('upstream 3009x timeout', 3009), false)
})

test('extractUpstreamError: 200 + {code:1005} 被识别为业务错误', () => {
  const error = extractUpstreamError({ code: 1005, msg: 'exceed quota limit' }, '')
  assert.notEqual(error, undefined)
  assert.match(error.text, /1005/)
  assert.match(error.text, /exceed quota limit/)
  /** 交给错误表后应判成 quota（而不是 other / 无权益）。 */
  assert.equal(classifyUpstreamError(200, error.text), 'quota')
})

test('extractUpstreamError: 3012 风控与 3009 并发同样能从 200 里认出来', () => {
  assert.equal(
    classifyUpstreamError(200, extractUpstreamError({ code: 3012, msg: 'unusual activity' }, '').text),
    'risk',
  )
  assert.equal(
    classifyUpstreamError(200, extractUpstreamError({ code: 3009, msg: 'concurrency limit' }, '').text),
    'concurrency',
  )
})

test('extractUpstreamError: 成功码 0 与正常 message 不算错误', () => {
  assert.equal(extractUpstreamError({ code: 0, msg: '' }, ''), undefined)
  assert.equal(extractUpstreamError({ id: 'msg_1', type: 'message', content: [] }, ''), undefined)
})

test('extractUpstreamError: Anthropic 标准错误载荷与裸 error 字段', () => {
  const standard = extractUpstreamError({ type: 'error', error: { type: 'api_error', message: 'boom' } }, '')
  assert.notEqual(standard, undefined)
  assert.match(standard.text, /api_error/)
  const bare = extractUpstreamError({ error: { message: 'boom' } }, '')
  assert.notEqual(bare, undefined)
})

test('readContentHead: 200 + 业务错误的 JSON 不再被当成「零内容」', async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(fixture('quota-200.json'))
      controller.close()
    },
  })
  const head = await readContentHead(body, { contentType: 'application/json; charset=utf-8' })
  assert.equal(head.hasContent, false)
  assert.notEqual(head.upstreamError, undefined)
  assert.match(head.upstreamError.text, /1005/)
})

test('plan-client: 200 里的 1005 标记该账号当日用尽并换号（而不是「零内容」）', async () => {
  const quotaBody = () =>
    new ReadableStream({
      start(controller) {
        controller.enqueue(fixture('quota-200.json'))
        controller.close()
      },
    })
  const pool = {
    state: [
      { id: 'acct-a', enabled: true, model_rate_limits: {}, credential: { zcode_jwt: 'jwt-a', device_mid: 'dev-a' } },
      { id: 'acct-b', enabled: true, model_rate_limits: {}, credential: { zcode_jwt: 'jwt-b', device_mid: 'dev-b' } },
    ],
    list() {
      return this.state
    },
    pick(_model, exclude) {
      const hit = this.state.find((entry) => entry.enabled && !(exclude?.has(entry.id) ?? false))
      return hit === undefined ? null : { entry: hit, credential: hit.credential }
    },
    markModelRateLimited(id, model) {
      const hit = this.state.find((entry) => entry.id === id)
      if (hit !== undefined) hit.model_rate_limits[model] = Date.now() + 60_000
    },
    noteError() {},
  }
  const marks = []
  const originalMark = pool.markModelRateLimited.bind(pool)
  pool.markModelRateLimited = (id, model, at) => {
    marks.push({ id, code: 'quota' })
    originalMark(id, model, at)
  }

  const client = new ZcodePlanClient({
    pool,
    minter: { async mint() { return { param: 'p', interactive: false } }, async fetchConfig() { return undefined } },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json; charset=utf-8' }),
      body: quotaBody(),
    }),
  })

  await assert.rejects(
    () => client.call({ options: { model: 'GLM-5.3-Flash', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] } }),
    (error) => {
      assert.equal(error.code, 'QUOTA')
      assert.match(error.message, /1005/)
      return true
    },
  )
  /** 两个账号都被按「额度用尽」标记过（而不是被当成无权益）。 */
  assert.deepEqual(marks.map((mark) => mark.id), ['acct-a', 'acct-b'])
})
