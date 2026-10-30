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

/** fetchBalance 的假 fetch（固定响应）。 */
function fakeFetch(payload, status = 200) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  })
}

test('fetchBalance: balances 汇总剩余/总量（现行行为不变）', async () => {
  const { fetchBalance } = await import('../lib/upstream-api.js')
  const balance = await fetchBalance({ zcode_jwt: 'j', device_mid: 'd' }, fakeFetch({
    code: 0,
    data: {
      server_time: 1_793_021_836,
      plans: [],
      balances: [
        { show_name: 'GLM-5.3', unit_type: 'token', total_units: 8_000_000, used_units: 123_956, remaining_units: 7_876_044, available_units: 7_876_044 },
      ],
    },
  }))
  assert.equal(balance.remaining, 7_876_044)
  assert.equal(balance.total, 8_000_000)
  assert.equal(balance.planName, 'GLM-5.3')
  assert.equal(balance.pending, undefined, '无未生效权益时不下发 pending 键')
})

test('fetchBalance: 未生效的 plan entitlement 进 pending（23 点启用 3 亿包实测形状）', async () => {
  const { fetchBalance } = await import('../lib/upstream-api.js')
  // 2026-10-26 21:37 实测响应：balances 为空，额度在 plans[].entitlements 里，
  // effective_at = 1793026800（23:00:00 +08）晚于 server_time。
  const balance = await fetchBalance({ zcode_jwt: 'j', device_mid: 'd' }, fakeFetch({
    code: 0,
    data: {
      server_time: 1_793_021_836,
      plans: [
        {
          plan_id: 'zcode-v3-start-plan-nt-1026',
          name: 'ZCODE GLOBAL BUILD',
          status: 'active',
          starts_at: 1_793_019_869,
          ends_at: 1_793_062_800,
          entitlements: [
            {
              entitlement_id: 'ent-1',
              show_name: 'GLM-5.3-Flash',
              meter: 'model_usage',
              unit_type: 'token',
              capabilities: ['model:glm-5.3-flash'],
              grant_units: 300_000_000,
              period: 'one_time',
              priority: 101,
              effective_at: 1_793_026_800,
            },
          ],
        },
      ],
      balances: [],
    },
  }))
  assert.equal(balance.remaining, 0)
  assert.equal(balance.total, 0)
  assert.equal(balance.pending?.length, 1)
  assert.equal(balance.pending[0].showName, 'GLM-5.3-Flash')
  assert.equal(balance.pending[0].grantUnits, 300_000_000)
  assert.equal(balance.pending[0].effectiveAt, 1_793_026_800_000, '秒级时间戳必须归一成毫秒')
  assert.equal(balance.pending[0].planId, 'zcode-v3-start-plan-nt-1026')
})

test('fetchBalance: 已生效的 entitlement 不进 pending（balances 已覆盖）', async () => {
  const { fetchBalance } = await import('../lib/upstream-api.js')
  const balance = await fetchBalance({ zcode_jwt: 'j', device_mid: 'd' }, fakeFetch({
    code: 0,
    data: {
      server_time: 1_793_026_800, // 恰好等于 effective_at
      plans: [
        {
          plan_id: 'p',
          entitlements: [{ show_name: 'X', grant_units: 100, effective_at: 1_793_026_800 }],
        },
      ],
      balances: [{ show_name: 'X', total_units: 100, remaining_units: 100 }],
    },
  }))
  assert.equal(balance.pending, undefined)
  assert.equal(balance.remaining, 100)
})

test('fetchBalance: grant_units 非正数 / 缺 effective_at 的条目跳过，多条按到点时间排序', async () => {
  const { fetchBalance } = await import('../lib/upstream-api.js')
  const balance = await fetchBalance({ zcode_jwt: 'j', device_mid: 'd' }, fakeFetch({
    code: 0,
    data: {
      server_time: 1_000,
      plans: [
        {
          plan_id: 'p',
          entitlements: [
            { show_name: 'later', grant_units: 50, effective_at: 3_000 },
            { show_name: 'zero', grant_units: 0, effective_at: 2_000 },
            { show_name: 'no-time', grant_units: 70 },
            { show_name: 'earlier', grant_units: 10, effective_at: 2_000 },
          ],
        },
      ],
      balances: [],
    },
  }))
  assert.equal(balance.pending?.length, 2, '零额度与缺时间的要跳过')
  assert.deepEqual(balance.pending.map((item) => item.showName), ['earlier', 'later'])
})

test('fetchBalance: 企业版形态不变（不解析 pending）', async () => {
  const { fetchBalance } = await import('../lib/upstream-api.js')
  const balance = await fetchBalance({ zcode_jwt: 'j', device_mid: 'd' }, fakeFetch({
    code: 0,
    data: { displayMode: 'enterprise', plans: [{ entitlements: [{ grant_units: 5, effective_at: 9_999 }] }] },
  }))
  assert.equal(balance.enterprise, true)
  assert.equal(balance.pending, undefined)
})

test('fetchBalance: expires_at 秒级归一成毫秒，且只汇总还有余额的桶', async () => {
  const { fetchBalance } = await import('../lib/upstream-api.js')
  // 2026-10-26 实测：两个桶的 expires_at 都是 1793030399（当天 23:59:59 +08）
  const balance = await fetchBalance({ zcode_jwt: 'j', device_mid: 'd' }, fakeFetch({
    code: 0,
    data: {
      server_time: 1_793_022_000,
      plans: [],
      balances: [
        { show_name: 'GLM-5.3', total_units: 3_000_000, used_units: 0, remaining_units: 3_000_000, available_units: 3_000_000, expires_at: 1_793_030_399 },
        { show_name: 'GLM-5.3-Flash', total_units: 5_000_000, used_units: 5_000_000, remaining_units: 0, available_units: 0, expires_at: 1_800_000_000 },
      ],
    },
  }))
  assert.equal(balance.expiresAt, 1_793_030_399_000, '秒级必须归一成毫秒（否则界面显示 1970）')
  /**
   * 已用光的 Flash 桶（expires_at 更晚）不能参与顶层汇总 —— 否则会给出
   * 「一个空桶的到期时间」，误导用户以为还有额度。
   */
  assert.notEqual(balance.expiresAt, 1_800_000_000_000)
  assert.equal(balance.buckets[1].expiresAt, 1_800_000_000_000, '每个桶仍保留自己的到期时间')
})

test('fetchBalance: 所有桶都用光时不给顶层 expiresAt', async () => {
  const { fetchBalance } = await import('../lib/upstream-api.js')
  const balance = await fetchBalance({ zcode_jwt: 'j', device_mid: 'd' }, fakeFetch({
    code: 0,
    data: {
      server_time: 1_793_022_000,
      plans: [],
      balances: [
        { show_name: 'X', total_units: 100, used_units: 100, remaining_units: 0, available_units: 0, expires_at: 1_793_030_399 },
      ],
    },
  }))
  assert.equal(balance.expiresAt, undefined)
  assert.equal(balance.remaining, 0)
})

test('fetchBalance: 未生效权益带上 plan 的 ends_at 作为到期时间', async () => {
  const { fetchBalance } = await import('../lib/upstream-api.js')
  const balance = await fetchBalance({ zcode_jwt: 'j', device_mid: 'd' }, fakeFetch({
    code: 0,
    data: {
      server_time: 1_793_021_836,
      plans: [
        {
          plan_id: 'p1',
          ends_at: 1_793_062_800,
          entitlements: [{ show_name: 'GLM-5.3-Flash', grant_units: 300_000_000, effective_at: 1_793_026_800 }],
        },
      ],
      balances: [],
    },
  }))
  assert.equal(balance.pending[0].expiresAt, 1_793_062_800_000)
})

test('fetchBalance: 多桶按到期时间升序、空桶沉底（逐桶到期时间供面板分条显示）', async () => {
  const { fetchBalance } = await import('../lib/upstream-api.js')
  const now = Math.floor(Date.now() / 1000)
  const balance = await fetchBalance({ zcode_jwt: 'j', device_mid: 'd' }, fakeFetch({
    code: 0,
    data: {
      server_time: now,
      balances: [
        { plan_id: 'late', show_name: '晚到期', total_units: 1000, remaining_units: 500, expires_at: now + 7 * 86_400 },
        { plan_id: 'empty', show_name: '空桶', total_units: 1000, remaining_units: 0, expires_at: now + 86_400 },
        { plan_id: 'soon', show_name: '早到期', total_units: 2000, remaining_units: 800, expires_at: now + 3 * 86_400 },
      ],
    },
  }))
  assert.deepEqual(
    balance.buckets.map((b) => b.planId),
    ['soon', 'late', 'empty'],
    '有余额的桶按到期升序，空桶沉底',
  )
  assert.equal(balance.expiresAt, (now + 3 * 86_400) * 1000, '顶层 expiresAt = 最早到期的有余额桶')
  /** 每个桶带自己的数值与到期时间（面板分条用）。 */
  for (const b of balance.buckets) {
    assert.equal(typeof b.remainingUnits, 'number')
    assert.equal(typeof b.totalUnits, 'number')
    assert.ok(b.expiresAt > Date.now())
  }
})

test('fetchBalance: 单桶时行为不变（buckets 仍下发，面板走汇总条）', async () => {
  const { fetchBalance } = await import('../lib/upstream-api.js')
  const now = Math.floor(Date.now() / 1000)
  const balance = await fetchBalance({ zcode_jwt: 'j', device_mid: 'd' }, fakeFetch({
    code: 0,
    data: {
      server_time: now,
      balances: [{ plan_id: 'p', show_name: 'GLM', total_units: 100, remaining_units: 40, expires_at: now + 3600 }],
    },
  }))
  assert.equal(balance.buckets.length, 1)
  assert.equal(balance.remaining, 40)
  assert.equal(balance.total, 100)
})