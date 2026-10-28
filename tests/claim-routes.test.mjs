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

/** 官方形状的 marketing/touch 投放（claim 按钮携带 plan_id）。 */
const marketingTouchBody = {
  code: 0,
  data: {
    server_time: 1790000000,
    language: 'zh-CN',
    deliveries: [
      {
        campaign_id: 'camp-low',
        priority: 10,
        resource_position: 'popup',
        popup: { buttons: [{ text: { format: 'plaintext', content: 'LOW' }, action: { type: 'claim_zcode_plan', args: { plan_id: 'plan-low' } } }] },
      },
      {
        campaign_id: 'camp-high',
        priority: 90,
        resource_position: 'banner',
        banner: { buttons: [{ text: { format: 'plaintext', content: 'HIGH' }, action: { type: 'claim_zcode_plan', args: { plan_id: 'plan-high' } } }] },
      },
    ],
  },
}

/** 假上游：按 URL 分发，并记录 captcha 头，供断言「每个 plan 都重新 mint」。 */
function makeUpstream({ claimCodes = [0, 0], captchaFails = false } = {}) {
  const calls = { claim: [], captchaHeaders: [], touch: 0, report: 0 }
  let claimIndex = 0
  const fetchImpl = async (url, init = {}) => {
    const target = String(url)
    if (target.includes('/event/report')) {
      calls.report += 1
      return new Response(JSON.stringify({ code: 0 }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (target.includes('/marketing/touch')) {
      calls.touch += 1
      return new Response(JSON.stringify(marketingTouchBody), {
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

test('/claimable: 走官方 marketing/touch 发现端点，返回投放按钮里的 plan 列表', async () => {
  const { fetchImpl, client, calls } = makeUpstream()
  const routes = buildRoutes(client)
  const res = await withGlobalFetch(fetchImpl, () => call(routes, '/api/zcode-start-plan/claimable', { url: '/api/zcode-start-plan/claimable?id=acc-1' }))

  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.equal(calls.touch, 1, '发现走 marketing/touch（官方同款）')
  assert.equal(calls.report, 2, 'reportActivation 仍会补两个活跃事件（与官方启动行为一致）')
  assert.deepEqual(
    res.body.plans.map((plan) => plan.planId),
    ['plan-high', 'plan-low'],
    'priority 降序',
  )
  assert.equal(res.body.plans[0].campaignId, 'camp-high', 'campaignId 供 action 上报')
})

/**
 * ⚠ 语义变更（2026-10-28）：`/claim` 不再「先查 preview 再领」。
 *
 * 实证：官方 ZCode 客户端全天 0 次调用 `getManualClaimPlanPreviews`
 * （`/billing/preview`），点击时直接调 `claimManualPlan`（`/billing/claim`）。
 * 我们照抄源码里存在但从未被使用的方法，导致面板永远「暂无可领取」。
 *
 * 新语义：`planId` 必填，直接 claim，业务码原样回传。
 * 「有没有名额」由服务端裁决（0 成功 / 1003 已领过 / 1005 领完）。
 */
test('/claim: 直接按 planId 领取，不碰 preview', async () => {
  const { fetchImpl, client, calls } = makeUpstream({ claimCodes: [0] })
  const routes = buildRoutes(client)
  const res = await withGlobalFetch(fetchImpl, () =>
    call(routes, '/api/zcode-start-plan/claim', { method: 'POST', body: { id: 'acc-1', planId: 'plan-high' } }),
  )

  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.deepEqual(calls.claim, ['plan-high'])
  assert.equal(calls.preview, undefined, '绝不调用 /billing/preview —— 官方客户端也不调它')
  assert.equal(calls.touch, 0, '直接领取也不需要先探测（captcha 只为 claim 烧）')
  assert.equal(res.body.results.length, 1)
  assert.equal(res.body.results[0].ok, true)
})

test('/claim: 缺 planId 给 400（不再靠 preview 兜底猜 plan）', async () => {
  const { fetchImpl, client, calls } = makeUpstream()
  const routes = buildRoutes(client)
  const res = await withGlobalFetch(fetchImpl, () =>
    call(routes, '/api/zcode-start-plan/claim', { method: 'POST', body: { id: 'acc-1' } }),
  )
  assert.equal(res.status, 400)
  assert.match(res.body.error, /planId/)
  assert.equal(calls.claim.length, 0, '参数不全时不能发 claim（会白发 captcha）')
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

test('/claim: captcha 失败只重试一次，仍失败则不碰 claim', async () => {
  const { fetchImpl, client, calls } = makeUpstream({ captchaFails: true })
  const routes = buildRoutes(client)
  const res = await withGlobalFetch(fetchImpl, () =>
    call(routes, '/api/zcode-start-plan/claim', { method: 'POST', body: { id: 'acc-1', planId: 'plan-high' } }),
  )

  assert.equal(res.body.ok, false)
  assert.match(res.body.results[0].error, /captcha 产出失败（尝试 2 次）/)
  assert.equal(calls.claim.length, 0, 'captcha 没拿到就绝不能打 claim（烧设备信誉）')
})

/**
 * ⚠ 「按两次才领到」的服务端侧对策。
 *
 * 官方客户端日志实证（2026-10-28 21:00）：一次点击里
 * `send_preflight outcome=error` → 6 秒后 `outcome=success` → 才发 claim。
 * 根因是阿里云 CDN 首轮抖动（连续 4 次 resource.failed，几十到两百毫秒）。
 * 所以我们也要**原地重试一次**，而不是一失败就把错误甩给用户。
 */
test('/claim: captcha 首次失败、第二次成功 → 正常领取（对应"按两次"）', async () => {
  const { fetchImpl, client, calls } = makeUpstream({ claimCodes: [0] })
  let mintCount = 0
  const flakyClient = {
    async mintCaptcha() {
      mintCount += 1
      if (mintCount === 1) throw new Error('阿里云 CDN 抖动（模拟首轮 resource.failed）')
      return { param: `param-retry-${mintCount}`, region: 'cn' }
    },
  }
  const routes = buildRoutes(flakyClient)
  const res = await withGlobalFetch(fetchImpl, () =>
    call(routes, '/api/zcode-start-plan/claim', { method: 'POST', body: { id: 'acc-1', planId: 'plan-high' } }),
  )

  assert.equal(mintCount, 2, 'captcha 必须重试一次')
  assert.equal(res.body.ok, true)
  assert.deepEqual(calls.claim, ['plan-high'])
  assert.equal(calls.captchaHeaders[0], 'param-retry-2', '使用重试拿到的 param')
})

test('/claim: 1005（领完）原样回传业务码，不吞成含糊失败', async () => {
  const { fetchImpl, client } = makeUpstream({ claimCodes: [1005] })
  const routes = buildRoutes(client)
  const res = await withGlobalFetch(fetchImpl, () =>
    call(routes, '/api/zcode-start-plan/claim', { method: 'POST', body: { id: 'acc-1', planId: 'plan-high' } }),
  )
  assert.equal(res.body.ok, false)
  assert.equal(res.body.results[0].code, 1005, '业务码必须原样回传，供面板如实显示')
  assert.equal(res.body.results[0].httpStatus, 200)
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
