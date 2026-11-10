/**
 * 分发 key（0.9.4）：把账号池额度**受限地**分发给别人/别的设备用。
 * 0.9.5 起网关**只认分发 key**（主 apiKey 已废除）——没有分发 key 时网关
 * 拒绝所有请求。每个 key：
 * - `token`：`zsp-` 前缀 + 16 字节 base64url；
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
 * ## 权限（0.10.0）
 *
 * 文件里是**明文 bearer token**（拿到即可消耗账号池额度）。Node 的 `fs.mode`
 * **只在创建时生效，且在 Windows 上完全被忽略**（实测 `chmodSync` 后仍是 666）；
 * 真正的权限来源是 NTFS ACL —— 而这个目录的默认继承 ACL 往往带着
 * `CodexSandboxUsers` / `Users` 之类的组。故落盘后依次尝试：
 * ① POSIX `chmod 600`（Linux/macOS 有效）；② Windows `icacls` 收成
 * 「当前用户 + SYSTEM + Administrators」。两条都失败的机器上退回「权限由卷
 * 加密兜底」，与 accounts.db 的既有权衡一致（README 已声明）。
 *
 * ## 计量口径
 *
 * 用 DSH StreamChunk 的 `usage` 块（inputTokens + outputTokens，已含缓存），
 * 与面板余额的口径一致。请求被限额拒绝时**不计**（没有产出就没有消耗）。
 */

import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** 分发 key 的形态判据（`zsp-` + 22 位 base64url ≈ 16 字节熵）。 */
export const DISTRIBUTION_KEY_PATTERN = /^zsp-[A-Za-z0-9_-]{22}$/

/** 单条分发 key 的持久化形态。 */
export function createDistributionKey(name, { quotaTotal, accountId } = {}) {
  return {
    /**
     * 稳定公开 id（非敏感）：列表/CRUD 用它定位。token 永不出现在列表里 ——
     * 0.9.5 实测：列表下发掩码 token，前端拿掩码去删 → 后端按明文找不到 → 404。
     */
    id: `dk_${randomBytes(6).toString('base64url')}`,
    token: `zsp-${randomBytes(16).toString('base64url')}`,
    name: typeof name === 'string' && name.trim().length > 0 ? name.trim() : '未命名',
    quotaTotal: Number.isFinite(quotaTotal) && quotaTotal > 0 ? Math.floor(quotaTotal) : null,
    accountId: typeof accountId === 'string' && accountId.length > 0 ? accountId : null,
    enabled: true,
    createdAt: Date.now(),
    usage: { inputTokens: 0, outputTokens: 0, requests: 0 },
  }
}

/**
 * 读分发 key。
 *
 * ⚠ **文件损坏必须抛错，不能静默返回空表**：
 * 静默空表 + 下一次任意 CRUD 的 `saveDistributionKeys` = 整个文件被覆盖成
 * `{keys:[]}`，所有已发出的 key 同时失效、用量记录清零，而日志里一个字都没有。
 * 抛错让 assemble 把网关降级为「未启动」并在面板显示原因 —— 保号优先于可用性。
 *
 * @param {string} dataDir
 * @param {{ backup?: (file: string) => string | undefined }} [options]
 *   `backup` 由调用方注入（把损坏文件改名留证）；不注入时只抛错不动文件。
 */
export function loadDistributionKeys(dataDir, options = {}) {
  const file = join(dataDir, 'distribution-keys.json')
  if (!existsSync(file)) return []
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    throw new Error(`分发 key 文件不可读（${file}）：${error instanceof Error ? error.message : String(error)}`)
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    /** 损坏：先备份（留证 + 让用户能手工抢救），再抛错。 */
    const backup = typeof options.backup === 'function' ? options.backup(file) : undefined
    throw new Error(
      `分发 key 文件损坏（${file}${backup !== undefined ? `，已备份为 ${backup}` : ''}）：` +
      `${error instanceof Error ? error.message : String(error)}。` +
      '为避免把全部 key 静默清空，本模块拒绝按空表继续；请修复或删除该文件后重启。',
    )
  }
  if (!Array.isArray(parsed?.keys)) {
    throw new Error(`分发 key 文件结构不对（${file}：缺少 keys 数组）。请修复或删除该文件后重启。`)
  }
  const out = []
  for (const key of parsed.keys) {
    if (key === null || typeof key !== 'object' || typeof key.token !== 'string') continue
    /**
     * ⚠ 迁移：0.9.6 之前落盘的 key **没有 `id`**（旧格式只存 token）。缺 id 的
     * key 在面板里永远删不掉/改不了 —— `publicDistributionKey` 投影出
     * `id: undefined`，JSON 序列化丢键，CRUD 请求体里根本没有定位键。
     * 补一个稳定 id（token 原样保留 = 凭据与用量不受影响）；下次任何落盘
     * （含删除本身）会把补上的 id 持久化。
     */
    if (typeof key.id !== 'string' || key.id.length === 0) {
      key.id = `dk_${randomBytes(6).toString('base64url')}`
    }
    out.push(key)
  }
  return out
}

/**
 * 尽量把文件权限收到「只有本用户能读」。
 *
 * @param {string} file
 * @param {{ platform?: string, quiet?: boolean }} [options]
 *   `platform` 供测试注入；`quiet` 时静默（默认打一条 warn 由调用方决定）
 * @returns {{ ok: boolean, via: 'posix-mode' | 'icacls' | 'none', error?: string }}
 */
export function hardenCredentialFile(file, options = {}) {
  const platform = options.platform ?? process.platform
  /** ① POSIX：先试 chmod（失败或无效都不报错，继续试 icacls）。 */
  if (platform !== 'win32') {
    try {
      chmodSync(file, 0o600)
      return { ok: true, via: 'posix-mode' }
    } catch (error) {
      return { ok: false, via: 'none', error: error instanceof Error ? error.message : String(error) }
    }
  }
  /**
   * ② Windows：`chmodSync` 是空操作（实测收紧后仍是 666），必须用 icacls。
   * `/inheritance:r` 断开继承（默认 ACL 带着 Sandbox/Users 组），再显式授予三个主体。
   * 用 spawn 而非 exec，避免 shell 引号漂移；不等待结果 —— 这是尽力而为的收紧，
   * 不该让一次 CRUD 卡在子进程上。
   */
  try {
    const user = process.env['USERNAME'] ?? ''
    const args = [file, '/inheritance:r']
    if (user.length > 0) args.push('/grant:r', `${user}:F`)
    args.push('/grant:r', 'SYSTEM:F', '/grant:r', 'BUILTIN\\Administrators:F')
    const child = spawn('icacls', args, { stdio: 'ignore', windowsHide: true })
    child.on('error', () => {})
    child.unref()
    return { ok: true, via: 'icacls' }
  } catch {
    return { ok: false, via: 'none' }
  }
}

/**
 * 写分发 key。
 *
 * ⚠ 文件里是**明文 bearer token**（拿到即可消耗账号池额度），见文件头「权限」一节：
 * Node 的 `mode` 只在创建时生效且 Windows 上被忽略，故这里额外做一次
 * `hardenCredentialFile`。
 */
export function saveDistributionKeys(dataDir, keys) {
  const file = join(dataDir, 'distribution-keys.json')
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(file, JSON.stringify({ keys }, null, 1), { mode: 0o600 })
  hardenCredentialFile(file)
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

/** 面板/路由对外展示的形态：id 定位 CRUD，token 完全不下发（0.9.5 起不再有掩码）。 */
export function publicDistributionKey(key) {
  const remaining = quotaRemaining(key)
  return {
    id: key.id,
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
