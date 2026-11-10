#!/usr/bin/env node
/**
 * 诊断脚本：为什么「活动存在但 /claimable 列表为空」。
 *
 * 用法：
 *   node scripts/debug-claimable.mjs <ACCOUNT_ID|--all>
 *
 * 需要宿主管理端点可达（默认 http://127.0.0.1:56357，可用 ZSP_HOST 覆盖），
 * 且 Host 头必须是 localhost（manage-routes 的 loopback 栅栏认 hostname）。
 *
 * 只做**只读**请求：balance / preview / marketing touch，绝不 claim、绝不 mint
 * captcha、绝不发 confirm 回执（后者会让服务端不再投放该 campaign）。
 *
 * 输出每个来源的原始状态码 + 业务 code + 解析出的 plan_id，并逐条对照
 * `fetchClaimablePlans` 的合并规则，指明列表为空的**具体**环节。
 */

/**
 * 宿主端口：每次 DSH 重启都会变（实测 56357 → 61944 → 55241 → 49273），
 * 硬编码只会让脚本在重启后失效。按优先级：
 *   1. `ZSP_HOST` 显式指定；
 *   2. 从环境变量 `DSH_WEB_URL` / 常见端口段自动探测（能应答 `/summary` 的那个）。
 */
async function resolveHost() {
  if (typeof process.env.ZSP_HOST === 'string' && process.env.ZSP_HOST.trim().length > 0) {
    return process.env.ZSP_HOST.trim().replace(/\/$/, '')
  }
  const candidates = []
  const explicit = process.env.DSH_WEB_URL ?? process.env.DSH_URL ?? ''
  const match = /^https?:\/\/[^:/]+:(\d+)/.exec(explicit)
  if (match !== null) candidates.push(Number(match[1]))
  /** DSH 桌面端分配的高位端口，扫一段足够覆盖实际取值。 */
  for (let port = 49000; port <= 66000; port += 1) candidates.push(port)

  for (const port of candidates) {
    const host = `http://127.0.0.1:${port}`
    try {
      const response = await fetch(`${host}${PREFIX}/summary`, {
        headers: { host: `localhost:${port}`, accept: 'application/json' },
        signal: AbortSignal.timeout(300),
      })
      if (response.status === 200) {
        const body = await response.json().catch(() => undefined)
        if (body?.ok === true) return host
      }
    } catch {
      // 端口不通，继续。
    }
  }
  throw new Error('找不到 DSH 宿主端口：请设置 ZSP_HOST=http://127.0.0.1:<端口>')
}

const PREFIX = '/api/zcode-start-plan'
let HOST = ''

/** 直接打上游时用的凭据来源：宿主面板不会把 jwt 吐出来，故从本地库读。 */
const ORIGIN = 'https://zcode.z.ai'
const GATED_MIN_VERSION = '3.16.3'

const arg = process.argv[2]

async function hostJson(path) {
  const response = await fetch(`${HOST}${PREFIX}${path}`, {
    headers: { host: new URL(HOST).host.replace(/^127\.0\.0\.1/, 'localhost'), accept: 'application/json' },
  })
  const text = await response.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = undefined
  }
  return { status: response.status, parsed, text }
}

async function listAccounts() {
  const { status, parsed, text } = await hostJson('/summary')
  if (status !== 200) throw new Error(`summary HTTP ${status}: ${text.slice(0, 200)}`)
  return parsed.accounts ?? []
}

async function describeAccount(account) {
  const lines = []
  const id = account.id
  lines.push(`\n=== ${account.nickname} (${id}) channel=${account.channel} enabled=${account.enabled} ===`)

  const balance = await hostJson(`/balance?id=${encodeURIComponent(id)}`)
  lines.push(`balance  HTTP ${balance.status} -> ${JSON.stringify(balance.parsed?.balance ?? balance.parsed)}`)

  const claimable = await hostJson(`/claimable?id=${encodeURIComponent(id)}`)
  lines.push(`claimable HTTP ${claimable.status} -> ${JSON.stringify(claimable.parsed)}`)

  const plans = Array.isArray(claimable.parsed?.plans) ? claimable.parsed.plans : []
  if (plans.length === 0) {
    lines.push('诊断：两个来源都没给出 plan。可能环节：')
    lines.push('  1. marketing/touch 的 deliveries 为空 —— 版本门控（<3.16.3 恒空）或该 campaign 已对该账号停止投放（领过即停）；')
    lines.push('  2. preview 的 data.plans 为空 —— 每日包已领 / 账号无资格；')
    lines.push('  3. billing/balance 的 plans[] 里也没有 → 无法回填「已领取」标记，面板只能显示空列表。')
  } else {
    for (const plan of plans) {
      lines.push(
        `  plan ${plan.planId} claimed=${plan.claimed === true} priority=${plan.priority ?? '-'}` +
          ` name=${plan.name ?? '-'} campaignId=${plan.campaignId ?? '(缺)'}`,
      )
      if (plan.campaignId === undefined) {
        lines.push('  ⚠ 无 campaignId：领取成功后发不了 confirm 回执，服务端会继续重复投放同一 campaign。')
      }
    }
  }
  return lines.join('\n')
}

async function main() {
  HOST = await resolveHost()
  let accounts
  if (arg === '--all' || arg === undefined) {
    accounts = await listAccounts()
  } else {
    accounts = (await listAccounts()).filter((item) => item.id === arg)
    if (accounts.length === 0) throw new Error(`账号不存在：${arg}`)
  }
  console.log(`宿主：${HOST}  账号数：${accounts.length}`)
  for (const account of accounts) console.log(await describeAccount(account))
  console.log('\n（只读诊断结束：未 mint captcha、未 claim、未发送 marketing confirm/cancel）')
}

main().catch((error) => {
  console.error(`诊断失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
