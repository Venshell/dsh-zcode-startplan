/**
 * 「每账号一个 provider 栏位」（workbuddy 模式）的契约测试：
 *
 * 1. id 编解码（lib/pinned-model.js，0.3.0 形态仍向后兼容）；
 * 2. adapter 多路由：统一栏位 + 每账号栏位，可见性 = 空目录；
 *    宿主契约（rc.3 源码核实）：
 *    - `prepareRoutes` 要求 `providerInfo(provider).id === provider` 且 name 非空；
 *    - `listModels` 只要求 id 非空且全表不重复（空数组 = 隐藏分组）；
 *    - `normalizeModelInfo` 要求 `resolveModel` 返回的 `id` 与请求原样一致；
 * 3. plan-client：路由级钉定（pinnedAccountId）只消耗指定账号；
 *    `@acct:` 后缀仍生效；额度尽报 QUOTA 不换号。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { makePinnedModelId, parsePinnedModelId, isPinnedModelId } from '../lib/pinned-model.js'
import { AccountPool, SqliteStore } from '../lib/pool.js'
import { ZcodePlanClient } from '../lib/plan-client.js'
import { NativeZcodeStartPlanAdapter } from '../lib/adapter.js'
import { resolveConfig, Config } from '../index.js'

const cred = (tag) => ({ zcode_jwt: `jwt-${tag}`, device_mid: `dev-${tag}`, user_id: `u-${tag}` })

const sseStream = (events) =>
  new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()
      for (const event of events) controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`))
      controller.close()
    },
  })

const okResponse = (body) => ({
  ok: true,
  status: 200,
  headers: new Headers({ 'content-type': 'text/event-stream' }),
  body,
})

const textStream = () =>
  sseStream([
    { type: 'message_start', message: { model: 'GLM-5.3-Flash', usage: { input_tokens: 5 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '好的' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ])

async function makePool(t, tag) {
  const dir = mkdtempSync(join(tmpdir(), `zsp-${tag}-`))
  const store = await new SqliteStore(join(dir, 'accounts.db'))
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  return new AccountPool({ store })
}

const baseModels = async () => [
  { id: 'GLM-5.3-Flash', name: 'GLM-5.3-Flash', contextWindow: 1_000_000, maxTokens: 65_536, supportsImage: true },
  { id: 'GLM-5.3', name: 'GLM-5.3', contextWindow: 1_000_000, maxTokens: 65_536, supportsImage: false },
]

test('pinned-model：编解码往返与边界（0.3.0 形态向后兼容）', () => {
  const id = makePinnedModelId('GLM-5.3-Flash', 'abc-123')
  assert.equal(id, 'GLM-5.3-Flash@acct:abc-123')
  assert.deepEqual(parsePinnedModelId(id), { baseModelId: 'GLM-5.3-Flash', accountId: 'abc-123' })
  assert.equal(isPinnedModelId(id), true)
  assert.equal(parsePinnedModelId('GLM-5.3'), null)
  assert.equal(parsePinnedModelId('GLM-5.3@acct:'), null)
  assert.equal(parsePinnedModelId('@acct:x'), null)
  assert.equal(parsePinnedModelId(undefined), null)
})

test('adapter：账号路由派生互逆', async (t) => {
  const pool = await makePool(t, 'route')
  const adapter = new NativeZcodeStartPlanAdapter({
    client: {},
    models: baseModels,
    provider: 'zcode-start-plan',
    pool,
  })
  const route = NativeZcodeStartPlanAdapter.accountRoute('zcode-start-plan', 'abc')
  assert.equal(route, 'zcode-start-plan-acct-abc')
  assert.equal(NativeZcodeStartPlanAdapter.accountIdFromRoute('zcode-start-plan', route), 'abc')
  /** 统一路由不是账号路由。 */
  assert.equal(NativeZcodeStartPlanAdapter.accountIdFromRoute('zcode-start-plan', 'zcode-start-plan'), null)
  assert.equal(NativeZcodeStartPlanAdapter.accountIdFromRoute('zcode-start-plan', 'zcode-start-plan-acct-'), null)
  /** accountRoutes：只列启用账号。 */
  const first = pool.add(cred('a'), '主号')
  const second = pool.add(cred('b'), '国际号')
  pool.setEnabled(second.entry.id, false)
  const routes = await adapter.accountRoutes()
  assert.equal(routes.length, 1)
  assert.equal(routes[0].accountId, first.entry.id)
  assert.equal(routes[0].provider, NativeZcodeStartPlanAdapter.accountRoute('zcode-start-plan', first.entry.id))
  assert.equal(routes[0].nickname, '主号')
})

test('adapter.providerInfo：账号栏位名「ZCode Start Plan · 昵称」，prepareRoutes 契约全过', async (t) => {
  const pool = await makePool(t, 'info')
  const first = pool.add(cred('a'), '主号')
  const adapter = new NativeZcodeStartPlanAdapter({
    client: {},
    models: baseModels,
    provider: 'zcode-start-plan',
    pool,
  })
  const route = NativeZcodeStartPlanAdapter.accountRoute('zcode-start-plan', first.entry.id)
  const info = adapter.providerInfo(route)
  assert.equal(info.id, route, '宿主 prepareRoutes 要求 info.id === provider')
  assert.equal(info.name, 'ZCode Start Plan · 主号')
  const unified = adapter.providerInfo('zcode-start-plan')
  assert.equal(unified.id, 'zcode-start-plan')
  assert.ok(unified.name.length > 0)
  /** 已删除的账号也要有合法 name（路由残留期间不炸）。 */
  pool.remove(first.entry.id)
  const orphan = adapter.providerInfo(route)
  assert.equal(orphan.id, route)
  assert.ok(orphan.name.length > 0)
})

test('adapter.listModels：账号栏位只列该账号；停用/删除 = 空目录（隐藏分组）', async (t) => {
  const pool = await makePool(t, 'list')
  const first = pool.add(cred('a'), '主号')
  const adapter = new NativeZcodeStartPlanAdapter({
    client: {},
    models: baseModels,
    provider: 'zcode-start-plan',
    pool,
  })

  const route = NativeZcodeStartPlanAdapter.accountRoute('zcode-start-plan', first.entry.id)
  const models = await adapter.listModels(route)
  assert.equal(models.length, 2, '该账号栏位 = 基础模型目录')
  const seen = new Set()
  for (const model of models) {
    assert.equal(model.provider, route)
    assert.ok(model.id.length > 0)
    assert.ok(model.name.length > 0)
    assert.equal(seen.has(model.id), false)
    seen.add(model.id)
  }
  assert.ok(models[0].description.includes('主号'))
  assert.equal(models[0].context.contextWindow, 1_000_000, '继承基础模型元数据')

  /** 停用 = 空目录 = 宿主隐藏分组（workbuddy 可见性机制）。 */
  pool.setEnabled(first.entry.id, false)
  assert.deepEqual(await adapter.listModels(route), [])

  /** 统一栏位默认可见。 */
  const unified = await adapter.listModels('zcode-start-plan')
  assert.equal(unified.length, 2)
  assert.deepEqual(unified.map((model) => model.id), ['GLM-5.3-Flash', 'GLM-5.3'])
  /** 关掉统一栏位 = 空目录，路由保留。 */
  adapter.setUnifiedVisible(false)
  assert.deepEqual(await adapter.listModels('zcode-start-plan'), [])
  adapter.setUnifiedVisible(true)
  assert.equal((await adapter.listModels('zcode-start-plan')).length, 2)
})

test('adapter.resolveModel：返回 id 与请求原样一致（INVALID_MODEL_INFO 契约）', async (t) => {
  const pool = await makePool(t, 'resolve')
  pool.add(cred('a'), '主号')
  const adapter = new NativeZcodeStartPlanAdapter({
    client: {},
    models: baseModels,
    provider: 'zcode-start-plan',
    pool,
  })
  const resolved = await adapter.resolveModel('zcode-start-plan', 'GLM-5.3-Flash')
  assert.equal(resolved.id, 'GLM-5.3-Flash')
  assert.equal(resolved.provider, 'zcode-start-plan')
  /** 账号栏位上解析基础模型 id：id 原样（宿主 normalizeModelInfo 硬契约）。 */
  const route = NativeZcodeStartPlanAdapter.accountRoute('zcode-start-plan', pool.list()[0].id)
  const pinnedResolved = await adapter.resolveModel(route, 'GLM-5.3-Flash')
  assert.equal(pinnedResolved.id, 'GLM-5.3-Flash')
  assert.equal(pinnedResolved.provider, route)
  /** 0.3.0 的 @acct: 后缀也原样放行。 */
  const legacy = makePinnedModelId('GLM-5.3-Flash', 'any-account')
  assert.equal((await adapter.resolveModel('zcode-start-plan', legacy)).id, legacy)
})

test('plan-client：路由级钉定只消耗指定账号（不按置顶顺序），上游见基础模型 id', async (t) => {
  const pool = await makePool(t, 'pin')
  const first = pool.add(cred('a'), '主号')
  pool.add(cred('b'), '国际号')

  let capturedBody
  let capturedAuth = ''
  const fetchImpl = async (_url, init) => {
    capturedBody = JSON.parse(init.body)
    /** fetch 头大小写不敏感，但假实现拿到的是普通对象 —— 逐键找。 */
    for (const [key, value] of Object.entries(init.headers ?? {})) {
      if (key.toLowerCase() === 'authorization') capturedAuth = value
    }
    return okResponse(textStream())
  }
  const client = new ZcodePlanClient({
    pool,
    minter: { async mint() { return { param: 'p', interactive: false } }, async fetchConfig() { return undefined } },
    fetchImpl,
  })
  const adapter = new NativeZcodeStartPlanAdapter({
    client,
    models: baseModels,
    provider: 'zcode-start-plan',
    pool,
  })

  /** 置顶「国际号」，请求走「主号」的路由 → 发出去的必须是主号的凭据。 */
  const ids = pool.list().map((entry) => entry.id)
  pool.reorder([ids[1], ids[0]])

  const route = NativeZcodeStartPlanAdapter.accountRoute('zcode-start-plan', first.entry.id)
  const chunks = []
  for await (const chunk of adapter.stream({
    provider: route,
    model: 'GLM-5.3-Flash',
    maxTokens: 64,
    messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
  })) {
    chunks.push(chunk)
  }
  assert.equal(chunks[chunks.length - 1].type, 'finish')
  assert.equal(chunks[chunks.length - 1].reason.kind, 'stop')
  assert.equal(capturedBody.model, 'GLM-5.3-Flash', '上游只见基础模型 id')
  assert.equal(capturedAuth, 'Bearer jwt-a', '路由钉定生效：用的是主号的凭据')
})

test('adapter：setAccountVisible 隐藏栏位 = 空目录（每卡片开关的落点）', async (t) => {
  const pool = await makePool(t, 'vis')
  const first = pool.add(cred('a'), '主号')
  const adapter = new NativeZcodeStartPlanAdapter({
    client: {},
    models: baseModels,
    provider: 'zcode-start-plan',
    pool,
  })
  const route = NativeZcodeStartPlanAdapter.accountRoute('zcode-start-plan', first.entry.id)

  /** 默认显示。 */
  assert.equal((await adapter.listModels(route)).length, 2)
  assert.equal(adapter.isAccountVisible(first.entry.id), true)

  /** 面板开关关掉 = 空目录（路由保留），与统一栏位同一机制。 */
  adapter.setAccountVisible(first.entry.id, false)
  assert.deepEqual(await adapter.listModels(route), [])
  assert.equal(adapter.isAccountVisible(first.entry.id), false)

  /** 打开恢复显示；对未知 id 打开也无害。 */
  adapter.setAccountVisible(first.entry.id, true)
  assert.equal((await adapter.listModels(route)).length, 2)
  adapter.setAccountVisible('unknown-id', true)
  assert.equal((await adapter.listModels(route)).length, 2)

  /** 构造时也可以带初始隐藏集合（settings.json 恢复）。 */
  const hiddenAtBoot = new NativeZcodeStartPlanAdapter({
    client: {},
    models: baseModels,
    provider: 'zcode-start-plan',
    pool,
    hiddenAccounts: [first.entry.id],
  })
  assert.deepEqual(await hiddenAtBoot.listModels(route), [])
  /** 隐藏只影响目录，不影响钉定请求（老会话仍能走该路由）。 */
  const client = new ZcodePlanClient({
    pool,
    minter: { async mint() { return { param: 'p', interactive: false } }, async fetchConfig() { return undefined } },
    fetchImpl: async () => okResponse(textStream()),
  })
  const hiddenAdapter = new NativeZcodeStartPlanAdapter({ client, models: baseModels, provider: 'zcode-start-plan', pool, hiddenAccounts: [first.entry.id] })
  const chunks = []
  for await (const chunk of hiddenAdapter.stream({
    provider: route,
    model: 'GLM-5.3-Flash',
    maxTokens: 64,
    messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
  })) {
    chunks.push(chunk)
  }
  assert.equal(chunks[chunks.length - 1].reason.kind, 'stop', '隐藏栏位不阻断已选它的会话')
})

test('plan-client：@acct: 后缀仍生效（0.3.0 兼容）', async (t) => {  const pool = await makePool(t, 'legacy')
  const first = pool.add(cred('a'), '主号')
  pool.add(cred('b'), '国际号')

  let capturedAuth = ''
  const fetchImpl = async (_url, init) => {
    for (const [key, value] of Object.entries(init.headers ?? {})) {
      if (key.toLowerCase() === 'authorization') capturedAuth = value
    }
    return okResponse(textStream())
  }
  const client = new ZcodePlanClient({
    pool,
    minter: { async mint() { return { param: 'p', interactive: false } }, async fetchConfig() { return undefined } },
    fetchImpl,
  })
  const adapter = new NativeZcodeStartPlanAdapter({ client, models: baseModels, provider: 'zcode-start-plan', pool })

  const ids = pool.list().map((entry) => entry.id)
  pool.reorder([ids[1], ids[0]])

  const chunks = []
  for await (const chunk of adapter.stream({
    provider: 'zcode-start-plan',
    model: makePinnedModelId('GLM-5.3-Flash', first.entry.id),
    maxTokens: 64,
    messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
  })) {
    chunks.push(chunk)
  }
  assert.equal(chunks[chunks.length - 1].reason.kind, 'stop')
  assert.equal(capturedAuth, 'Bearer jwt-a')
})

test('plan-client：钉定账号额度耗尽 → 报 QUOTA 不换号，且标记限流', async (t) => {
  const pool = await makePool(t, 'quota')
  const first = pool.add(cred('a'), '主号')
  pool.add(cred('b'), '国际号')

  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"code":1005,"msg":"exceed quota limit"}'))
          controller.close()
        },
      }),
    }
  }
  const client = new ZcodePlanClient({
    pool,
    minter: { async mint() { return { param: 'p', interactive: false } }, async fetchConfig() { return undefined } },
    fetchImpl,
  })
  const adapter = new NativeZcodeStartPlanAdapter({ client, models: baseModels, provider: 'zcode-start-plan', pool })

  const route = NativeZcodeStartPlanAdapter.accountRoute('zcode-start-plan', first.entry.id)
  const chunks = []
  for await (const chunk of adapter.stream({
    provider: route,
    model: 'GLM-5.3-Flash',
    maxTokens: 64,
    messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
  })) {
    chunks.push(chunk)
  }
  const finish = chunks[chunks.length - 1]
  assert.equal(finish.type, 'finish')
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'QUOTA', '钉定账号额度尽 = 明确报错，不静默换号')
  assert.match(finish.reason.failure.message, /主号/)
  assert.equal(calls, 1, '只打这一发：换号会吃「国际号」的额度')
  const entry = pool.get(first.entry.id)
  assert.ok(entry.model_rate_limits['GLM-5.3-Flash'] > 0)
})

test('plan-client：钉定账号已删除 → 明确报错不回退', async (t) => {
  const pool = await makePool(t, 'gone')
  const only = pool.add(cred('a'), '主号')
  pool.add(cred('b'), '国际号')

  let calls = 0
  const client = new ZcodePlanClient({
    pool,
    minter: { async mint() { return { param: 'p', interactive: false } }, async fetchConfig() { return undefined } },
    fetchImpl: async () => {
      calls += 1
      return okResponse(textStream())
    },
  })
  const adapter = new NativeZcodeStartPlanAdapter({ client, models: baseModels, provider: 'zcode-start-plan', pool })
  const route = NativeZcodeStartPlanAdapter.accountRoute('zcode-start-plan', only.entry.id)
  pool.remove(only.entry.id)

  const chunks = []
  for await (const chunk of adapter.stream({
    provider: route,
    model: 'GLM-5.3-Flash',
    maxTokens: 64,
    messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
  })) {
    chunks.push(chunk)
  }
  const finish = chunks[chunks.length - 1]
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'QUOTA')
  assert.match(finish.reason.failure.message, /已不存在/)
  assert.equal(calls, 0, '账号不存在时根本不该发请求')
})

test('config：accountProviders 默认开启、pinnedAccounts 旧名映射、非法值被拒', () => {
  const config = resolveConfig(undefined)
  assert.equal(config.accountProviders, true)
  assert.equal(resolveConfig({ pinnedAccounts: false }).accountProviders, false)
  assert.equal(resolveConfig({ pinnedAccounts: false, accountProviders: true }).accountProviders, true)
  assert.throws(() => Config({ accountProviders: 'yes' }), /accountProviders/)
  assert.equal(Config({ accountProviders: false }).accountProviders, false)
})

test('manage-routes：/unified-list 开关回调生效、非法 body 被拒', async (t) => {
  const pool = await makePool(t, 'mgmt')
  const first = pool.add(cred('a'), '主号')
  const { makeManageRoutes } = await import('../lib/manage-routes.js')

  const seen = []
  const seenAccount = []
  const settings = { unifiedModelList: true, hiddenModelLists: [] }
  const routes = makeManageRoutes({
    pool,
    settings,
    onSetUnifiedVisible: (visible) => {
      seen.push(visible)
      settings.unifiedModelList = visible
    },
    onSetAccountVisible: (accountId, visible) => {
      seenAccount.push([accountId, visible])
      const hidden = new Set(settings.hiddenModelLists)
      if (visible === true) hidden.delete(accountId)
      else hidden.add(accountId)
      settings.hiddenModelLists = [...hidden]
    },
  })
  const unified = routes.find((route) => route.path.endsWith('/unified-list'))
  assert.notEqual(unified, undefined)
  const perAccount = routes.find((route) => route.path.endsWith('/model-list-visible'))
  assert.notEqual(perAccount, undefined)

  const makeReqRes = (body) => [
    {
      socket: { remoteAddress: '127.0.0.1' },
      headers: { host: 'localhost' },
      on(event, cb) {
        if (event === 'data') cb(Buffer.from(JSON.stringify(body)))
        if (event === 'end') cb()
      },
    },
    {
      writeHead() {},
      end() {},
      writableEnded: false,
      destroyed: false,
    },
  ]

  /** 合法调用：回调收到 true/false。 */
  let [req, res] = makeReqRes({ visible: false })
  await unified.handler(req, res)
  assert.deepEqual(seen, [false])
  assert.equal(settings.unifiedModelList, false)

  ;[req, res] = makeReqRes({ visible: true })
  await unified.handler(req, res)
  assert.deepEqual(seen, [false, true])

  /** 非法 body（缺 visible）→ 400，回调不触发。 */
  const responses = []
  const badRes = {
    writeHead() {},
    end(text) {
      responses.push(JSON.parse(text))
    },
    writableEnded: false,
    destroyed: false,
  }
  await unified.handler(makeReqRes({})[0], badRes)
  assert.equal(responses[0].ok, false)
  assert.deepEqual(seen, [false, true])

  /** 每账号开关：隐藏 → 回调收到 (id, false)；再显示 → (id, true)。 */
  await perAccount.handler(...makeReqRes({ id: first.entry.id, visible: false }))
  assert.deepEqual(seenAccount, [[first.entry.id, false]])
  assert.deepEqual(settings.hiddenModelLists, [first.entry.id])
  await perAccount.handler(...makeReqRes({ id: first.entry.id, visible: true }))
  assert.deepEqual(seenAccount, [[first.entry.id, false], [first.entry.id, true]])
  assert.deepEqual(settings.hiddenModelLists, [])

  /** 未知账号 / 非法 body 被拒。 */
  await perAccount.handler(makeReqRes({ id: 'nope', visible: false })[0], badRes)
  assert.equal(responses[responses.length - 1].ok, false)
  await perAccount.handler(makeReqRes({ visible: true })[0], badRes)
  assert.equal(responses[responses.length - 1].ok, false)
  assert.deepEqual(seenAccount, [[first.entry.id, false], [first.entry.id, true]])
})
