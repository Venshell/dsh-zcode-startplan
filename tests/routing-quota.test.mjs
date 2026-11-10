/**
 * `/routing` 的**准入口径**回归测试（1.0.1 审计）。
 *
 * 用户实测故障：「面板显示额度开启，对话却提示额度耗尽」。
 *
 * 根因口径差：
 * - 面板 `/balance` 统计上游 `data.balances` 里**所有已激活 plan 的桶**；
 * - 对话准入看的是**当前生效**的那一桶 + 「账号 × 模型」的 1005 硬过滤标记。
 * 两者可以同时成立 —— 于是出现「显示有余量、下一句话立刻 zero content / 1005」。
 *
 * 本文件锁死两件事：
 * 1. `/routing` 必须把准入判定依据（`quota.available/limited/expired`）显式下发；
 * 2. `preview` 必须带 `?model=` 参与筛选，否则会预测一个 `pick` 根本不会选的账号。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { makeManageRoutes } from '../lib/manage-routes.js'
import { AccountPool, SqliteStore } from '../lib/pool.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const credential = (id) => ({ zcode_jwt: `jwt-${id}`, device_mid: `dev-${id}`, user_id: `u-${id}` })

function makeReqRes({ url = '/' } = {}) {
  const req = {
    method: 'GET',
    url,
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:58962' },
    on() {
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

async function call(routes, path, options) {
  const route = routes.find((item) => item.path === path)
  assert.ok(route !== undefined, `没有注册 ${path}`)
  const { req, res } = makeReqRes(options)
  await route.handler(req, res)
  return res
}

function withPool(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zsp-routing-'))
    const store = await new SqliteStore(join(dir, 'accounts.db'))
    try {
      await fn(new AccountPool({ store }), store, dir)
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

/** 上游余额：**已激活** plan 里还有一个 3 亿的桶，但 `balances` 里当前生效桶为 0。 */
const BALANCE_SHAPES = {
  /** 面板口径「有额度」：生效桶尚有余额。 */
  healthy: { remaining: 300_000_000, total: 300_000_000, expiresAt: Date.now() + 86_400_000 },
  /** 面板口径「有额度」，但实际生效桶为空（未生效领取包还在 balances 里）。 */
  onlyZeroBuckets: { remaining: 0, total: 0 },
  /** 余额接口整体不可用。 */
  failed: undefined,
}

const routesFor = (pool, balance) =>
  makeManageRoutes({
    pool,
    client: {},
    fetchBalance: async () => BALANCE_SHAPES[balance],
    settings: {},
    log: () => {},
  })

/** 等待后台余额拉取落进缓存（2s 轮询模型的第一次 tick 就发生在响应之后）。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10))

test('/routing: 上游已判额度用尽时，把「显示有额度 / 实际不可用」同时说清楚', withPool(async (pool) => {
  const a = pool.add(credential('a'), '主号').entry
  const model = 'GLM-5.3-Flash'
  /** 对话刚刚在这个账号上吃了 1005 / 零内容 → 当日硬过滤标记落库。 */
  pool.markModelRateLimited(a.id, model, Date.now() + 3_600_000)

  const routes = routesFor(pool, 'healthy')
  /**
   * 第一次：缓存还空（`source: pending`），只能报「准入层面已拒绝」。
   * 这正是用户看到的那一刻——面板还没刷新，对话已经报错。
   */
  const first = await call(routes, '/api/zcode-start-plan/routing', { url: `/api/zcode-start-plan/routing?model=${model}` })
  assert.equal(first.status, 200)
  const firstAccount = first.body.accounts.find((entry) => entry.accountId === a.id)
  assert.equal(firstAccount.quota.limited, true, '1005 标记必须暴露')
  /**
   * 准入已拒：`usable` 必定 false（即使 `source: pending` 还没拉到余额）；
   * `available` 此时是 null（未知），因为面板口径还没数据。
   */
  assert.equal(firstAccount.quota.usable, false, '准入已拒 → 综合结论不可用')
  assert.equal(firstAccount.quota.available, null, '面板口径未知 ≠ 已用光')
  assert.equal(firstAccount.quota.source, 'pending')

  /** 第二次：后台拉到了「生效桶还有 3 亿」→ 冲突组合完整呈现。 */
  await settle()
  const second = await call(routes, '/api/zcode-start-plan/routing', { url: `/api/zcode-start-plan/routing?model=${model}` })
  const secondAccount = second.body.accounts.find((entry) => entry.accountId === a.id)
  assert.equal(secondAccount.quota.source, 'upstream')
  assert.equal(secondAccount.quota.available, true, '面板口径：上游生效桶有余量')
  assert.equal(secondAccount.quota.limited, true, '对话口径：该账号×模型已被硬过滤')
  assert.equal(secondAccount.quota.usable, false, '综合结论：不可用')
  /** 前端靠 available && limited 判定「需要显式警告」的那个组合。 */
  assert.equal(secondAccount.quota.available === true && secondAccount.quota.limited === true, true)
  assert.match(secondAccount.quota.reason, /额度用尽/)
  /** 绝不下发凭据。 */
  assert.equal(JSON.stringify(second.body).includes('jwt-a'), false)
  assert.equal(JSON.stringify(second.body).includes('dev-a'), false)
}))

test('/routing: preview 必须带 ?model= 才与 pick 同口径', withPool(async (pool) => {
  const a = pool.add(credential('a'), 'A').entry
  const b = pool.add(credential('b'), 'B').entry
  pool.markModelRateLimited(a.id, 'GLM-5.3-Flash', Date.now() + 3_600_000)

  const routes = routesFor(pool, 'healthy')
  /** 带模型：跳过 A，预测 B（= pick 结果）。 */
  const withModel = await call(routes, '/api/zcode-start-plan/routing', {
    url: '/api/zcode-start-plan/routing?model=GLM-5.3-Flash',
  })
  assert.equal(withModel.body.preview.accountId, b.id)
  assert.equal(withModel.body.preview.model, 'GLM-5.3-Flash')

  /** 不带模型：语义是「不按模型过滤」，会预测 A —— 这就是 1.0.0 的 bug。 */
  const withoutModel = await call(routes, '/api/zcode-start-plan/routing', { url: '/api/zcode-start-plan/routing' })
  assert.equal(withoutModel.body.preview.accountId, a.id)
  assert.equal(withoutModel.body.preview.model, null, '响应必须标明「这次没有按模型预览」')
}))

/**
 * 判据边界（2026-11-10 变更）：`quotaState.limited` **只看 `model_rate_limits`**。
 *
 * `last_error` 是无时间戳的历史文本，已从选号判据中删除；若 `/routing` 仍旧
 * 按它判 limited，面板会与对话**再次矛盾** —— 对话照常发请求（能成功），
 * 面板却红着说「已判额度用尽」。这条锁死两边同口径。
 */
test('/routing: 只有 last_error 写着 1005、model_rate_limits 为空 → 不判 limited', withPool(async (pool) => {
  const a = pool.add(credential('a'), '主号').entry
  const model = 'GLM-5.3-Flash'
  /** 历史文本（额度次日恢复后仍会留着）—— 不是判据。 */
  pool.noteError(a.id, '额度用尽（1005 exceed quota limit）')

  assert.deepEqual(pool.list()[0].model_rate_limits, {}, '前置：硬标记表为空')

  const routes = routesFor(pool, 'healthy')
  /** 等后台余额拉取落进缓存（否则面板口径还是 pending / available=null）。 */
  await call(routes, '/api/zcode-start-plan/routing', { url: `/api/zcode-start-plan/routing?model=${model}` })
  await settle()
  const response = await call(routes, '/api/zcode-start-plan/routing', {
    url: `/api/zcode-start-plan/routing?model=${model}`,
  })
  const account = response.body.accounts.find((entry) => entry.accountId === a.id)
  assert.equal(account.quota.source, 'upstream', '前置：面板口径已拉到上游余额')
  assert.equal(account.quota.limited, false, 'last_error 不是准入判据：没有当日硬标记就不许判 limited')
  assert.equal(account.quota.usable, true, '面板口径有额度 + 无否决位 → 可用（与对话一致）')
  assert.equal(account.quota.reason, null, '不得给出「已判额度用尽」这类结论')

  /** 对照：同一个账号一旦真的落了硬标记，limited 立刻为 true。 */
  pool.markModelRateLimited(a.id, model, Date.now() + 3_600_000)
  const after = await call(routes, '/api/zcode-start-plan/routing', {
    url: `/api/zcode-start-plan/routing?model=${model}`,
  })
  assert.equal(
    after.body.accounts.find((entry) => entry.accountId === a.id).quota.limited,
    true,
    '硬标记才是 limited 的唯一依据',
  )
}))

test('/routing: 余额接口失败走退避，不把 null 当成「已用光」', withPool(async (pool) => {
  let calls = 0
  pool.add(credential('a'), 'A')
  const routes = makeManageRoutes({
    pool,
    client: {},
    fetchBalance: async () => {
      calls += 1
      return undefined
    },
    settings: {},
    log: () => {},
  })
  await call(routes, '/api/zcode-start-plan/routing', { url: '/api/zcode-start-plan/routing' })
  await settle()
  assert.equal(calls, 1)
  const again = await call(routes, '/api/zcode-start-plan/routing', { url: '/api/zcode-start-plan/routing' })
  /** 失败条目在退避窗口内不再重试（否则 2s 轮询每轮打一次上游）。 */
  assert.equal(calls, 1, '失败后必须退避')
  const account = again.body.accounts[0]
  assert.equal(account.usedRatio, null, '未知不能显示成 100%')
  assert.equal(account.quota.source, 'failed')
  assert.equal(account.quota.available, null, '未知不能显示成「有额度」')
}))

test('/routing: 账号删除后额度缓存同步丢弃', withPool(async (pool) => {
  const a = pool.add(credential('a'), 'A').entry
  const routes = routesFor(pool, 'healthy')
  await call(routes, '/api/zcode-start-plan/routing', { url: '/api/zcode-start-plan/routing' })
  await settle()

  const req = {
    method: 'POST',
    url: '/api/zcode-start-plan/remove',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:58962', 'content-type': 'application/json' },
    on(event, handler) {
      if (event === 'data') handler(Buffer.from(JSON.stringify({ id: a.id })))
      if (event === 'end') handler()
      return req
    },
    destroy() {},
  }
  const res = makeReqRes().res
  await routes.find((item) => item.path === '/api/zcode-start-plan/remove').handler(req, res)
  assert.equal(pool.list().length, 0)
  /** 再查一次不应因残留缓存而崩溃或复活该账号。 */
  const after = await call(routes, '/api/zcode-start-plan/routing', { url: '/api/zcode-start-plan/routing' })
  assert.equal(after.body.accounts.length, 0)
  assert.equal(after.body.preview, null)
}))
