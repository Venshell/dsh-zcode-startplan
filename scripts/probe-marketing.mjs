#!/usr/bin/env node
/**
 * 原始探针：绕过 /claimable 的静默降级，直接看 marketing/touch 与 billing/preview
 * 的**原始**状态码、业务 code 与 deliveries 结构。
 *
 * 用法：
 *   node scripts/probe-marketing.mjs <ACCOUNT_ID> [--raw]
 *
 * 凭据从本地账号库读取（与插件同一份 SQLite）。只读：
 *   - 不 claim（claim 会消耗活动资格 + 烧设备 captcha）
 *   - 不发 marketing/touch/action 的 confirm/cancel（confirm 会让服务端停止投放，
 *     cancel 更糟：等于告诉服务端「别再给我看」）
 *   - 不改任何账号状态
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const GATED_MIN = '3.16.3'
const ORIGIN = 'https://zcode.z.ai'
const PRINT_RAW = process.argv.includes('--raw')

/** 账号库位置解析：环境变量 → 插件默认目录。 */
function resolveDataDir() {
  const env = process.env
  for (const key of ['ZCODE_START_PLAN_DATA_DIR', 'ZSP_DATA_DIR', 'ZCODE_DATA_DIR']) {
    if (typeof env[key] === 'string' && env[key].trim().length > 0) return env[key].trim()
  }
  const home = env.USERPROFILE ?? env.HOME ?? '.'
  /** 插件默认目录是 `~/.dsh/zcode-start-plan`（与 pool.resolveDataDir 一致）。 */
  const candidates = [
    join(home, '.dsh', 'zcode-start-plan'),
    join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'deepseek-harness', 'zcode-start-plan'),
  ]
  return candidates.find((dir) => existsSync(dir)) ?? candidates[0]
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

function headersFor(credential, extra = {}) {
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
    'Accept': 'application/json',
    ...extra,
  }
}

async function loadAccounts() {
  const dataDir = resolveDataDir()
  const candidates = ['accounts.db', 'pool.db', 'zcode-start-plan.db']
  const file = candidates.map((n) => join(dataDir, n)).find((p) => existsSync(p))
  if (file === undefined) throw new Error(`找不到账号库：${dataDir} 下 ${candidates.join(' / ')}`)
  let DatabaseSync
  try { ({ DatabaseSync } = await import('node:sqlite')) } catch {
    throw new Error('当前 Node 不支持 node:sqlite（需 Node 22.19+ 或 24+）')
  }
  const db = new DatabaseSync(file, { readOnly: true })
  const tables = db.prepare("select name from sqlite_master where type='table'").all()
  const names = tables.map((t) => t.name)
  const table = ['accounts', 'account', 'pool'].find((n) => names.includes(n))
  if (table === undefined) throw new Error(`账号库里没有 accounts 表，现有表：${names.join(', ')}`)
  const rows = db.prepare(`select * from ${table}`).all()
  db.close()
  return { file, rows, table }
}

/** 从行里抽出 credential（可能是 JSON 列，也可能散列）。 */
function credentialOf(row) {
  if (typeof row.credential === 'string') {
    try { return JSON.parse(row.credential) } catch { return undefined }
  }
  if (row.credential !== null && typeof row.credential === 'object') return row.credential
  return {
    zcode_jwt: row.zcode_jwt ?? row.jwt,
    device_mid: row.device_mid,
    app_version: row.app_version,
    user_id: row.user_id,
  }
}

/** 递归找 deliveries 里所有 claim_zcode_plan 按钮（含被改名 / 换层的）。 */
function findClaimButtons(node, depth = 0, out = []) {
  if (depth > 10 || node === null || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const item of node) findClaimButtons(item, depth + 1, out); return out }
  const type = node.action?.type ?? node.action_type ?? node.type
  if (typeof type === 'string' && /claim/i.test(type)) out.push(node)
  for (const value of Object.values(node)) findClaimButtons(value, depth + 1, out)
  return out
}

async function probe(label, url, headers) {
  const started = Date.now()
  let status, body, error
  try {
    const response = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(25_000) })
    status = response.status
    body = await response.text()
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught)
  }
  const elapsed = Date.now() - started
  console.log(`\n--- ${label} ---`)
  console.log(`URL   ${url}`)
  console.log(`HTTP  ${status ?? `ERR (${error})`}  ${elapsed}ms`)
  let parsed
  try { parsed = JSON.parse(body ?? '') } catch { parsed = undefined }
  if (parsed === undefined) {
    if (body !== undefined) console.log(`BODY  ${body.slice(0, 600)}`)
    return { status, parsed }
  }
  console.log(`code  ${JSON.stringify(parsed.code ?? parsed.error?.code ?? null)}  msg=${JSON.stringify(parsed.message ?? parsed.error?.message ?? parsed.msg ?? null)}`)
  const deliveries = parsed?.data?.deliveries
  console.log(`deliveries ${Array.isArray(deliveries) ? `${deliveries.length} 条` : `非数组 (${typeof deliveries})`}`)
  if (Array.isArray(deliveries)) {
    for (const [i, delivery] of deliveries.entries()) {
      const buttons = findClaimButtons(delivery)
      console.log(`  [${i}] campaign_id=${JSON.stringify(delivery?.campaign_id)} priority=${delivery?.priority}` +
        ` title=${JSON.stringify(delivery?.banner?.title?.content ?? delivery?.popup?.title?.content ?? null)}` +
        ` claimButtons=${buttons.length}`)
      for (const button of buttons) {
        console.log(`       action=${JSON.stringify(button.action ?? button.action_type)}` +
          ` text=${JSON.stringify(button?.text?.content ?? button?.label ?? null)}`)
      }
    }
  }
  if (PRINT_RAW) console.log(`RAW   ${(body ?? '').slice(0, 4000)}`)
  return { status, parsed, deliveries }
}

async function main() {
  const id = process.argv[2]
  if (typeof id !== 'string' || id.length === 0) throw new Error('用法：node scripts/probe-marketing.mjs <ACCOUNT_ID> [--raw]')
  const { file, rows, table } = await loadAccounts()
  console.log(`账号库 ${file}（表 ${table}，${rows.length} 行）`)
  const row = rows.find((r) => (r.id ?? r.account_id) === id)
  if (row === undefined) throw new Error(`账号不存在：${id}`)
  const credential = credentialOf(row)
  const nickname = row.nickname ?? row.name ?? row.id
  console.log(`目标  ${nickname} (${id})  channel=${row.channel ?? '-'}  app_version=${credential?.app_version ?? '(缺)'}  device_mid=${credential?.device_mid ?? '(缺)'}`)
  if (typeof credential?.zcode_jwt !== 'string' || credential.zcode_jwt.length === 0) {
    throw new Error('该账号没有 zcode_jwt（bigmodel 渠道用 bigmodel 自己的鉴权，marketing 端点不适用）')
  }

  const auth = { authorization: `Bearer ${credential.zcode_jwt}` }
  const marketing = await probe('marketing/touch', `${ORIGIN}/api/v1/marketing/touch?seq=0`, headersFor(credential, auth))

  const version = gatedVersion(credential)
  await probe('billing/preview', `${ORIGIN}/api/v1/zcode-plan/billing/preview?app_version=${encodeURIComponent(version)}&platform=win32`, headersFor(credential, auth))
  await probe('billing/balance', `${ORIGIN}/api/v1/zcode-plan/billing/balance`, headersFor(credential, auth))

  const claims = (marketing.deliveries ?? []).flatMap((d) => findClaimButtons(d))
  console.log('\n=== 判读 ===')
  if (marketing.status === undefined) {
    console.log('marketing 请求本身失败（网络/超时）→ 空列表是故障，不是「没有活动」。')
  } else if (marketing.status === 401 || marketing.status === 403) {
    console.log('marketing 鉴权失败 → jwt 过期或无效；插件会把这种情况静默显示成「无活动」。')
  } else if (marketing.status !== 200) {
    console.log(`marketing 返回 ${marketing.status} → 非 200 被插件吞成 []，不可据此判断有无活动。`)
  } else if (Array.isArray(marketing.deliveries) && marketing.deliveries.length === 0) {
    console.log('marketing 200 且 deliveries 确实为空 → 服务端此刻未向该账号投放（或已领后停投）。')
  } else if (claims.length === 0) {
    console.log('marketing 有 deliveries 但找不到 claim 按钮 → 投放 schema 可能改版，插件的按钮路径解析失配。')
  } else {
    console.log(`marketing 有 ${claims.length} 个领取按钮 → 活动存在，但插件没能呈现（看上面 action 的 type/args 是否还是 claim_zcode_plan）。`)
  }
  console.log('（只读：未 claim、未发 marketing confirm/cancel、未改账号状态）')
}

main().catch((error) => {
  console.error(`探针失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
