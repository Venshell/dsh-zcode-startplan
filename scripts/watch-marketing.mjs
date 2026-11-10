#!/usr/bin/env node
/**
 * 盯守某个账号是否被投放活动（只读）。
 *
 * 用途：区分「还没轮到」和「不会被轮到」—— 前者 deliveries/plans 会在某次轮询里
 * 变非空，后者永远不会。森也的 1103 是 00:04:53 才被授予的，说明服务端是分批下发，
 * 单次探测为空不足以判断资格。
 *
 * 用法：
 *   node scripts/watch-marketing.mjs <ACCOUNT_ID> [--interval 60] [--for 60]
 *
 *   --interval 秒，默认 60
 *   --for      最多跑多少分钟，默认 60（到点自动停）
 *
 * 只读：不 claim、不 mint captcha、不发 marketing touch/action（confirm/cancel 都会
 * 改变服务端对后续投放的行为，这里一律不碰）。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

const GATED_MIN = '3.16.3'
const ORIGIN = 'https://zcode.z.ai'

const accountId = process.argv[2]
const flag = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return fallback
  const value = Number(process.argv[index + 1])
  return Number.isFinite(value) && value > 0 ? value : fallback
}
const intervalSec = flag('interval', 60)
const forMinutes = flag('for', 60)

if (typeof accountId !== 'string' || !/^[0-9a-f-]{36}$/.test(accountId)) {
  console.error('用法：node scripts/watch-marketing.mjs <ACCOUNT_ID> [--interval 60] [--for 60]')
  process.exit(2)
}

function cmpVersion(a, b) {
  const seg = (v) => String(v).split('.').map((p) => { const m = /^\s*(\d+)/.exec(p); return m ? Number(m[1]) : 0 })
  const l = seg(a), r = seg(b)
  for (let i = 0; i < Math.max(l.length, r.length); i += 1) {
    const x = l[i] ?? 0, y = r[i] ?? 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

function gatedVersion(credential) {
  const v = typeof credential?.app_version === 'string' ? credential.app_version.trim() : ''
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(v)) return GATED_MIN
  return cmpVersion(v, GATED_MIN) < 0 ? GATED_MIN : v
}

async function loadCredential(id) {
  const dataDir = [join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh', 'zcode-start-plan')]
    .find((dir) => existsSync(dir))
  if (dataDir === undefined) throw new Error('找不到 ~/.dsh/zcode-start-plan')
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(dataDir, 'accounts.db'), { readOnly: true })
  const row = db.prepare('select * from accounts where id = ?').get(id)
  db.close()
  if (row === undefined) throw new Error(`账号不存在：${id}`)
  const credential = typeof row.credential === 'string' ? JSON.parse(row.credential) : row.credential
  return { credential, nickname: row.nickname ?? id }
}

function headersFor(credential) {
  const version = gatedVersion(credential)
  return {
    'User-Agent': `ZCode/${version}`,
    'HTTP-Referer': ORIGIN,
    'X-Title': 'Z Code@electron',
    'X-ZCode-App-Version': version,
    'X-Release-Channel': 'production',
    'X-Client-Language': 'zh-CN',
    'X-Client-Timezone': 'Asia/Shanghai',
    'X-Device-Mid': credential.device_mid,
    'X-Platform': 'win32-x64',
    'X-Os-Category': 'windows',
    'X-Os-Version': '10.0.19045',
    'X-ZCode-Agent': 'glm',
    'X-Session-Id': credential.session_id ?? crypto.randomUUID(),
    'X-ZCode-Session-Type': 'other',
    'X-Request-Id': crypto.randomUUID(),
    'X-ZCode-Trace-Id': crypto.randomUUID(),
    'anthropic-version': '2023-06-01',
    Accept: 'application/json',
    authorization: `Bearer ${credential.zcode_jwt}`,
  }
}

function findClaimButtons(node, depth = 0, out = []) {
  if (depth > 10 || node === null || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const item of node) findClaimButtons(item, depth + 1, out); return out }
  const type = node.action?.type ?? node.action_type ?? node.type
  if (typeof type === 'string' && /claim/i.test(type)) out.push(node)
  for (const value of Object.values(node)) findClaimButtons(value, depth + 1, out)
  return out
}

const fmt = (sec) => (typeof sec === 'number' && sec > 0 ? new Date(sec * 1000).toLocaleString([], { hour12: false }) : '-')

async function once(credential) {
  const headers = headersFor(credential)
  const [marketing, balance] = await Promise.all([
    fetch(`${ORIGIN}/api/v1/marketing/touch?seq=0`, { headers, signal: AbortSignal.timeout(25_000) })
      .then(async (r) => ({ status: r.status, json: await r.json().catch(() => undefined) }))
      .catch((e) => ({ status: undefined, error: String(e?.message ?? e) })),
    fetch(`${ORIGIN}/api/v1/zcode-plan/billing/balance`, { headers, signal: AbortSignal.timeout(25_000) })
      .then(async (r) => ({ status: r.status, json: await r.json().catch(() => undefined) }))
      .catch((e) => ({ status: undefined, error: String(e?.message ?? e) })),
  ])
  const deliveries = marketing.json?.data?.deliveries
  const plans = Array.isArray(balance.json?.data?.plans) ? balance.json.data.plans : []
  const buckets = Array.isArray(balance.json?.data?.balances) ? balance.json.data.balances : []
  const claims = Array.isArray(deliveries) ? deliveries.flatMap((d) => findClaimButtons(d)) : []
  return {
    serverTime: balance.json?.data?.server_time ?? marketing.json?.data?.server_time,
    marketingStatus: marketing.status,
    deliveries: Array.isArray(deliveries) ? deliveries.length : `非数组(${typeof deliveries})`,
    claimButtons: claims.length,
    plans: plans.map((p) => ({ id: p.plan_id, status: p.status, starts_at: fmt(p.starts_at), ends_at: fmt(p.ends_at) })),
    buckets: buckets.map((b) => ({ plan: b.plan_id, total: b.total_units, used: b.used_units, remaining: b.remaining_units })),
  }
}

const { credential, nickname } = await loadCredential(accountId)
const deadline = Date.now() + forMinutes * 60_000
console.log(`盯守 ${nickname} (${accountId})  间隔 ${intervalSec}s  上限 ${forMinutes} 分钟`)
console.log('（只读：不 claim、不 mint captcha、不发 confirm/cancel）\n')

let round = 0
while (Date.now() < deadline) {
  round += 1
  const startedAt = new Date().toLocaleTimeString([], { hour12: false })
  const result = await once(credential)
  const hit = result.claimButtons > 0 || result.plans.length > 0 || result.buckets.length > 0
  console.log(
    `[${startedAt}] #${round} server_time=${result.serverTime} ` +
      `deliveries=${result.deliveries} claimButtons=${result.claimButtons} plans=${result.plans.length} buckets=${result.buckets.length}` +
      `${hit ? '  ← 命中' : ''}`,
  )
  if (result.plans.length > 0) console.log(`    plans:   ${JSON.stringify(result.plans)}`)
  if (result.buckets.length > 0) console.log(`    buckets: ${JSON.stringify(result.buckets)}`)
  if (hit) {
    console.log('\n已观察到活动投放/权益，停止盯守。')
    process.exit(0)
  }
  const wait = Math.min(intervalSec * 1000, deadline - Date.now())
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
}
console.log(`\n${forMinutes} 分钟内未观察到任何投放或权益 —— 该账号在此期间确实没有被下发。`)
process.exitCode = 0
