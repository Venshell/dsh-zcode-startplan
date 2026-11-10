#!/usr/bin/env node
/**
 * 采集下发间隔：把所有账号的 plan 授予时间（starts_at / effective_at /
 * period_start）与 server_time 摆在一起，看服务端按什么节奏下发。
 *
 * 用法：
 *   node scripts/analyze-grant-intervals.mjs [--json]
 *
 * 只读：只打 billing/balance，不 claim、不 mint captcha、不发 touch/action。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

const ORIGIN = 'https://zcode.z.ai'
const GATED = '3.16.3'
const AS_JSON = process.argv.includes('--json')

function gated(c) {
  const v = typeof c?.app_version === 'string' ? c.app_version.trim() : ''
  const ok = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(v)
  if (!ok) return GATED
  return v < GATED ? GATED : v
}

async function loadAccounts() {
  const dir = join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh', 'zcode-start-plan')
  if (!existsSync(dir)) throw new Error('找不到 ~/.dsh/zcode-start-plan')
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(dir, 'accounts.db'), { readOnly: true })
  const rows = db.prepare('select id, nickname, credential from accounts').all()
  db.close()
  return rows.map((r) => ({
    id: r.id,
    nickname: r.nickname ?? r.id,
    credential: typeof r.credential === 'string' ? JSON.parse(r.credential) : r.credential,
  }))
}

function headers(c) {
  const ver = gated(c)
  return {
    'User-Agent': `ZCode/${ver}`,
    'HTTP-Referer': ORIGIN,
    'X-Title': 'Z Code@electron',
    'X-ZCode-App-Version': ver,
    'X-Release-Channel': 'production',
    'X-Client-Language': 'zh-CN',
    'X-Client-Timezone': 'Asia/Shanghai',
    'X-Device-Mid': c.device_mid,
    'X-Platform': 'win32-x64',
    'X-Os-Category': 'windows',
    'X-Os-Version': '10.0.19045',
    'X-ZCode-Agent': 'glm',
    'X-Session-Id': c.session_id ?? crypto.randomUUID(),
    'X-ZCode-Session-Type': 'other',
    'X-Request-Id': crypto.randomUUID(),
    'X-ZCode-Trace-Id': crypto.randomUUID(),
    'anthropic-version': '2023-06-01',
    Accept: 'application/json',
    authorization: `Bearer ${c.zcode_jwt}`,
  }
}

const fmt = (s) =>
  typeof s === 'number' && s > 0 ? new Date(s * 1000).toLocaleString('zh-CN', { hour12: false }) : '-'
const rel = (s, base) =>
  typeof s === 'number' && s > 0 && typeof base === 'number'
    ? `${((s - base) / 60).toFixed(1)}m`
    : '-'

const accounts = await loadAccounts()
const rows = []
for (const account of accounts) {
  let payload
  try {
    const response = await fetch(`${ORIGIN}/api/v1/zcode-plan/billing/balance`, {
      headers: headers(account.credential),
      signal: AbortSignal.timeout(20_000),
    })
    payload = await response.json().catch(() => undefined)
  } catch (error) {
    rows.push({ nickname: account.nickname, error: String(error?.message ?? error) })
    continue
  }
  const data = payload?.data ?? {}
  rows.push({
    nickname: account.nickname,
    serverTime: data.server_time,
    plans: (Array.isArray(data.plans) ? data.plans : []).map((p) => ({
      planId: p.plan_id,
      status: p.status,
      startsAt: p.starts_at,
      endsAt: p.ends_at,
      entitlements: (Array.isArray(p.entitlements) ? p.entitlements : []).map((e) => ({
        showName: e.show_name,
        grantUnits: e.grant_units,
        effectiveAt: e.effective_at,
      })),
    })),
    balances: (Array.isArray(data.balances) ? data.balances : []).map((b) => ({
      planId: b.plan_id,
      total: b.total_units,
      used: b.used_units,
      remaining: b.remaining_units,
      periodStart: b.period_start,
      expiresAt: b.expires_at,
    })),
  })
}

if (AS_JSON) {
  console.log(JSON.stringify(rows, null, 2))
  process.exit(0)
}

for (const row of rows) {
  if (row.error !== undefined) {
    console.log(`\n${row.nickname}  ERR ${row.error}`)
    continue
  }
  console.log(`\n=== ${row.nickname}  server_time=${row.serverTime} (${fmt(row.serverTime)}) ===`)
  if (row.plans.length === 0) console.log('  plans: 空（未收到任何活动）')
  for (const plan of row.plans) {
    const ent = plan.entitlements
      .map((e) => `${e.showName}:${e.grantUnits} eff=${fmt(e.effectiveAt)}(+${rel(e.effectiveAt, row.serverTime)})`)
      .join(' | ')
    console.log(
      `  ${plan.planId}  status=${plan.status}` +
        `  starts_at=${fmt(plan.startsAt)}(+${rel(plan.startsAt, row.serverTime)})` +
        `  ends_at=${fmt(plan.endsAt)}`,
    )
    if (ent.length > 0) console.log(`      entitlements: ${ent}`)
  }
  for (const bucket of row.balances) {
    console.log(
      `  bucket ${bucket.planId}  total=${bucket.total} used=${bucket.used} remaining=${bucket.remaining}` +
        `  period_start=${fmt(bucket.periodStart)}(+${rel(bucket.periodStart, row.serverTime)})` +
        `  expires=${fmt(bucket.expiresAt)}`,
    )
  }
}

/** 跨账号聚合：同一 plan_id 在各账号上的授予时刻差 = 下发间隔。 */
const byPlan = new Map()
for (const row of rows) {
  if (row.plans === undefined) continue
  for (const plan of row.plans) {
    const list = byPlan.get(plan.planId) ?? []
    list.push({ nickname: row.nickname, at: plan.startsAt, effectiveAt: plan.entitlements[0]?.effectiveAt })
    byPlan.set(plan.planId, list)
  }
}
console.log('\n=== 下发间隔（同一 plan 在各账号的 starts_at 差） ===')
if (byPlan.size === 0) console.log('  没有任何账号持有 plan。')
for (const [planId, entries] of byPlan) {
  const sorted = [...entries].sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
  console.log(`\n${planId}`)
  for (let i = 0; i < sorted.length; i += 1) {
    const item = sorted[i]
    const gap = i === 0 ? '—' : `${(((item.at ?? 0) - (sorted[i - 1].at ?? 0)) / 60).toFixed(1)} 分钟`
    console.log(`  ${String(i + 1).padStart(2)}. ${item.nickname.padEnd(10)} starts_at=${fmt(item.at)}  与上一账号间隔=${gap}`)
  }
  const gaps = sorted.slice(1).map((item, i) => (item.at ?? 0) - (sorted[i].at ?? 0))
  if (gaps.length > 0) {
    const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length / 60
    const min = Math.min(...gaps) / 60
    const max = Math.max(...gaps) / 60
    console.log(`  平均间隔 ${avg.toFixed(1)} 分钟，最小 ${min.toFixed(1)}，最大 ${max.toFixed(1)}`)
  }
}
