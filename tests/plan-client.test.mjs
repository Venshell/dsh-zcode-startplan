import test from 'node:test'
import assert from 'node:assert/strict'

import { ZcodePlanClient } from '../lib/plan-client.js'
import { nextUtc8DayStartMs } from '../lib/upstream.js'

const CREDENTIAL = { zcode_jwt: 'jwt-1', device_mid: 'dev-1', user_id: 'u-1' }

/** 内存版账号池（只实现 plan-client 用到的方法）。 */
function fakePool(credentials = [{ id: 'acct-a', credential: CREDENTIAL }]) {
  const state = credentials.map((entry) => ({ nickname: entry.id, enabled: true, model_rate_limits: {}, ...entry }))
  /** 进程内零内容观察窗（与真池同语义：软优先，不进 model_rate_limits）。 */
  const watch = new Map()
  return {
    list: () => state,
    get(id) {
      return state.find((entry) => entry.id === id)
    },
    /** 与真池一致：限流中的账号×模型被硬过滤（当日级）；观察窗只是软优先不在这判。 */
    pick(model, exclude) {
      const excluded = exclude ?? new Set()
      const now = Date.now()
      const hit = state.find(
        (entry) =>
          entry.enabled &&
          !excluded.has(entry.id) &&
          !((entry.model_rate_limits[model] ?? 0) > now),
      )
      return hit === undefined ? null : { entry: hit, credential: hit.credential }
    },
    markModelRateLimited(accountId, modelId, resetAt) {
      const hit = state.find((entry) => entry.id === accountId)
      if (hit !== undefined) hit.model_rate_limits[modelId] = resetAt
    },
    /**
     * 面板「清除限流」的**同一个入口**（3012 风控后 plan-client 会自动调它）。
     * 与真池（`AccountPool.clearModelRateLimits`）同语义：只清选中项，返回清掉几项。
     */
    clearModelRateLimits(accountId, modelIds) {
      const hit = state.find((entry) => entry.id === accountId)
      if (hit === undefined) return 0
      let removed = 0
      for (const modelId of modelIds ?? Object.keys(hit.model_rate_limits)) {
        if (Object.prototype.hasOwnProperty.call(hit.model_rate_limits, modelId)) {
          delete hit.model_rate_limits[modelId]
          removed += 1
        }
      }
      return removed
    },
    noteEmptyContentWatch(accountId, modelId, until) {
      watch.set(`${accountId}|${modelId}`, until)
    },
    isEmptyContentWatched(accountId, modelId) {
      return (watch.get(`${accountId}|${modelId}`) ?? 0) > Date.now()
    },
    clearEmptyContentWatch(accountId, modelId) {
      watch.delete(`${accountId}|${modelId}`)
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
  /**
   * 1.0.1 两级证据：**首次**零内容只打观察窗（pool 软优先，10 分钟自动过期），
   * 绝不写进 model_rate_limits（那是当日硬过滤表）—— 模型实际可用时一次
   * 上游抖动不该判死刑。
   */
  assert.equal(
    pool.list()[0].model_rate_limits['GLM-5.3-Flash'] === undefined,
    true,
    '首次零内容不落当日硬标记',
  )
  assert.equal(pool.isEmptyContentWatched('acct-a', 'GLM-5.3-Flash'), true, '但进观察窗（软优先）')
})

test('零内容两级证据：观察窗内第二次（跨请求）才升级为当日标记', async () => {
  const pool = fakePool([{ id: 'acct-a', credential: CREDENTIAL }])
  const fetchImpl = async () => response(200, emptyStream())
  const client = new ZcodePlanClient({ pool, minter: fakeMinter(), fetchImpl })
  /**
   * 唯一账号场景（最坏情况）：请求 1 零内容（首次）→ 观察窗 + 换号；
   * 观察窗是软优先，pick 第二档仍会选回 A —— 第二次零内容升级当日。
   */
  await assert.rejects(() => client.call({ options: baseOptions }), (error) => error.code === 'QUOTA')
  assert.equal(
    pool.list()[0].model_rate_limits['GLM-5.3-Flash'] === undefined,
    true,
    '首次零内容不落当日硬标记',
  )
  await assert.rejects(() => client.call({ options: baseOptions }), (error) => error.code === 'QUOTA')
  const mark = pool.list()[0].model_rate_limits['GLM-5.3-Flash']
  assert.equal(mark, nextUtc8DayStartMs(new Date()), '观察窗内第二次零内容 → 升级为当日标记（= 下一个 UTC+8 零点）')
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

test('风控 3012 不重试、不换号，直接失败（独立码 RISK_BLOCKED）', async () => {
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
      /**
       * ⚠ 必须是 **RISK_BLOCKED**，不是 RATE_LIMIT（3012 的语义收窄后的契约）：
       * - RATE_LIMIT 只表示 3009 并发限流（秒级瞬态，可重试可回退）；
       * - 3012 是账号级风控，重试有累积惩罚（30 分钟 → 24 小时 → 停用），
       *   宿主要能按码分流出「不许自动重试」。
       */
      assert.equal(error.code, 'RISK_BLOCKED')
      assert.match(error.message, /3012/)
      assert.match(error.message, /风控/, '文案要说清这是风控，不是额度问题')
      return true
    },
  )
  assert.equal(calls, 1, '3012 有冷却惩罚：绝不能连续重试')
})

test('风控 3012 后**自动清除**该账号×模型的限流标记（不必等用户点面板按钮）', async () => {
  /**
   * 3012 常常是一次误判：该账号×模型未必真的耗尽额度，但此前可能已被打过
   * `model_rate_limits` 硬标记（零内容升级 / 早前的 1005）。若不清掉，用户
   * 「稍后重试」时会在**选号阶段**就被自己的标记挡住 —— 看起来还像额度问题，
   * 而真正的原因是风控。
   */
  const pool = fakePool([
    { id: 'acct-a', credential: CREDENTIAL },
    { id: 'acct-b', credential: { ...CREDENTIAL, user_id: 'u-2' } },
  ])
  const MODEL = 'GLM-5.3-Flash'
  /**
   * 两个「别人的上游依据」标记：**别的账号**、**别的模型**。
   * 3012 只允许清「该账号 × 该模型」，这两条必须原样留着。
   */
  pool.markModelRateLimited('acct-a', 'GLM-5.3', Date.now() + 3_600_000)
  pool.markModelRateLimited('acct-b', 'GLM-4.6', Date.now() + 3_600_000)
  /**
   * 本次要验的核心：该账号 × 该模型**原本带着当日硬标记**（早前的零内容升级 /
   * 1005 留下的），随后这一次请求撞上 3012 —— 标记必须被自动清除。
   *
   * ⚠ 用**自动选号**（不钉定）而不是钉定：钉定会先按限流把账号拒掉，根本发不出请求。
   * 这里让选号第一步就把 acct-a 选出来（acct-b 也带标记 → 一并排除），
   * 于是 3012 分支能走到，清除动作可观测。
   */
  pool.pick = (model, exclude) => {
    const excluded = exclude ?? new Set()
    const hit = pool.list().find((entry) => entry.enabled && !excluded.has(entry.id))
    return hit === undefined ? null : { entry: hit, credential: hit.credential }
  }

  let calls = 0
  const client = new ZcodePlanClient({
    pool,
    minter: fakeMinter(),
    fetchImpl: async () => {
      calls += 1
      return response(403, '{"code":3012,"msg":"unusual activity"}', 'application/json')
    },
  })

  await assert.rejects(
    () => client.call({ options: baseOptions }),
    (error) => {
      assert.equal(error.code, 'RISK_BLOCKED')
      return true
    },
  )
  assert.equal(calls, 1, '清除标记是为了「用户手动重试时不被自己挡住」，不是为了自动再撞一次')
  assert.equal(
    pool.list()[0].model_rate_limits[MODEL],
    undefined,
    '3012 之后该账号该模型的限流标记必须已被自动清除（本轮核心需求）',
  )
  assert.notEqual(
    pool.list()[0].model_rate_limits['GLM-5.3'],
    undefined,
    '只清该模型：同一账号的其它模型标记各有上游依据',
  )
  assert.notEqual(
    pool.list()[1].model_rate_limits['GLM-4.6'],
    undefined,
    '只清该账号：别的账号的标记各有上游依据，绝不能顺手清掉',
  )
})

test('并发限流 3009 退避重试但不换号', async () => {
  let calls = 0
  const client = new ZcodePlanClient({
    pool: fakePool(),
    minter: fakeMinter(),
    concurrencyRetryBaseMs: 1,
    fetchImpl: async () => {
      calls += 1
      return calls === 1 ? response(429, '{"code":3009}', 'application/json') : response(200, textStream())
    },
  })
  const result = await client.call({ options: baseOptions })
  assert.equal(calls, 2)
  assert.equal(result.accountId, 'acct-a')
})

test('3009 打忙标记：并行请求直接路由到空闲账号', async () => {
  const pool = fakePool([
    { id: 'acct-a', credential: CREDENTIAL },
    { id: 'acct-b', credential: { ...CREDENTIAL, user_id: 'u-2' } },
  ])
  /** 固定时钟：忙标记 60s 窗口内第二个请求必须绕开 acct-a。 */
  let now = Date.now()
  const markBusy = []
  let clearBusy = 0
  const realPool = new Map()
  for (const entry of pool.list()) realPool.set(entry.id, entry)
  const busy = new Map()
  pool.markModelBusy = (accountId, modelId) => {
    markBusy.push(`${accountId}|${modelId}`)
    busy.set(`${accountId}|${modelId}`, now + 60_000)
  }
  pool.isModelBusy = (accountId, modelId) => (busy.get(`${accountId}|${modelId}`) ?? 0) > now
  pool.clearModelBusy = (accountId, modelId) => {
    const key = `${accountId}|${modelId}`
    if (busy.has(key)) {
      busy.delete(key)
      clearBusy += 1
    }
  }
  pool.pick = (model, exclude) => {
    const excluded = exclude ?? new Set()
    const byModel = (entry) => entry.enabled && !excluded.has(entry.id)
    let hit = [...realPool.values()].find((entry) => byModel(entry) && !pool.isModelBusy(entry.id, model))
    if (hit === undefined) hit = [...realPool.values()].find((entry) => byModel(entry))
    return hit === undefined ? null : { entry: hit, credential: hit.credential }
  }

  /** 请求 1：acct-a 撞 3009，退避穷尽（上限 2 次）后换到 acct-b 成功。 */
  let calls = 0
  const client = new ZcodePlanClient({
    pool,
    minter: fakeMinter(),
    concurrencyRetryBaseMs: 1,
    now: () => now,
    fetchImpl: async () => {
      calls += 1
      return calls <= 3 ? response(429, '{"code":3009}', 'application/json') : response(200, textStream())
    },
  })
  const first = await client.call({ options: baseOptions })
  assert.equal(first.accountId, 'acct-b', '退避穷尽后换号到 acct-b')
  assert.deepEqual(
    [...new Set(markBusy)],
    ['acct-a|GLM-5.3-Flash'],
    '3009 命中即打忙标记（每次尝试都刷新，key 集合不变）',
  )
  assert.equal(calls, 4)

  /** 请求 2（同一 60s 窗口内）：选号第一档就跳过忙的 acct-a，直接用 acct-b。 */
  let secondCalls = 0
  const client2 = new ZcodePlanClient({
    pool,
    minter: fakeMinter(),
    concurrencyRetryBaseMs: 1,
    now: () => now,
    fetchImpl: async () => {
      secondCalls += 1
      return response(200, textStream())
    },
  })
  const second = await client2.call({ options: baseOptions })
  assert.equal(second.accountId, 'acct-b', '忙标记让并行请求直接路由到空闲账号')
  assert.equal(secondCalls, 1, '不再先撞忙账号')
  assert.equal(clearBusy, 0)
})

test('3009 换号后全部忙尽 → RATE_LIMIT（而非 QUOTA），提示稍后重试', async () => {
  const pool = fakePool([
    { id: 'acct-a', credential: CREDENTIAL },
    { id: 'acct-b', credential: { ...CREDENTIAL, user_id: 'u-2' } },
  ])
  const client = new ZcodePlanClient({
    pool,
    minter: fakeMinter(),
    concurrencyRetryBaseMs: 1,
    fetchImpl: async () => response(429, '{"code":3009,"msg":"model concurrency limit exceeded"}', 'application/json'),
  })
  await assert.rejects(
    () => client.call({ options: baseOptions }),
    (error) => {
      assert.equal(error.code, 'RATE_LIMIT')
      assert.match(error.message, /3009/)
      assert.match(error.message, /稍后重试/)
      return true
    },
  )
  /** 3009 绝不能打成「额度用尽」标记（那会把账号冤枉到当日结束）。 */
  assert.equal(
    pool.list().every((entry) => Object.keys(entry.model_rate_limits).length === 0),
    true,
    '忙账号只打软标记，model_rate_limits 保持干净',
  )
})

test('3009 成功命中后清忙标记，不再绕开该账号', async () => {
  const pool = fakePool([{ id: 'acct-a', credential: CREDENTIAL }])
  let busy = false
  pool.markModelBusy = () => {
    busy = true
  }
  pool.isModelBusy = () => busy
  pool.clearModelBusy = () => {
    busy = false
  }
  let calls = 0
  const client = new ZcodePlanClient({
    pool,
    minter: fakeMinter(),
    concurrencyRetryBaseMs: 1,
    fetchImpl: async () => {
      calls += 1
      return calls === 1 ? response(429, '{"code":3009}', 'application/json') : response(200, textStream())
    },
  })
  const result = await client.call({ options: baseOptions })
  assert.equal(result.accountId, 'acct-a')
  assert.equal(busy, false, '命中成功 = 账号已空闲，忙标记立即清除')
})

test('钉定账号持续 3009 → RATE_LIMIT 报错，绝不换号', async () => {
  let calls = 0
  const client = new ZcodePlanClient({
    pool: fakePool(),
    minter: fakeMinter(),
    concurrencyRetryBaseMs: 1,
    fetchImpl: async () => {
      calls += 1
      return response(429, '{"code":3009}', 'application/json')
    },
  })
  await assert.rejects(
    () => client.call({ options: { ...baseOptions, model: 'GLM-5.3-Flash@acct:acct-a' } }),
    (error) => {
      assert.equal(error.code, 'RATE_LIMIT')
      assert.match(error.message, /钉定的账号/)
      assert.match(error.message, /3009/)
      return true
    },
  )
  /** 1 次请求 = 退避上限 2 次重试 + 1 = 3 发，全打在钉定账号上，无第二发选号。 */
  assert.equal(calls, 3, '钉定模式只打指定账号，绝不换号')
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

test('401 凭据失效 → 同账号撞满 2 次后换号；单账号池 → 终态 AUTH', async () => {
  let calls = 0
  const client = new ZcodePlanClient({
    pool: fakePool(),
    minter: fakeMinter(),
    fetchImpl: async () => {
      calls += 1
      return response(401, '{"code":1002}', 'application/json')
    },
  })
  await assert.rejects(
    () => client.call({ options: baseOptions }),
    (error) => {
      /**
       * 0.9.9 韧性语义：auth 不再当场 throw —— 撞满 2 次换号；单账号池
       * 选不到下一个号，按**真实失败原因**（auth）归 `AUTH` 终态。
       *
       * ⚠ 不再归 QUOTA：凭据失效需要重新登录，等额度重置永远不会解决它；
       * 报成额度问题会把用户带去错误的排查方向（且 AUTH 不在回退名单里）。
       */
      assert.equal(error.code, 'AUTH')
      assert.match(error.message, /凭据失效|1002/)
      return true
    },
  )
  assert.equal(calls, 2, '同账号失败两次（1 < 2 不换，第 2 次触发换号）')
})

test('0.9.9 韧性：统一选号下 any-error 两连败自动换号（压缩调用 + 主请求各撞一次也能活）', async () => {
  const pool = fakePool([
    { id: 'acct-a', credential: CREDENTIAL },
    { id: 'acct-b', credential: { ...CREDENTIAL, user_id: 'u-2' } },
  ])
  /** acct-a 永远 500（other 类）；acct-b 正常 —— 模拟压缩调用 + 主请求
   * 两次都先撞上坏账号的真实形态。 */
  let call = 0
  const client = new ZcodePlanClient({
    pool,
    minter: fakeMinter(),
    fetchImpl: async () => {
      call += 1
      return call <= 2 ? response(500, 'upstream boom', 'text/plain') : response(200, textStream())
    },
  })
  const result = await client.call({ options: baseOptions })
  assert.equal(result.accountId, 'acct-b', '第 3 发落到健康账号')
  assert.equal(call, 3, 'acct-a 恰好两连败后换号')
})

test('0.9.9 韧性：3012 风控仍然绝不重试、绝不换号（冷却惩罚优先于韧性）', async () => {
  let calls = 0
  const pool = fakePool([
    { id: 'acct-a', credential: CREDENTIAL },
    { id: 'acct-b', credential: { ...CREDENTIAL, user_id: 'u-2' } },
  ])
  const client = new ZcodePlanClient({
    pool,
    minter: fakeMinter(),
    fetchImpl: async () => {
      calls += 1
      return response(403, '{"code":3012,"msg":"unusual activity"}', 'application/json')
    },
  })
  await assert.rejects(
    () => client.call({ options: baseOptions }),
    (error) => {
      /** 独立码：风控不是并发限流，宿主要能分流出「不许自动重试」。 */
      assert.equal(error.code, 'RISK_BLOCKED')
      assert.match(error.message, /3012/)
      return true
    },
  )
  assert.equal(calls, 1, '3012 有账号冷却惩罚：一次即停，韧性兜底不覆盖它')
})

test('3012 的 RISK_BLOCKED 刻意**不在**回退名单里（换通道常常还是同一批账号）', async () => {
  const { isFallbackWorthyCode } = await import('../lib/errors.js')
  assert.equal(isFallbackWorthyCode('RISK_BLOCKED'), false, '风控不触发插件回退：冷却惩罚是账号级的')
  /** 语义收窄后的对照：RATE_LIMIT 只表示 3009 并发限流（瞬态，可回退）。 */
  assert.equal(isFallbackWorthyCode('RATE_LIMIT'), true)
  assert.equal(isFallbackWorthyCode('QUOTA'), true)
  assert.equal(isFallbackWorthyCode('TIMEOUT'), true)
  assert.equal(isFallbackWorthyCode('AUTH'), false)
})
