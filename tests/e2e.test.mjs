/**
 * 端到端冒烟：用 CPU 内的真实组件（账号池 / plan-client / SSE 解码 / 流翻译）跑通
 *
 * ```
 * adapter.stream() → plan-client（选号 / captcha 探测 / 切号）→ 上游 SSE → DSH chunks
 * ```
 *
 * 只把「上游 HTTP」与「captcha 载体」换成假实现；`apply()` 的接线也真跑一遍。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AccountPool, SqliteStore } from '../lib/pool.js'
import { ZcodePlanClient } from '../lib/plan-client.js'
import { NativeZcodeStartPlanAdapter } from '../lib/adapter.js'
import { resolveConfig, Config, apply } from '../index.js'

const CREDENTIAL = { zcode_jwt: 'jwt-1', device_mid: 'dev-1', user_id: 'u-1' }

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
    { type: 'message_start', message: { model: 'GLM-5.3-Flash', usage: { input_tokens: 5 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '## 交付物' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '\n好的' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ])

const okResponse = (body) => ({
  ok: true,
  status: 200,
  headers: new Headers({ 'content-type': 'text/event-stream' }),
  body,
})

async function makeAdapter(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'zsp-e2e-'))
  const store = await new SqliteStore(join(dir, 'accounts.db'))
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const pool = new AccountPool({ store })
  pool.add(CREDENTIAL, '测试账号')

  const minter = {
    async mint() {
      return { param: 'p-1', interactive: false }
    },
    async fetchConfig() {
      return undefined
    },
  }
  const client = new ZcodePlanClient({ pool, minter, fetchImpl: options.fetchImpl })
  const adapter = new NativeZcodeStartPlanAdapter({
    client,
    models: async () => [
      { id: 'GLM-5.3-Flash', name: 'GLM-5.3-Flash', contextWindow: 1_000_000, maxTokens: 65_536, supportsImage: true },
    ],
  })
  return { adapter, pool, store, client }
}

const streamOptions = {
  provider: 'zcode-start-plan',
  model: 'GLM-5.3-Flash',
  maxTokens: 512,
  messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
}

test('adapter.stream：产出合法的 DSH chunk 序列（以 usage + finish 收尾）', async (t) => {
  const { adapter } = await makeAdapter(t, { fetchImpl: async () => okResponse(textStream()) })

  const chunks = []
  for await (const chunk of adapter.stream(streamOptions)) chunks.push(chunk)

  const nonDelta = chunks.map((chunk) => chunk.type).filter((type) => type !== 'text-delta')
  assert.deepEqual(nonDelta, ['block-start', 'block-end', 'usage', 'finish'])
  assert.equal(
    chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join(''),
    '## 交付物\n好的',
  )
  /** finish.reason 是对象（FinishReasonMap），宿主 BlockAssembler 读 chunk.reason。 */
  assert.deepEqual(chunks[chunks.length - 1].reason, { kind: 'stop' })
  assert.equal(chunks[chunks.length - 2].usage.outputTokens, 2)
})

test('adapter.stream：上游失败时以 terminal finish 错误 chunk 收尾（不抛异常）', async (t) => {
  const { adapter } = await makeAdapter(t, {
    fetchImpl: async () => ({
      ok: false,
      status: 403,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => '{"code":3012,"msg":"request has been blocked due to unusual activity."}',
    }),
  })

  const chunks = []
  for await (const chunk of adapter.stream(streamOptions)) chunks.push(chunk)
  const finish = chunks[chunks.length - 1]
  assert.equal(finish.type, 'finish')
  /** 宿主读 chunk.reason（BlockAssembler）；kind 在顶层会被吞成正常结束。 */
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'RATE_LIMIT')
  assert.match(finish.reason.failure.message, /3012/)
})

test('adapter.listModels / resolveModel：模型元数据带上下文窗口与输入模态', async (t) => {
  const { adapter } = await makeAdapter(t)
  const models = await adapter.listModels('zcode-start-plan')
  assert.equal(models.length, 1)
  assert.equal(models[0].context.contextWindow, 1_000_000)
  assert.deepEqual(models[0].inputModalities, ['text', 'image'])

  const resolved = await adapter.resolveModel('zcode-start-plan', 'GLM-5.3-Flash')
  assert.equal(resolved.id, 'GLM-5.3-Flash')
  assert.equal(resolved.provider, 'zcode-start-plan')
})

test('adapter 契约：providerRetryPolicy 必须可实现（宿主直接调用它）', async (t) => {
  /**
   * `ctx.llm.registerAdapter()` 的 `prepareRoutes` 会**不带可选调用保护**地执行
   * `adapter.providerRetryPolicy(provider)`；漏掉它在宿主里抛
   * `adapter.providerRetryPolicy is not a function`，整条路由注册失败。
   * 这条断言把该契约钉住。
   */
  const { adapter } = await makeAdapter(t)
  assert.equal(typeof adapter.providerRetryPolicy, 'function')
  assert.equal(adapter.providerRetryPolicy('zcode-start-plan'), undefined)
  assert.equal(typeof adapter.providerInfo, 'function')
  const info = adapter.providerInfo('zcode-start-plan')
  assert.equal(info.id, 'zcode-start-plan')
  assert.ok(info.name.length > 0)
})

test('adapter 契约：prepareCall 必须可实现（宿主选模型后直接调用它）', async (t) => {
  /**
   * 宿主在真正发起请求前调用 `adapter.prepareCall(provider, model, signal)`。
   * 基类 `LlmAdapter` 有默认实现，但本适配器没有 extends 基类（避免与宿主版本耦合），
   * 必须自己补 —— 漏掉它表现为
   * `registration.adapter.prepareCall is not a function`：**选模型即报错**。
   */
  const { adapter } = await makeAdapter(t)
  assert.equal(typeof adapter.prepareCall, 'function')

  const prepared = await adapter.prepareCall('zcode-start-plan', 'GLM-5.3-Flash')
  assert.equal(prepared.model.provider, 'zcode-start-plan')
  assert.equal(prepared.model.id, 'GLM-5.3-Flash')
  assert.equal(typeof prepared.stream, 'function', 'stream 必须是同一次准备代际的入口')

  /** 流入口要真的能产出 chunk（宿主随后会消费它）。 */
  const chunks = []
  for await (const chunk of prepared.stream({
    provider: 'zcode-start-plan',
    model: 'GLM-5.3-Flash',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
  })) {
    chunks.push(chunk)
  }
  assert.ok(chunks.length > 0, 'stream 应产出至少一个 chunk')
  assert.equal(chunks[chunks.length - 1].type, 'finish')
})

test('reasoning efforts：每个 effort 必须有非空 id 与 name，且 id 不重复', async (t) => {
  /**
   * `dsh-llm` 的 `normalizeModelInfo` 逐项校验：
   *   typeof effort.id === 'string' && effort.id.length > 0
   *   typeof effort.name === 'string' && effort.name.length > 0
   *   !seen.has(effort.id)
   * 任一条不中即抛 `INVALID_MODEL_REASONING`
   * （"invalid or duplicate reasoning effort metadata"），模型在宿主里不可用。
   */
  const { toModelInfo } = await import('../lib/adapter.js')

  const info = toModelInfo('zcode-start-plan', {
    id: 'GLM-5.3',
    name: 'GLM-5.3',
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    supportsImage: false,
    reasoningLevels: ['low', 'high', 'max'],
    defaultReasoningLevel: 'max',
  })

  assert.equal(info.reasoning.efforts.length, 3)
  for (const effort of info.reasoning.efforts) {
    assert.equal(typeof effort.id, 'string')
    assert.ok(effort.id.length > 0, 'effort.id 不能为空')
    assert.equal(typeof effort.name, 'string')
    assert.ok(effort.name.length > 0, 'effort.name 不能为空')
  }
  assert.deepEqual(info.reasoning.efforts.map((e) => e.id), ['low', 'high', 'max'])
  assert.equal(info.reasoning.defaultEffort, 'max')

  /** 重复 / 空值档位被过滤，不会让整个模型失效。 */
  const dirty = toModelInfo('p', { id: 'm', reasoningLevels: ['low', 'low', '', 'high'] })
  assert.deepEqual(dirty.reasoning.efforts.map((e) => e.id), ['low', 'high'])

  /** 没有档位信息时完全不带 reasoning 字段。 */
  const plain = toModelInfo('p', { id: 'm' })
  assert.equal(plain.reasoning, undefined)
})

test('Config 校验：非法 captcha.mode / debugPort 被拒，合法值补齐默认', () => {
  assert.throws(() => Config({ captcha: { mode: 'browser' } }))
  assert.throws(() => Config({ captcha: { debugPort: 0 } }))
  assert.throws(() => Config({ models: 'GLM' }))

  const good = Config({ captcha: { debugPort: 9333 } })
  assert.deepEqual(good.captcha, { mode: 'cdp', debugPort: 9333, origin: 'https://zcode.z.ai/' })
  assert.deepEqual(good.models, ['GLM-5.3-Flash', 'GLM-5.3'])
  assert.equal(resolveConfig(undefined).provider, 'zcode-start-plan')
})

test('apply：等 llm 出现后注册 adapter + 状态工具，dispose 时收尾', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'zsp-apply-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const registered = []
  const tools = []
  const disposers = []
  const intervals = []
  const routes = []
  /**
   * 宿主的 `ctx` 是**沙箱 facade**：只暴露 `inject` 声明过的服务。
   * 实测（一次性诊断插件）：`Object.keys(ctx)` 仅 `['fiber']`；
   * 碰未声明的服务直接抛 `cannot get property "tools" without inject`。
   * 因此这里按插件的 `inject` 列表（llm/tools/timer）提供服务，
   * 并**不提供** `emit` / `on` / `setInterval`。
   *
   * ⚠ `webServer` **不在 facade 上**（它走可选注入 `ctx.inject(['webServer'], …)`）：
   * 这里提供 `inject` 实现来模拟宿主：服务已就绪则立即回调，并把 webServer
   * 交进去。0.4.4 的「面板永远 404」正是因为从 facade 上探测 `ctx.webServer`
   * —— 永远拿不到 —— 而静默跳过注册。
   */
  const ctx = {
    logger: { info() {}, warn() {} },
    llm: {
      registerAdapter: (providers, adapter) => {
        registered.push({ providers, adapter })
        return () => {}
      },
      /** 沙箱里没有 ctx.emit，改用 llm 自己的发布入口。 */
      emitAdaptersUpdated() {},
    },
    tools: { register: (tool) => { tools.push(tool); return () => {} } },
    timer: {
      interval: (callback, delay) => {
        intervals.push(delay)
        return () => {}
      },
    },
    /**
     * 可选注入：宿主只把 `{ webServer }` 这一小份 service 交给回调。
     * 回调里用的 `webCtx.effect` 由宿主托管，这里同样交给 disposers 收集。
     */
    inject(services, callback) {
      assert.deepEqual(services, ['webServer'])
      callback({
        webServer: {
          register: (route) => {
            routes.push(route)
            return () => {}
          },
        },
        effect(fn) {
          const disposer = fn()
          if (typeof disposer === 'function') disposers.push(disposer)
          return disposer
        },
      })
      return () => {}
    },
    effect(fn) {
      /**
       * 宿主语义：`fn` 同步执行，**返回的 disposer 由 effect 持有**；
       * 测试里收集它，模拟 fiber 释放。
       */
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
      return disposer
    },
  }

  const pluginCleanup = apply(ctx, { dataDir: dir })

  for (let i = 0; i < 200 && registered.length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }

  assert.equal(registered.length, 1)
  assert.deepEqual(registered[0].providers, ['zcode-start-plan'])
  assert.equal(typeof registered[0].adapter.stream, 'function')
  assert.equal(tools.length, 1)
  assert.equal(tools[0].name, 'zcode_start_plan_status')
  /**
   * 两条定时器：①每小时清过期限流标记；②自动领取轮询（常驻挂着，开关在 tick 内判断）。
   * ⚠ 自动领取**必须常驻**只注册一次 —— 拨盘切换不能重启宿主才能生效，
   * 所以不能把它做成「开启时才注册」。
   */
  assert.deepEqual(
    [...intervals].sort((a, b) => a - b),
    [30 * 60_000, 60 * 60_000],
    '应注册每小时清理 + 自动领取轮询（默认 30 分钟）',
  )

  /**
   * ⚠ 面板 404 的回归闸：管理路由必须经**可选注入**挂到 `webServer` 上。
   * 0.4.4 从 facade 探测 `ctx.webServer` → 拿不到 → 静默跳过 → 面板永远 404。
   * 这里断言 17 条 `/api/zcode-start-plan/*` 路由真的注册进了路由表。
   * （0.9.3 加了 /openai-gateway：状态 + 开关；0.9.7 删了无调用方的 /use。）
   */
  assert.equal(routes.length, 17, `应注册 17 条账号面板路由，实际 ${routes.length}`)
  const paths = routes.map((route) => route.path).sort()
  assert.ok(!paths.includes('/api/zcode-start-plan/use'), '/use 已移除（0.7.0 起 expiry 选号，置顶不再决定取号）')
  assert.ok(paths.includes('/api/zcode-start-plan/summary'), '缺少 /summary（面板首次加载就靠它）')
  assert.ok(paths.includes('/api/zcode-start-plan/auto-claim'), '缺少 /auto-claim（自动领取开关）')
  assert.ok(paths.includes('/api/zcode-start-plan/login/start'), '缺少 /login/start')
  assert.ok(paths.includes('/api/zcode-start-plan/login/poll'), '缺少 /login/poll')
  assert.ok(paths.includes('/api/zcode-start-plan/claimable'), '缺少 /claimable（赠送额度查询）')
  assert.ok(paths.includes('/api/zcode-start-plan/claim'), '缺少 /claim（赠送额度领取）')
  assert.ok(paths.includes('/api/zcode-start-plan/restart-cdp'), '缺少 /restart-cdp（以调试端口重启）')
  assert.ok(routes.every((route) => route.kind === 'exact'), '路由必须都是 exact kind')

  const status = await tools[0].execute()
  assert.equal(status.provider, 'zcode-start-plan')
  assert.equal(status.accountCount, 0)
  assert.equal(typeof status.captcha.reachable, 'boolean')
  /** 官方标准要求 apply 交出 cleanup，且状态工具能报告适配器是否真的注册上。 */
  assert.equal(status.adapterRegistered, true, '状态工具应报告适配器已注册')

  /**
   * ⚠ 输出必须**无损 JSON**：宿主把 `JSON.parse(text)` 与原值深比较，
   * 带缩进的序列化、以及含 `undefined` 的对象都会被判 `value is not lossless JSON`，
   * 整个工具结果被拒。
   */
  const rendered = tools[0].output.render({}, status)
  assert.equal(rendered[0].type, 'text')
  const parsed = JSON.parse(rendered[0].text)
  assert.deepEqual(parsed, JSON.parse(JSON.stringify(status)))
  /** 结果里不得有 undefined 值（会被 stringify 静默丢弃）。 */
  assert.equal(JSON.stringify(parsed), JSON.stringify(status))
  /** 缺省值一律 null（不是 undefined）—— 否则 round-trip 后键会消失。 */
  assert.equal(status.error, null)
  assert.equal(status.captcha.reason === null || typeof status.captcha.reason === 'string', true)
  assert.equal(typeof pluginCleanup, 'function', 'apply 必须返回 cleanup')

  /** 收尾只走 apply 的返回值（它内部会释放 SQLite / 端点 / captcha）。 */
  await pluginCleanup()
})
