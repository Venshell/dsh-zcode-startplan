/**
 * 赠送额度领取（/claimable + /claim）的**路由级**测试。
 *
 * 上游 HTTP 全部换成假 fetch，但走真实的 `lib/upstream-api.js` 解析与
 * `lib/manage-routes.js` 的路由装配 —— 断言的是「面板点一次按钮，宿主到底
 * 发了什么、怎么处理 captcha」。
 *
 * 三条不可动摇的约定（来自上游实测）：
 * 1. captcha **一次性**：每个 plan 必须重新 mint，复用必 3007；
 * 2. `1003` = 已领过，是**幂等成功**，不能报红；
 * 3. captcha 产出失败时**立刻停**，不要连环重试烧设备信誉。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { makeManageRoutes } from '../lib/manage-routes.js'

/** 极简 req/res 桩：够 readJsonBody / writeJson 用。 */
function makeReqRes({ method = 'GET', url = '/', body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const req = {
    method,
    url,
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:58962', 'content-type': 'application/json' },
    on(event, handler) {
      if (event === 'data') chunks.forEach((chunk) => handler(chunk))
      if (event === 'end') handler()
      return req
    },
    destroy() {},
  }
  let captured
  let status = 200
  const res = {
    writableEnded: false,
    destroyed: false,
    writeHead(code) {
      status = code
    },
    end(text) {
      res.writableEnded = true
      captured = text
    },
    get body() {
      return captured === undefined ? undefined : JSON.parse(captured)
    },
    get status() {
      return status
    },
  }
  return { req, res }
}

/** 账号池桩：一条账号、带凭据。 */
const pool = {
  list: ({ withCredentials } = {}) => [
    {
      id: 'acc-1',
      nickname: 'TARGET_ACCOUNT',
      enabled: true,
      user_id: 'user-1',
      added_at: 1,
      model_rate_limits: {},
      last_error: null,
      ...(withCredentials === true
        ? { credential: { zcode_jwt: 'ZCODE_JWT', device_mid: 'DEVICE_MID', app_version: '3.14.3' } }
        : {}),
    },
  ],
  get: (id) => undefined,
}

/** 找到某条路由并调用。 */
async function call(routes, path, options) {
  const route = routes.find((item) => item.path === path)
  assert.ok(route !== undefined, `没有注册 ${path}`)
  const { req, res } = makeReqRes(options)
  await route.handler(req, res)
  return res
}

/** 可领取的活动（priority 降序由 fetchClaimablePlans 排）。 */
const CLAIMABLE_PLANS = [
  { plan_id: 'plan-low', name: 'LOW', priority: 10 },
  { plan_id: 'plan-high', name: 'HIGH', priority: 90 },
]

/** 假上游：按 URL 分发，并记录 captcha 头，供断言「每个 plan 都重新 mint」。 */
function makeUpstream({ claimCodes = [0, 0], captchaFails = false } = {}) {
  const calls = { claim: [], captchaHeaders: [], preview: 0, report: 0 }
  let claimIndex = 0
  const fetchImpl = async (url, init = {}) => {
    const target = String(url)
    if (target.includes('/event/report')) {
      calls.report += 1
      return new Response(JSON.stringify({ code: 0 }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (target.includes('/billing/preview')) {
      calls.preview += 1
      return new Response(JSON.stringify({ code: 0, data: { plans: CLAIMABLE_PLANS } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (target.includes('/billing/claim')) {
      const payload = JSON.parse(init.body)
      calls.claim.push(payload.plan_id)
      calls.captchaHeaders.push(init.headers['x-aliyun-captcha-verify-param'])
      const code = claimCodes[claimIndex++] ?? 0
      return new Response(JSON.stringify({ code, msg: code === 0 ? '' : 'x' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    throw new Error(`未预期的上游请求：${target}`)
  }
  /** captcha minter 桩：每次给一个新 param（一次性）。 */
  let seq = 0
  const client = {
    async mintCaptcha() {
      if (captchaFails) throw new Error('连不上宿主调试端口')
      seq += 1
      return { param: `param-${seq}`, region: 'cn' }
    },
  }
  return { fetchImpl, client, calls }
}

/**
 * ⚠ `lib/upstream-api.js` 用**模块级** `globalThis.fetch` 默认值。
 * 这里临时替换全局 fetch（测试单进程串行跑，用完立刻还原）。
 */
async function withGlobalFetch(fetchImpl, fn) {
  const original = globalThis.fetch
  globalThis.fetch = fetchImpl
  try {
    return await fn()
  } finally {
    globalThis.fetch = original
  }
}

function buildRoutes(client) {
  return makeManageRoutes({
    pool,
    client,
    fetchBalance: async () => undefined,
    settings: {},
    log: () => {},
  })
}

test('/claimable: 先补活跃上报再查 preview，返回可领列表', async () => {
  const { fetchImpl, client, calls } = makeUpstream()
  const routes = buildRoutes(client)
  const res = await withGlobalFetch(fetchImpl, () => call(routes, '/api/zcode-start-plan/claimable', { url: '/api/zcode-start-plan/claimable?id=acc-1' }))

  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.equal(calls.report, 2, 'reportActivation 会发两个事件（launch + daily_active）')
  assert.deepEqual(
    res.body.plans.map((plan) => plan.planId),
    ['plan-high', 'plan-low'],
    'priority 降序',
  )
})

test('/claim: 每个 plan 重新 mint captcha（param 不同），全部成功', async () => {
  const { fetchImpl, client, calls } = makeUpstream({ claimCodes: [0, 0] })
  const routes = buildRoutes(client)
  const res = await withGlobalFetch(fetchImpl, () => call(routes, '/api/zcode-start-plan/claim', { method: 'POST', body: { id: 'acc-1' } }))

  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.deepEqual(calls.claim, ['plan-high', 'plan-low'])
  assert.deepEqual(calls.captchaHeaders, ['param-1', 'param-2'], '两次领取必须用不同的 captcha param')
  assert.equal(res.body.results.length, 2)
  assert.ok(res.body.results.every((item) => item.ok === true))
})

test('/claim: 1003（已领过）算幂等成功，不报错', async () => {
  const { fetchImpl, client } = makeUpstream({ claimCodes: [1003] })
  const routes = buildRoutes(client)
  const res = await withGlobalFetch(fetchImpl, () =>
    call(routes, '/api/zcode-start-plan/claim', { method: 'POST', body: { id: 'acc-1', planId: 'plan-high' } }),
  )

  assert.equal(res.body.ok, true, '已领过不能算失败')
  assert.equal(res.body.results[0].ok, true)
  assert.equal(res.body.results[0].alreadyClaimed, true)
})

test('/claim: 指定 planId 只领那一个', async () => {
  const { fetchImpl, client, calls } = makeUpstream()
  const routes = buildRoutes(client)
  await withGlobalFetch(fetchImpl, () =>
    call(routes, '/api/zcode-start-plan/claim', { method: 'POST', body: { id: 'acc-1', planId: 'plan-low' } }),
  )
  assert.deepEqual(calls.claim, ['plan-low'])
})

test('/claim: captcha 产出失败即停，不连环重试', async () => {
  const { fetchImpl, client, calls } = makeUpstream({ captchaFails: true })
  const routes = buildRoutes(client)
  const res = await withGlobalFetch(fetchImpl, () =>
    call(routes, '/api/zcode-start-plan/claim', { method: 'POST', body: { id: 'acc-1' } }),
  )

  assert.equal(res.body.ok, false)
  assert.match(res.body.results[0].error, /captcha 产出失败/)
  assert.equal(calls.claim.length, 0, 'captcha 没拿到就绝不能打 claim（烧设备信誉）')
  assert.equal(res.body.results.length, 1, '失败后不再尝试第二个 plan')
})

test('/claimable: 账号不存在给 404；未知路径不会误配', async () => {
  const { fetchImpl, client } = makeUpstream()
  const routes = buildRoutes(client)
  const res = await withGlobalFetch(fetchImpl, () =>
    call(routes, '/api/zcode-start-plan/claimable', { url: '/api/zcode-start-plan/claimable?id=nope' }),
  )
  assert.equal(res.status, 404)
  assert.equal(res.body.ok, false)
})

test('/claim: 缺 id 给 400', async () => {
  const { fetchImpl, client } = makeUpstream()
  const routes = buildRoutes(client)
  const res = await withGlobalFetch(fetchImpl, () =>
    call(routes, '/api/zcode-start-plan/claim', { method: 'POST', body: {} }),
  )
  assert.equal(res.status, 400)
})

test('/restart-cdp: 把 debugPort 与等待时长交给重启实现，不阻塞响应', async () => {
  const calls = []
  const routes = makeManageRoutes({
    pool,
    client: {},
    fetchBalance: async () => undefined,
    settings: {},
    log: () => {},
    requestRestart: async (options) => {
      calls.push(options)
    },
  })
  const res = await call(routes, '/api/zcode-start-plan/restart-cdp', {
    method: 'POST',
    body: { debugPort: 9333, waitSeconds: 5 },
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.debugPort, 9333)
  assert.deepEqual(calls, [{ debugPort: 9333, waitSeconds: 5 }])
  assert.equal(typeof res.body.estimatedReadyMs, 'number')
})

test('/restart-cdp: 非法端口给 400，且不触发重启', async () => {
  const calls = []
  const routes = makeManageRoutes({
    pool,
    client: {},
    settings: {},
    log: () => {},
    requestRestart: async (options) => calls.push(options),
  })
  const res = await call(routes, '/api/zcode-start-plan/restart-cdp', { method: 'POST', body: { debugPort: 99999 } })
  assert.equal(res.status, 400)
  assert.equal(calls.length, 0, '参数不合法时绝不能真的去重启宿主')
})

test('/restart-cdp: 宿主没提供重启实现时给 501（而不是假装成功）', async () => {
  const routes = makeManageRoutes({ pool, client: {}, settings: {}, log: () => {} })
  const res = await call(routes, '/api/zcode-start-plan/restart-cdp', { method: 'POST', body: {} })
  assert.equal(res.status, 501)
  assert.match(res.body.error, /不支持自动重启/)
})

test('/restart-cdp: 重启实现抛错时把原因透出来', async () => {
  const routes = makeManageRoutes({
    pool,
    client: {},
    settings: {},
    log: () => {},
    requestRestart: async () => {
      throw new Error('找不到 DeepSeek Harness.exe')
    },
  })
  const res = await call(routes, '/api/zcode-start-plan/restart-cdp', { method: 'POST', body: {} })
  assert.equal(res.status, 500)
  assert.match(res.body.error, /找不到/)
})
