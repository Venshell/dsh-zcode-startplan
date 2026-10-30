/**
 * 分发 key（0.9.4）：把账号池额度**受限地**分发给别人/别的设备用。
 *
 * ## 模型
 *
 * 主 apiKey（`openai-api-key`，不限量）之外，可以生成任意多个分发 key，每个有：
 * - `token`：`zsp-` 前缀 + 16 字节 base64url（与主 key 形态区分，见 isDistributionKey）；
 * - `name`：人类可读标识（给谁的）；
 * - `quotaTotal`：token 限额（usage 累计到它就拒）——**不切换**，用完即 429
 *   （用户决策：给外人用时隔离最强，不怕烧超）；
 * - `accountId`（可选）：钉定到某个池内账号；不绑 = 从整个账号池选号（expiry 顺序）；
 * - `enabled`：禁用立即生效（401），不删记录（用量保留）；
 * - `usage`：累计输入/输出 token 与请求数（进程内 + 落盘双份，见下）。
 *
 * ## 持久化
 *
 * `<dataDir>/distribution-keys.json`：`{ keys: [...] }`，**每次变更即写**（生成/
 * 禁用/删除是低频操作）。用量**不落这个文件**——它是每次请求都变的，落盘会
 * 把 JSON 写成热点；用量记账在 openai-gateway 进程内累加、随 usage 块定期回写
 * 本文件（见 openai-gateway.js 的 recordUsage）。
 *
 * ## 计量口径
 *
 * 用 DSH StreamChunk 的 `usage` 块（inputTokens + outputTokens，已含缓存），
 * 与面板余额的口径一致。请求被限额拒绝时**不计**（没有产出就没有消耗）。
 */

import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** 分发 key 的形态判据（`zsp-` + 22 位 base64url ≈ 16 字节熵）。 */
export const DISTRIBUTION_KEY_PATTERN = /^zsp-[A-Za-z0-9_-]{22}$/

/** 单条分发 key 的持久化形态。 */
export function createDistributionKey(name, { quotaTotal, accountId } = {}) {
  return {
    token: `zsp-${randomBytes(16).toString('base64url')}`,
    name: typeof name === 'string' && name.trim().length > 0 ? name.trim() : '未命名',
    quotaTotal: Number.isFinite(quotaTotal) && quotaTotal > 0 ? Math.floor(quotaTotal) : null,
    accountId: typeof accountId === 'string' && accountId.length > 0 ? accountId : null,
    enabled: true,
    createdAt: Date.now(),
    usage: { inputTokens: 0, outputTokens: 0, requests: 0 },
  }
}

export function loadDistributionKeys(dataDir) {
  const file = join(dataDir, 'distribution-keys.json')
  try {
    if (!existsSync(file)) return []
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (!Array.isArray(parsed?.keys)) return []
    return parsed.keys.filter((key) => key !== null && typeof key === 'object' && typeof key.token === 'string')
  } catch {
    return []
  }
}

export function saveDistributionKeys(dataDir, keys) {
  const file = join(dataDir, 'distribution-keys.json')
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(file, JSON.stringify({ keys }, null, 1))
}

/** 该 key 的限额还剩多少（quotaTotal = null 表示不限）。 */
export function quotaRemaining(key) {
  if (key?.quotaTotal === null || key?.quotaTotal === undefined) return null
  const used = (key.usage?.inputTokens ?? 0) + (key.usage?.outputTokens ?? 0)
  return Math.max(0, key.quotaTotal - used)
}

/** 限额判定：disabled / 超限都拒；返回 null = 通过，字符串 = 拒绝原因。 */
export function checkDistributionKey(key) {
  if (key === undefined) return '无效的分发 key'
  if (key.enabled !== true) return '该分发 key 已被禁用'
  const remaining = quotaRemaining(key)
  if (remaining !== null && remaining <= 0) return '该分发 key 的额度已用尽'
  return null
}

/** 面板/路由对外展示的脱敏形态（token 只留尾 4 位）。 */
export function publicDistributionKey(key) {
  const remaining = quotaRemaining(key)
  return {
    token: `••••${String(key.token).slice(-4)}`,
    name: key.name,
    quotaTotal: key.quotaTotal,
    accountId: key.accountId,
    enabled: key.enabled === true,
    createdAt: key.createdAt,
    usage: {
      inputTokens: key.usage?.inputTokens ?? 0,
      outputTokens: key.usage?.outputTokens ?? 0,
      requests: key.usage?.requests ?? 0,
    },
    remaining,
  }
}
