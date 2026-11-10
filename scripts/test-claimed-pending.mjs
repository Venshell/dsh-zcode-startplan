#!/usr/bin/env node
/**
 * 回归用例：领取记录解析（`fetchClaimedPlans`）必须贴合**上游真实响应形状**。
 *
 * 数据来源（2026-11-03/06/07 原始响应实测，非臆测）：
 *
 *   data.plans[]: {
 *     plan_id, name, status, priority, starts_at(秒), ends_at(秒),
 *     entitlements: [{ show_name, unit_type, grant_units, effective_at(秒) }]
 *   }
 *   data.server_time: 秒
 *   ⚠ 上游没有顶层 `pending` —— 「已领未生效」按 effective_at > server_time 判。
 *   ⚠ `name` 是活动名（ZCODE WEEKEND BUILD），`show_name` 是模型名，别混。
 *   ⚠ 多条 entitlement 按 unit_type 求和；不同单位不混加。
 *
 * 运行：node scripts/test-claimed-pending.mjs
 */

import assert from 'node:assert/strict'
import { fetchClaimedPlans } from '../lib/upstream-api.js'

const credential = { zcode_jwt: 'test-jwt', device_mid: 'test-mid', app_version: '3.14.3' }

/** 造一个只回固定 JSON 的 fetch。 */
function fakeFetch(payload, status = 200) {
  return async () => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

const cases = []
function test(name, fn) {
  cases.push({ name, fn })
}

/** 1106-wk 真实形状（节选自 2026-11-06 23:00 原始响应）。 */
const REAL_1106 = {
  code: 0,
  msg: '',
  data: {
    server_time: 1793977241, // 2026-11-06 23:00:41 +08
    plans: [{
      user_plan_id: 'upl_2117601318960766976',
      plan_id: 'zcode-v3-start-plan-1106-wk',
      name: 'ZCODE WEEKEND BUILD',
      description: '',
      priority: 101,
      status: 'active',
      starts_at: 1793710472,
      ends_at: 1793754000, // 2026-11-09 09:00 +08（秒）
      entitlements: [{
        entitlement_id: 'ent-zcode-v3-start-plan-1106-wk-1',
        show_name: 'GLM-5.3-Flash',
        meter: 'model_usage',
        unit_type: 'token',
        capabilities: ['model:glm-5.3-flash'],
        grant_units: 500000000,
        period: 'one_time',
        priority: 101,
        effective_at: 1793718000, // 2026-11-06 23:00 +08（秒）
      }],
    }],
    balances: [{
      plan_id: 'zcode-v3-start-plan-1106-wk',
      total_units: 500000000,
      used_units: 6827270,
      remaining_units: 293172730,
      expires_at: 1793754000,
    }],
  },
}

test('真实形状：name 取活动名，entitlements 求和，秒级归一为毫秒', async () => {
  const plans = await fetchClaimedPlans(credential, fakeFetch(REAL_1106))
  assert.equal(plans.size, 1)
  const plan = plans.get('zcode-v3-start-plan-1106-wk')
  assert.equal(plan.claimed, true)
  assert.equal(plan.name, 'ZCODE WEEKEND BUILD')
  assert.equal(plan.unitType, 'token')
  assert.equal(plan.grantUnits, 500000000)
  assert.equal(plan.effectiveAt, 1793718000000) // 秒 → 毫秒
  assert.equal(plan.expiresAt, 1793754000000)
  assert.equal(plan.priority, 101)
  assert.equal(plan.status, 'active')
})

test('effective_at 已过点（server_time 更晚）→ pending=false（已生效）', async () => {
  const plans = await fetchClaimedPlans(credential, fakeFetch(REAL_1106))
  // server_time=1793977241 > effective_at=1793718000
  assert.equal(plans.get('zcode-v3-start-plan-1106-wk').pending, false)
})

test('effective_at 未到点（server_time 更早）→ pending=true（待生效）', async () => {
  const payload = structuredClone(REAL_1106)
  payload.data.server_time = 1793710000 // 早于 effective_at=1793718000
  const plans = await fetchClaimedPlans(credential, fakeFetch(payload))
  assert.equal(plans.get('zcode-v3-start-plan-1106-wk').pending, true)
})

test('同 unit_type 多条 entitlement 求和（1024 活动教训：3 亿 + 2 亿 = 5 亿）', async () => {
  const payload = structuredClone(REAL_1106)
  payload.data.plans[0].entitlements.push({
    show_name: 'GLM-5.3-Flash', unit_type: 'token', grant_units: 200000000, effective_at: 1793718000,
  })
  const plans = await fetchClaimedPlans(credential, fakeFetch(payload))
  assert.equal(plans.get('zcode-v3-start-plan-1106-wk').grantUnits, 700000000)
})

test('不同 unit_type 不混加（宁可少报）', async () => {
  const payload = structuredClone(REAL_1106)
  payload.data.plans[0].entitlements.push({
    show_name: '积分', unit_type: 'point', grant_units: 50, effective_at: 1793718000,
  })
  const plans = await fetchClaimedPlans(credential, fakeFetch(payload))
  const plan = plans.get('zcode-v3-start-plan-1106-wk')
  assert.equal(plan.grantUnits, 500000000) // 只有 token 被累加
  assert.equal(plan.unitType, 'token')
})

test('订阅类 plan 也在结果里（前缀过滤是调用方的职责，不是这里的）', async () => {
  const payload = structuredClone(REAL_1106)
  payload.data.plans.push({
    plan_id: 'zcode-v3-pro-monthly', name: 'Pro 订阅', status: 'active', ends_at: 1799999999,
    entitlements: [{ unit_type: 'token', grant_units: 1, effective_at: 1793718000 }],
  })
  const plans = await fetchClaimedPlans(credential, fakeFetch(payload))
  assert.equal(plans.size, 2)
  assert.ok(plans.has('zcode-v3-pro-monthly'))
})

test('空 plans / 非 2xx / 缺字段 → 空或跳过，不抛', async () => {
  assert.equal((await fetchClaimedPlans(credential, fakeFetch({ code: 0, data: { plans: [], balances: [] } }))).size, 0)
  assert.equal((await fetchClaimedPlans(credential, fakeFetch({ code: 401 }, 401))).size, 0)
  const partial = await fetchClaimedPlans(credential, fakeFetch({
    code: 0,
    data: { server_time: 1, plans: [{ status: 'active' }, { plan_id: '' }, { plan_id: 'ok-1' }] },
  }))
  assert.equal(partial.size, 1)
  assert.ok(partial.has('ok-1'))
})

let passed = 0
for (const { name, fn } of cases) {
  try {
    await fn()
    passed += 1
    console.log(`✓ ${name}`)
  } catch (error) {
    console.error(`✗ ${name}`)
    console.error(`  ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
console.log(`\n${passed}/${cases.length} 通过`)
