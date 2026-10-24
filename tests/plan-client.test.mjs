import test from 'node:test'
import assert from 'node:assert/strict'

import { ZcodePlanClient } from '../lib/plan-client.js'

const CREDENTIAL = { zcode_jwt: 'jwt-1', device_mid: 'dev-1', user_id: 'u-1' }

/** 内存版账号池（只实现 plan-client 用到的三个方法）。 */
function fakePool(credentials = [{ id: 'acct-a', credential: CREDENTIAL }]) {
  const state = credentials.map((entry) => ({ nickname: entry.id, enabled: true, model_rate_limits: {}, ...entry }))
  return {
    list: () => state,
    pick(model, exclude) {
      const excluded = exclude ?? new Set()
      const hit = state.find((entry) => entry.enabled && !excluded.has(entry.id))
      return hit === undefined ? null : { entry: hit, credential: hit.credential }
    },
    markModelRateLimited(accountId, modelId, resetAt) {
      const hit = state.find((entry) => entry.id === accountId)
      if (hit !== undefined) hit.model_rate_limits[modelId] = resetAt
    },
    noteError() {},
  }
}

const fakeMinter = (params = ['param-1', 'param-2', 'param-3']) => {
  let index = 0
  return {
    calls: 0,
    async mint() {
      this.calls += 1
      return { param: params[Math.min(index++, params.length - 1)], interactive: false }
    },
    async fetchConfig() {
      return { region: 'cn', prefix: 'no8xfe', sceneId: 'scene' }
    },
  }
}

const sseStream = (events) =>
  new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()
      for (const event of events) controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`))
      controller.close()
    },
  })

const textStream = () =>
  sseStream([
    { type: 'message_start', message: { model: 'GLM-5.3-Flash', usage: { input_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    { type: 'message_stop' },
  ])

const emptyStream = () =>
  sseStream([
    { type: 'message_start', message: { model: 'GLM-5.3-Flash' } },
    { type: 'message_stop' },
  ])

const response = (status, body, contentType = 'text/event-stream') => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers({ 'content-type': contentType }),
  body,
  text: async () => (typeof body === 'string' ? body : ''),
})

const baseOptions = { model: 'GLM-5.3-Flash', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }

test('先不带 captcha 探测；被 3007 拒后才产出并重试', async () => {
  const seen = []
  const fetchImpl = async (_url, init) => {
    seen.push(init.headers)
    if (seen.length === 1) return response(403, JSON.stringify({ code: 3007, msg: 'captcha verify failed' }), 'application/json')
    return response(200, textStream())
  }
  const minter = fakeMinter()
  const client = new ZcodePlanClient({ pool: fakePool(), minter, fetchImpl })

  const result = await client.call({ options: baseOptions })
  assert.equal(seen.length, 2)
  assert.equal(seen[0]['x-aliyun-captcha-verify-param'], undefined, '第一次不带 captcha')
  assert.equal(seen[1]['x-aliyun-captcha-verify-param'], 'param-1', '被拒后才产出')
  assert.equal(minter.calls, 1)
  assert.equal(result.accountId, 'acct-a')
})

test('已知需要 captcha 时直接带上（省掉一次 3007 往返）', async () => {
  const seen = []
  let call = 0
  const fetchImpl = async (_url, init) => {
    seen.push(init.headers)
    call += 1
    if (call === 1) return response(403, '{"code":3007}', 'application/json')
    return response(200, textStream())
  }
  const minter = fakeMinter()
  const client = new ZcodePlanClient({ pool: fakePool(), minter, fetchImpl })

  /** 第一次：探测被拒 → 产出并重试成功（2 次尝试）。 */
  await client.call({ options: baseOptions })
  assert.equal(seen.length, 2)
  assert.equal(seen[0]['x-aliyun-captcha-verify-param'], undefined)
  assert.equal(seen[1]['x-aliyun-captcha-verify-param'], 'param-1')

  /** 第二次（同一 client、2 分钟窗口内）：直接带头，只发一次。 */
  const result = await client.call({ options: baseOptions })
  assert.equal(seen.length, 3, '第二次请求不应再吃 3007')
  assert.equal(seen[2]['x-aliyun-captcha-verify-param'], 'param-2')
  assert.equal(result.accountId, 'acct-a')
})

test('200 但零内容 → 标记该账号并换号（调用方零 chunk）', async () => {
  const pool = fakePool([
    { id: 'acct-a', credential: CREDENTIAL },
    { id: 'acct-b', credential: { ...CREDENTIAL, user_id: 'u-2' } },
  ])
  let call = 0
  const fetchImpl = async () => {
    call += 1
    return response(200, call === 1 ? emptyStream() : textStream())
  }
  const client = new ZcodePlanClient({ pool, minter: fakeMinter(), fetchImpl })
  const picked = []
  const originalPick = pool.pick.bind(pool)
  pool.pick = (model, exclude) => {
    const hit = originalPick(model, exclude)
    if (hit !== null) picked.push(hit.entry.id)
    return hit
  }

  const result = await client.call({ options: baseOptions })
  assert.equal(result.accountId, 'acct-b')
  assert.deepEqual(picked, ['acct-a', 'acct-b'])
  assert.equal(pool.list()[0].model_rate_limits['GLM-5.3-Flash'] > Date.now(), true, 'acct-a 被标记到当日结束')
})

test('额度用尽（1005）→ 换号；两个号都用尽 → QUOTA 失败', async () => {
  const pool = fakePool([
    { id: 'acct-a', credential: CREDENTIAL },
    { id: 'acct-b', credential: { ...CREDENTIAL, user_id: 'u-2' } },
  ])
  const client = new ZcodePlanClient({
    pool,
    minter: fakeMinter(),
    fetchImpl: async () => response(429, '{"code":1005,"msg":"exceed quota limit"}', 'application/json'),
  })
  await assert.rejects(
    () => client.call({ options: baseOptions }),
    (error) => {
      assert.equal(error.code, 'QUOTA')
      return true
    },
  )
  assert.equal(pool.list().every((entry) => entry.model_rate_limits['GLM-5.3-Flash'] > Date.now()), true)
})

test('风控 3012 不重试、不换号，直接失败', async () => {
  let calls = 0
  const client = new ZcodePlanClient({
    pool: fakePool(),
    minter: fakeMinter(),
    fetchImpl: async () => {
      calls += 1
      return response(403, '{"code":3012,"msg":"unusual activity"}', 'application/json')
    },
  })
  await assert.rejects(
    () => client.call({ options: baseOptions }),
    (error) => {
      assert.equal(error.code, 'RATE_LIMIT')
      assert.match(error.message, /3012/)
      return true
    },
  )
  assert.equal(calls, 1, '3012 有冷却惩罚：绝不能连续重试')
})

test('并发限流 3009 退避重试但不换号', async () => {
  let calls = 0
  const client = new ZcodePlanClient({
    pool: fakePool(),
    minter: fakeMinter(),
    fetchImpl: async () => {
      calls += 1
      return calls === 1 ? response(429, '{"code":3009}', 'application/json') : response(200, textStream())
    },
  })
  const result = await client.call({ options: baseOptions })
  assert.equal(calls, 2)
  assert.equal(result.accountId, 'acct-a')
})

test('账号池为空 → QUOTA 并提示登录命令', async () => {
  const client = new ZcodePlanClient({ pool: fakePool([]), minter: fakeMinter(), fetchImpl: async () => response(200, textStream()) })
  await assert.rejects(
    () => client.call({ options: baseOptions }),
    (error) => {
      assert.equal(error.code, 'QUOTA')
      assert.match(error.message, /zcode-start-plan login/)
      return true
    },
  )
})

test('401 凭据失效 → AUTH，不换号', async () => {
  const client = new ZcodePlanClient({
    pool: fakePool(),
    minter: fakeMinter(),
    fetchImpl: async () => response(401, '{"code":1002}', 'application/json'),
  })
  await assert.rejects(
    () => client.call({ options: baseOptions }),
    (error) => {
      assert.equal(error.code, 'AUTH')
      return true
    },
  )
})
