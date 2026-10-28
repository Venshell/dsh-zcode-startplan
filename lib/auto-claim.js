/**
 * 营销活动自动领取（0.6.0）。
 *
 * ## 状态机
 *
 * ```
 * tick() → 对每个启用账号 fetchClaimablePlans（marketing/touch，GET、零 captcha）
 *        → 发现「未见过」的 planId 才走领取链路（mint captcha → billing/claim）
 *        → 0（成功）/ 1003（已领过）/ 1005（领完）都记入 seen 并持久化
 *        → 其它码（网络失败 / captcha 失败）不记 —— 下轮重试
 * ```
 *
 * ## 为什么必须记「已见」集合
 *
 * captcha 是设备级的稀缺资源（产出要 CDP 会话 + 有退避闸门 + 烧设备信誉）。
 * 活动投放一旦上线会**持续存在数天**：不记集合的话每 30 分钟就会对同一个
 * planId 白 mint 一次 captcha，吃一次 `1003`。`0`/`1003`/`1005` 是三种
 * 「这个 planId 已无蜡可蜡」的终态，见码即记。
 *
 * 持久化到 `dataDir/auto-claim-state.json`（非凭据，无需加密）：
 * `{ version: 1, seen: { "<accountId>": { "<planId>": { code, at } } } }`。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const STATE_VERSION = 1

/** 这些业务码代表「该 planId 的领取已到终态」，不再重试。 */
const TERMINAL_CODES = new Set([0, 1003, 1005])

/** 读持久化状态；坏文件按空状态处理（丢失集合的代价只是多一次 1003，可接受）。 */
export function loadAutoClaimState(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || parsed.version !== STATE_VERSION) return {}
    const seen = {}
    for (const [accountId, plans] of Object.entries(parsed.seen ?? {})) {
      if (typeof accountId !== 'string' || plans === null || typeof plans !== 'object') continue
      const record = {}
      for (const [planId, item] of Object.entries(plans)) {
        if (typeof planId !== 'string' || planId.length === 0) continue
        if (item === null || typeof item !== 'object') continue
        if (!TERMINAL_CODES.has(item.code)) continue
        record[planId] = { code: item.code, at: Number.isFinite(item.at) ? item.at : 0 }
      }
      if (Object.keys(record).length > 0) seen[accountId] = record
    }
    return seen
  } catch {
    return {}
  }
}

export function saveAutoClaimState(file, seen) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ version: STATE_VERSION, seen }, null, 2))
    return true
  } catch {
    return false
  }
}

/**
 * 创建自动领取控制器。
 *
 * @param {{
 *   pool: import('./pool.js').AccountPool,
 *   client: { mintCaptcha?: () => Promise<{ param: string, region: string }> },
 *   fetchClaimablePlans: (credential: any) => Promise<Array<{ planId: string, campaignId?: string, name?: string }>>,
 *   claimPlan: (credential: any, planId: string, captcha: any) => Promise<{ ok?: boolean, code?: number, alreadyClaimed?: boolean, message?: string }>,
 *   reportMarketingAction?: (credential: any, campaignId: string | undefined, actionType: 'confirm' | 'cancel') => Promise<void>,
 *   stateFile: string,
 *   log?: (message: string) => void,
 *   now?: () => number,
 * }} deps
 */
export function createAutoClaim(deps) {
  const log = deps.log ?? (() => {})
  const now = deps.now ?? (() => Date.now())
  /** accountId → planId → { code, at }。 */
  const seen = loadAutoClaimState(deps.stateFile)
  /** 跨 tick 的重入保护（tick 可能慢于 interval）。 */
  let running = false
  /** 统计（状态工具观测）。 */
  const stats = { lastRunAt: 0, lastError: null, lastResults: [] }

  const persist = () => {
    if (saveAutoClaimState(deps.stateFile, seen) === false) {
      log('[auto-claim] ⚠ 状态写盘失败（目录不可写）：重启后可能对同一活动重复 mint captcha')
    }
  }

  /**
   * 跑一轮扫描 + 领取。返回本轮每个账号的结果（供测试与状态工具）。
   * 任何账号的异常都被吞掉并记入 stats —— 轮询任务绝不能把插件打崩。
   */
  async function tick() {
    if (running === true) return []
    running = true
    const results = []
    try {
      const entries = deps.pool.list({ withCredentials: true }).filter((entry) => entry.enabled === true)
      for (const entry of entries) {
        const accountSeen = (seen[entry.id] ??= {})
        let plans
        try {
          plans = await deps.fetchClaimablePlans(entry.credential)
        } catch (error) {
          stats.lastError = `${entry.nickname}: ${error instanceof Error ? error.message : String(error)}`
          results.push({ accountId: entry.id, nickname: entry.nickname, error: stats.lastError })
          continue
        }
        for (const plan of plans) {
          const known = accountSeen[plan.planId]
          if (known !== undefined) continue
          if (typeof deps.client?.mintCaptcha !== 'function') {
            results.push({ accountId: entry.id, planId: plan.planId, skipped: 'captcha 载体不可用' })
            continue
          }
          let captcha
          try {
            captcha = await deps.client.mintCaptcha()
          } catch (error) {
            /** captcha 失败不记 seen：下轮重试（官方同样靠重试消化 CDN 抖动）。 */
            const message = `captcha 产出失败：${error instanceof Error ? error.message : String(error)}`
            results.push({ accountId: entry.id, planId: plan.planId, ok: false, error: message })
            continue
          }
          try {
            const outcome = await deps.claimPlan(entry.credential, plan.planId, captcha)
            const code = outcome.code
            const terminal = TERMINAL_CODES.has(code)
            if (terminal === true) {
              accountSeen[plan.planId] = { code, at: now() }
              persist()
            }
            results.push({
              accountId: entry.id,
              nickname: entry.nickname,
              planId: plan.planId,
              ...(plan.name !== undefined ? { name: plan.name } : {}),
              ok: outcome.ok === true,
              ...(code !== undefined ? { code } : {}),
              ...(outcome.alreadyClaimed === true ? { alreadyClaimed: true } : {}),
              ...(outcome.message !== undefined ? { message: outcome.message } : {}),
            })
            log(
              `[auto-claim] ${entry.nickname} × ${plan.planId}${plan.name !== undefined ? `（${plan.name}）` : ''}：` +
              `${outcome.ok === true ? (outcome.alreadyClaimed === true ? '已领过（幂等）' : '成功') : `失败 code=${code}`}` +
              `${terminal === true ? '（已记录，不再重试）' : '（未记录，下轮重试）'}`,
            )
            /** 官方点击按钮后会上报 confirm；纯统计，失败无碍。 */
            await deps.reportMarketingAction?.(entry.credential, plan.campaignId, 'confirm')
          } catch (error) {
            /** claim 请求本身抛错（网络层）：不记 seen，下轮重试。 */
            const message = error instanceof Error ? error.message : String(error)
            results.push({ accountId: entry.id, planId: plan.planId, ok: false, error: message })
            log(`[auto-claim] ${entry.nickname} × ${plan.planId} 请求异常：${message}`)
          }
        }
      }
      stats.lastRunAt = now()
      stats.lastError = null
      stats.lastResults = results
      return results
    } finally {
      running = false
    }
  }

  return {
    tick,
    /** 观测值（状态工具）。 */
    stats: () => ({
      lastRunAt: stats.lastRunAt,
      lastError: stats.lastError,
      lastResultCount: stats.lastResults.length,
      seenCount: Object.values(seen).reduce((n, plans) => n + Object.keys(plans).length, 0),
    }),
    /** 测试用：直接看 seen。 */
    seenSnapshot: () => JSON.parse(JSON.stringify(seen)),
  }
}
