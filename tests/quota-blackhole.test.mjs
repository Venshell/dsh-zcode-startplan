/**
 * issue #4：**额度用尽（1005）之后的上游黑洞**必须秒级 / 分秒级失败，且错误码保真。
 *
 * 真实事故形态（2026-11-08，单账号池，GLM-5.3-Flash 免费额度跑尽）：
 *
 * ```
 * 23:38:51  请求发出
 * 23:43:53  attempt 1 失败：PROVIDER_ERROR「模型通道超时或不可用」（挂了 302s）
 * 23:48:56  attempt 2（宿主 llm-retry）同样失败                  （又挂 303s）
 * 23:48:56  turn 以 error 结束
 * ```
 *
 * 而同一时刻 `last_error` 里早就写着 `额度用尽（1005 exceed quota limit）`。
 * 三条修复各自对应一组用例：
 *
 * 1. **选号前置**：`last_error` 已是 1005/1113 → 根本不发请求，立刻 QUOTA；
 * 2. **首内容超时**：上游 200 却永不出流 → 首内容超时（远小于宿主 ~300s）中止；
 * 3. **错误码保真**：黑洞落 `TIMEOUT`（在回退名单里），不落 `PROVIDER_ERROR`。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { ZcodePlanClient } from '../lib/plan-client.js'
import { makeSseDecoder, readContentHead, HEAD_TIMEOUT_CODE, isHeadTimeoutError } from '../lib/sse.js'
import { isFallbackWorthyCode } from '../lib/errors.js'
import { HangingStream } from './support/hanging-stream.mjs'

const CREDENTIAL = { zcode_jwt: 'jwt-1', device_mid: 'dev-1', user_id: 'u-1' }

/** 内存版账号池（含 issue #4 用到的 `hasQuotaError` / 失败原因记录）。 */
function fakePool(entries = [{ id: 'acct-a' }]) {
  const state = entries.map((entry) => ({
    nickname: entry.id,
    enabled: true,
    model_rate_limits: {},
    ...entry,
    /** 每个账号一份独立凭据（缺省共用同一份也没问题，这里给 user_id 换一个）。 */
    credential: entry.credential ?? { ...CREDENTIAL, user_id: `u-${entry.id}` },
  }))
  return {
    list: () => state,
    get: (id) => state.find((entry) => entry.id === id),
    hasQuotaError(accountId) {
      const message = state.find((entry) => entry.id === accountId)?.last_error
      return typeof message === 'string' && /1005|1113|exceed quota limit|余额不足/.test(message)
    },
    pick(model, exclude, sink) {
      const excluded = exclude ?? new Set()
      const now = Date.now()
      let hit = null
      for (const entry of state) {
        if (!entry.enabled || excluded.has(entry.id)) continue
        if ((entry.model_rate_limits[model] ?? 0) > now) continue
        /**
         * 与真池同语义（issue #4）：`last_error` 已是额度用尽 → 不进候选，
         * 并让调用方知道「是被额度挡掉的」（`sink.exhausted`），
         * 这样「为什么一个候选都没有」能说清真因。
         */
        if (/1005|1113|exceed quota limit|余额不足/.test(entry.last_error ?? '')) {
          sink?.exhausted.add(entry.id)
          continue
        }
        hit = entry
        break
      }
      /** 与真池一致：返回 `{ entry, credential }`，不是账号条目本身。 */
      return hit === null ? null : { entry: hit, credential: hit.credential }
    },
    /** 真池的候选视图：供 plan-client 报「都被额度挡掉了」用。 */
    candidates(model, exclude, sink) {
      const picked = this.pick(model, exclude, sink)
      return picked === null ? [] : [picked.entry]
    },
    markModelRateLimited(accountId, modelId, resetAt) {
      const hit = state.find((entry) => entry.id === accountId)
      if (hit !== undefined) hit.model_rate_limits[modelId] = resetAt
    },
    noteError(accountId, message) {
      const hit = state.find((entry) => entry.id === accountId)
      if (hit !== undefined) hit.last_error = message
    },
    isEmptyContentWatched: () => false,
  }
}

const minter = {
  async mint() {
    return { param: 'p', interactive: false }
  },
  async fetchConfig() {
    return undefined
  },
}

const baseOptions = { model: 'GLM-5.3-Flash', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }

const okResponse = (body) => ({
  ok: true,
  status: 200,
  headers: new Headers({ 'content-type': 'text/event-stream' }),
  body,
})

// ─────────────────────────── 1. 选号前置（秒级） ───────────────────────────

test('#4 选号前置：last_error 已是 1005 → 一条请求都不发，立刻 QUOTA', async () => {
  const pool = fakePool([
    // 硬标记表里**没有**这个模型的记录 —— 正是「漏过滤」才会发出去的那条路。
    { id: 'acct-a', last_error: '额度用尽（1005 exceed quota limit）——该账号在这个模型上的免费额度已用完，请等待额度重置或更换账号。' },
  ])
  let calls = 0
  const client = new ZcodePlanClient({
    pool,
    minter,
    fetchImpl: async () => {
      calls += 1
      return okResponse(new HangingStream().stream)
    },
  })

  const startedAt = Date.now()
  /**
   * ⚠ 断言跑在 **plugin 层**（`client.call` 的 code/message），不是终止块：
   * 终止块会经 `adapter` 的脱敏闸换成中性文案（issue #2），细节只进日志。
   */
  const failure = await client.call({ options: baseOptions }).then(
    () => assert.fail('已判额度用尽时必须失败，而不是发出请求'),
    (error) => error,
  )
  assert.equal(failure.code, 'QUOTA', '额度用尽必须是 QUOTA，不能落成 PROVIDER_ERROR')
  assert.match(failure.message, /额度用尽/)
  assert.match(failure.message, /1005/, '文案要带上真因，别只给「超时或不可用」')
  assert.equal(calls, 0, '已判额度用尽的账号绝不能再发请求（那正是黑洞的来源）')
  assert.ok(Date.now() - startedAt < 1000, '快速失败路径必须秒级返回')
})

test('#4 选号前置：1113（余额不足）同样快速失败', async () => {
  const pool = fakePool([{ id: 'acct-a', last_error: '余额不足或无可用资源包（1113）' }])
  let calls = 0
  const client = new ZcodePlanClient({
    pool,
    minter,
    fetchImpl: async () => {
      calls += 1
      return okResponse(new HangingStream().stream)
    },
  })
  await assert.rejects(() => client.call({ options: baseOptions }), { code: 'QUOTA' })
  assert.equal(calls, 0)
})

test('#4 选号前置：last_error 只是并发限流（3009）/网络抖动 → 照常发请求', async () => {
  /** 3009 是瞬态，把它当额度用尽会把用户钉死在「等次日重置」上。 */
  const pool = fakePool([{ id: 'acct-a', last_error: '上游并发限流（3009 model concurrency limit exceeded）' }])
  let calls = 0
  const client = new ZcodePlanClient({
    pool,
    minter,
    concurrencyRetryBaseMs: 1,
    fetchImpl: async () => {
      calls += 1
      return okResponse(
        new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder()
            controller.enqueue(encoder.encode('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n'))
            controller.close()
          },
        }),
      )
    },
  })
  const result = await client.call({ options: baseOptions })
  assert.equal(result.accountId, 'acct-a')
  assert.equal(calls, 1)
})

test('#4 钉定账号：last_error 已是 1005 → 明确报错，且一条请求都不发', async () => {
  const pool = fakePool([{ id: 'acct-a', last_error: '额度用尽（1005 exceed quota limit）' }])
  let calls = 0
  const client = new ZcodePlanClient({
    pool,
    minter,
    fetchImpl: async () => {
      calls += 1
      return okResponse(new HangingStream().stream)
    },
  })
  await assert.rejects(
    () => client.call({ options: baseOptions, pinnedAccountId: 'acct-a' }),
    (error) => {
      assert.equal(error.code, 'QUOTA')
      assert.match(error.message, /未发出/, '文案要说明「本次请求未发出」')
      return true
    },
  )
  assert.equal(calls, 0)
})

// ─────────────────────────── 2. 首内容超时 ───────────────────────────

test('#4 首内容超时：上游 200 却永不出流 → head 返回 timeoutError（不是零内容）', async () => {
  const head = await readContentHead(new HangingStream().stream, {
    contentType: 'text/event-stream',
    headTimeoutMs: 30,
  })
  assert.equal(head.hasContent, false)
  assert.notEqual(head.timeoutError, undefined, '必须暴露 timeoutError，调用方才能按 TIMEOUT 处置')
  assert.equal(isHeadTimeoutError(head.timeoutError), true)
  assert.equal(head.timeoutError.code, HEAD_TIMEOUT_CODE)
  assert.equal(head.elapsedMs >= 25, true)
})

test('#4 首内容超时：引擎的预算必须显著小于宿主 ~300s（默认 90s / 180s）', async () => {
  const { DEFAULT_HEAD_TIMEOUT_MS, DEFAULT_READ_TIMEOUT_MS } = await import('../lib/errors.js')
  const { resolveConfig } = await import('../index.js')
  assert.ok(DEFAULT_HEAD_TIMEOUT_MS < 300_000, '首内容超时必须早于宿主超时触发')
  assert.ok(DEFAULT_HEAD_TIMEOUT_MS <= 120_000, '否则用户的等待体验与「黑洞」无异')
  assert.ok(DEFAULT_READ_TIMEOUT_MS >= DEFAULT_HEAD_TIMEOUT_MS, '流内静默不该比首内容更严')
  /** config 必须真的能把这两个值透传下去（否则用户无从调整）。 */
  assert.equal(resolveConfig(undefined).headTimeoutMs, DEFAULT_HEAD_TIMEOUT_MS, 'schema 默认与运行时默认同一份')
  assert.equal(resolveConfig({ headTimeoutMs: 5_000 }).headTimeoutMs, 5_000)
  assert.equal(resolveConfig(undefined).readTimeoutMs, DEFAULT_READ_TIMEOUT_MS)
})

test('#4 首内容超时：见到首内容后预算切到流内静默（长思考不被误杀）', async () => {
  /** 首事件在 headTimeoutMs 内到达；此后静默超过 headTimeoutMs、但小于 readTimeoutMs。 */
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"a"}}\n\n'),
      )
      setTimeout(() => {
        controller.enqueue(
          encoder.encode('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"b"}}\n\n'),
        )
        controller.close()
      }, 120)
    },
  })
  const decoder = makeSseDecoder(stream, { headTimeoutMs: 40, timeoutMs: 2_000 })
  const first = await decoder.read()
  assert.equal(first.done, false)
  decoder.markContent()
  const second = await decoder.read()
  assert.equal(second.done, false, '流内静默 120ms 不该被 40ms 的首内容预算误杀')
  await decoder.cancel()
})

// ─────────────────────────── 3. 错误码保真 ───────────────────────────

test('#4 错误码保真：黑洞落 TIMEOUT（可回退），不落 PROVIDER_ERROR', async () => {
  const pool = fakePool([{ id: 'acct-a' }])
  const client = new ZcodePlanClient({
    pool,
    minter,
    headTimeoutMs: 30,
    readTimeoutMs: 30,
    fetchImpl: async () => okResponse(new HangingStream().stream),
  })
  await assert.rejects(
    () => client.call({ options: baseOptions }),
    (error) => {
      assert.equal(error.code, 'TIMEOUT', `黑洞=没拿到内容，不是笼统的 PROVIDER_ERROR（实际：${error.message.slice(0, 160)}）`)
      assert.equal(isFallbackWorthyCode(error.code), true, 'TIMEOUT 在回退名单里，宿主才有机会改道')
      assert.match(error.message, /没有产出任何内容/)
      return true
    },
  )
  assert.equal(
    pool.list()[0].model_rate_limits['GLM-5.3-Flash'] ?? 0,
    0,
    '黑洞不写当日硬标记：没有 1005 证据就不该锁一整天（抖动一次 = 白等一天）',
  )
})

test('#4 钉定账号黑洞：如实报 TIMEOUT，不换号', async () => {
  const pool = fakePool([{ id: 'acct-a' }, { id: 'acct-b' }])
  let calls = 0
  const client = new ZcodePlanClient({
    pool,
    minter,
    headTimeoutMs: 30,
    readTimeoutMs: 30,
    fetchImpl: async () => {
      calls += 1
      return okResponse(new HangingStream().stream)
    },
  })
  await assert.rejects(() => client.call({ options: baseOptions, pinnedAccountId: 'acct-a' }), { code: 'TIMEOUT' })
  assert.equal(calls, 1, '钉定模式绝不换号（换号会让「钉定」名存实亡）')
})

test('#4 统一选号黑洞：同账号撞满上限后换号，两个号都黑洞才报 TIMEOUT', async () => {
  const pool = fakePool([{ id: 'acct-a' }, { id: 'acct-b' }])
  const hits = []
  const client = new ZcodePlanClient({
    pool,
    minter,
    headTimeoutMs: 20,
    readTimeoutMs: 20,
    fetchImpl: async (_url, init) => {
      hits.push(init.headers['authorization'])
      return okResponse(new HangingStream().stream)
    },
  })
  await assert.rejects(() => client.call({ options: baseOptions }), { code: 'TIMEOUT' })
  assert.equal(hits.length, 4, '两个账号各撞 2 次（PER_ACCOUNT_FAIL_MAX），每次都远小于宿主超时')
  assert.ok(
    pool.list().every((entry) => (entry.model_rate_limits['GLM-5.3-Flash'] ?? 0) === 0),
    '黑洞不证明额度用尽：只记失败原因，不写当日硬标记（避免抖动一次锁一整天）',
  )
})

test('#4 网络层 AbortError（fetch 自身超时）同样落 TIMEOUT', async () => {
  const pool = fakePool([{ id: 'acct-a' }])
  const client = new ZcodePlanClient({
    pool,
    minter,
    readTimeoutMs: 4_000,
    fetchImpl: async () => {
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
    },
  })
  await assert.rejects(
    () => client.call({ options: baseOptions, pinnedAccountId: 'acct-a' }),
    (error) => {
      assert.equal(error.code, 'TIMEOUT')
      assert.match(error.message, /4s/)
      return true
    },
  )
})
