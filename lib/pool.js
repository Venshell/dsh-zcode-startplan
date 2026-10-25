/**
 * 凭据库与账号池（多账号 + 手动顺序 + 账号×模型限流标记）。
 *
 * ## 与参考实现的差异
 *
 * 参考实现用 AES-256-GCM + DPAPI/钥匙串加密 `credentials.enc`。DSH 侧这里改为
 * **Node 内置 `node:sqlite`**（Node ≥22.5）里的一张表，并把文件权限压到 600：
 *
 * - 不引入原生依赖（koffi/DPAPI 绑定在纯 ESM 插件里不可移植）；
 * - 账号池天然是「结构化状态」，SQLite 的原子写比「整体重写 JSON」安全；
 * - 与 DSH 自己的 `.credentials.yaml` 互不干扰（各自独立文件）。
 *
 * ⚠ 不要把 DSH 的账号凭据贴进本文件所在的共享目录：它和 DSH 的凭据是**两套**，
 * 一个是 DeepSeek 平台账号，一个是 ZCode 平台账号。
 *
 * ## 两条不可违背的既有约定（来自参考实现的实测教训）
 *
 * 1. **手动顺序即优先级**：不按「限流重置最早」重排 —— 那会让用户把某账号拖到
 *    首位后，只要别的账号重置更早，选中的仍是后者（拖拽排序变成纯装饰）。
 * 2. **绝不跨账号写凭据**：刷新 = 读该账号自己的凭据写回自己。参考实现曾因
 *    「用 current() 的凭据覆盖每个账号」把两条账号记录变成同一个账号。
 */

import { existsSync, mkdirSync, chmodSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** 账号条目（非敏感部分）。 */
export const ACCOUNT_FIELDS = Object.freeze([
  'id',
  'nickname',
  'enabled',
  'user_id',
  'model_rate_limits',
  'added_at',
  'last_error',
])

/** 判断一份凭据对象是否可用（两个硬字段）。 */
export function isUsableCredential(value) {
  if (typeof value !== 'object' || value === null) return false
  return (
    typeof value.zcode_jwt === 'string' && value.zcode_jwt.length > 0 &&
    typeof value.device_mid === 'string' && value.device_mid.length > 0
  )
}

/**
 * SQLite 落盘实现（node:sqlite，Node ≥22.5）。
 *
 * ⚠ 目录建不出来（沙箱只读、权限不足、盘符不存在）时**回退到内存库**并明确告警：
 * 此时账号池是「本进程内有效、重启即失」的 —— 不让「写不了磁盘」把整个插件变成不可用，
 * 也不要静默吞掉（否则用户会以为账号保存成功了）。
 */
export class SqliteStore {
  #db
  #file
  /** 本次用的库是不是内存库（供状态工具报告）。 */
  inMemory = false

  constructor(file) {
    this.#file = file
    let existed = false
    try {
      mkdirSync(dirname(file), { recursive: true })
      existed = existsSync(file)
    } catch (error) {
      /** 目录不可写：先记下原因，下面改用内存库。 */
      this.mkdirError = error instanceof Error ? error : new Error(String(error))
    }
    // 动态 import 以便在旧运行时给出可读的降级，而不是模块加载即崩。
    return this.#init(file, existed)
  }

  async #init(file, existed) {
    let DatabaseSync
    try {
      ;({ DatabaseSync } = await import('node:sqlite'))
    } catch (error) {
      throw new Error(
        `node:sqlite 不可用（${error instanceof Error ? error.message : String(error)}）；` +
        '请使用 Node ≥22.5',
      )
    }

    const schema = `
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        nickname TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        user_id TEXT,
        model_rate_limits TEXT NOT NULL DEFAULT '{}',
        added_at INTEGER NOT NULL,
        last_error TEXT,
        credential TEXT NOT NULL
      );
    `

    if (this.mkdirError === undefined) {
      try {
        this.#db = new DatabaseSync(file)
        this.#db.exec(`PRAGMA journal_mode = WAL;`)
        this.#db.exec(schema)
      } catch (error) {
        /** 文件打不开（权限 / 被占用 / 只读盘）：降级到内存库。 */
        this.mkdirError = error instanceof Error ? error : new Error(String(error))
        try {
          this.#db?.close()
        } catch {
          // 没打开成功。
        }
        this.#db = undefined
      }
    }

    if (this.#db === undefined) {
      this.#db = new DatabaseSync(':memory:')
      this.#db.exec(schema)
      this.inMemory = true
    } else {
      try {
        if (!existed) chmodSync(file, 0o600)
      } catch {
        // Windows 上 chmod 语义有限；失败不阻塞。
      }
    }
    return this
  }

  /**
   * 读全部账号（按 added_at 升序 = 用户手动顺序）。
   * @param {{ withCredentials?: boolean }} [options]
   */
  list(options = {}) {
    if (this.#db === undefined) throw new Error('SqliteStore 尚未初始化')
    const rows = this.#db
      .prepare('SELECT id, nickname, enabled, user_id, model_rate_limits, added_at, last_error, credential FROM accounts ORDER BY added_at ASC, rowid ASC')
      .all()
    return rows.map((row) => {
      const entry = {
        id: row.id,
        nickname: row.nickname,
        enabled: row.enabled === 1,
        user_id: row.user_id ?? undefined,
        model_rate_limits: safeJson(row.model_rate_limits, {}),
        added_at: row.added_at,
        last_error: row.last_error ?? undefined,
      }
      if (options.withCredentials === true) entry.credential = safeJson(row.credential, undefined)
      return entry
    })
  }

  /** 按 id 取一条（含凭据）。 */
  get(id) {
    if (this.#db === undefined) throw new Error('SqliteStore 尚未初始化')
    const row = this.#db
      .prepare('SELECT id, nickname, enabled, user_id, model_rate_limits, added_at, last_error, credential FROM accounts WHERE id = ?')
      .get(id)
    if (row === undefined) return undefined
    return {
      id: row.id,
      nickname: row.nickname,
      enabled: row.enabled === 1,
      user_id: row.user_id ?? undefined,
      model_rate_limits: safeJson(row.model_rate_limits, {}),
      added_at: row.added_at,
      last_error: row.last_error ?? undefined,
      credential: safeJson(row.credential, undefined),
    }
  }

  /**
   * 按 user_id 找已有账号（去重判据是服务端下发的稳定 user_id）。
   */
  findByUserId(userId) {
    if (this.#db === undefined) throw new Error('SqliteStore 尚未初始化')
    const row = this.#db.prepare('SELECT id FROM accounts WHERE user_id = ?').get(userId)
    return row?.id
  }

  /** 插入或更新（必须带凭据）。 */
  upsert(entry) {
    if (this.#db === undefined) throw new Error('SqliteStore 尚未初始化')
    if (!isUsableCredential(entry.credential)) {
      throw new Error('凭据形状不合法：必须同时有非空的 zcode_jwt 与 device_mid')
    }
    this.#db.prepare(`
      INSERT INTO accounts (id, nickname, enabled, user_id, model_rate_limits, added_at, last_error, credential)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        nickname = excluded.nickname,
        enabled = excluded.enabled,
        user_id = excluded.user_id,
        model_rate_limits = excluded.model_rate_limits,
        added_at = excluded.added_at,
        last_error = excluded.last_error,
        credential = excluded.credential
    `).run(
      entry.id,
      entry.nickname,
      entry.enabled ? 1 : 0,
      entry.user_id ?? null,
      JSON.stringify(entry.model_rate_limits ?? {}),
      entry.added_at,
      entry.last_error ?? null,
      JSON.stringify(entry.credential),
    )
    return entry.id
  }

  /** 只更新凭据（**绝不跨账号**：调用方必须传该账号自己的 id）。 */
  updateCredential(id, credential) {
    if (!isUsableCredential(credential)) throw new Error('凭据形状不合法')
    if (this.#db === undefined) throw new Error('SqliteStore 尚未初始化')
    this.#db.prepare('UPDATE accounts SET credential = ? WHERE id = ?').run(JSON.stringify(credential), id)
  }

  /** 部分字段更新。 */
  patch(id, patch) {
    if (this.#db === undefined) throw new Error('SqliteStore 尚未初始化')
    const current = this.get(id)
    if (current === undefined) return false
    this.upsert({
      ...current,
      ...patch,
      id: current.id,
      credential: patch.credential ?? current.credential,
    })
    return true
  }

  /** 删除账号。返回是否真的删掉了。 */
  remove(id) {
    if (this.#db === undefined) throw new Error('SqliteStore 尚未初始化')
    const result = this.#db.prepare('DELETE FROM accounts WHERE id = ?').run(id)
    return Number(result.changes) > 0
  }

  /** 关闭数据库。 */
  close() {
    try {
      this.#db?.close()
    } catch {
      // 已关闭。
    }
    this.#db = undefined
  }
}

function safeJson(text, fallback) {
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

/**
 * 账号池：选号 / 换号 / 限流标记 / CRUD。
 *
 * 选号规则：`enabled=true` 且「该模型不在限流期」→ 按**手动顺序**取第一个；
 * `exclude` 允许调用方在请求内逐个换号（否则换号形同虚设）。
 */
export class AccountPool {
  #store
  #log
  #now

  constructor(options) {
    this.#store = options.store
    this.#log = options.log ?? (() => {})
    this.#now = options.now ?? (() => Date.now())
  }

  /** 账号列表（默认脱敏，不含凭据）。 */
  list(options = {}) {
    return this.#store.list(options)
  }

  /**
   * 按 id 取单个账号。`store.get` 总是带凭据，这里按 `withCredentials` 决定
   * 是否外发（与 `list` 的脱敏约定一致）。
   */
  get(id, options = {}) {
    const entry = this.#store.get(id)
    if (entry === undefined) return undefined
    if (options.withCredentials !== true) delete entry.credential
    return entry
  }

  /** 启用中的账号数。 */
  enabledCount() {
    return this.list().filter((entry) => entry.enabled).length
  }

  /**
   * 添加账号（按 user_id 去重：已存在则只更新凭据与昵称）。
   * @param {any} credential
   * @param {string} [nickname]
   * @returns {{ entry: any, created: boolean }}
   */
  add(credential, nickname) {
    if (!isUsableCredential(credential)) throw new Error('凭据形状不合法：需要 zcode_jwt 与 device_mid')
    const label = (nickname ?? '').trim() || (credential.account_label ?? '').trim() || '未命名账号'
    const userId = typeof credential.user_id === 'string' ? credential.user_id.trim() : ''
    if (userId.length > 0) {
      const existingId = this.#store.findByUserId(userId)
      if (existingId !== undefined) {
        this.#store.updateCredential(existingId, credential)
        this.#store.patch(existingId, { nickname: label })
        this.#log(`[pool] 账号已存在（user_id=${userId}），已更新凭据：${label}`)
        return { entry: this.#store.get(existingId), created: false }
      }
    }
    const id = randomUUID()
    const entry = {
      id,
      nickname: label,
      enabled: true,
      user_id: userId.length > 0 ? userId : undefined,
      model_rate_limits: {},
      added_at: this.#now(),
      credential,
    }
    this.#store.upsert(entry)
    this.#log(`[pool] 已添加账号：${label}（${id}）`)
    return { entry: this.#store.get(id), created: true }
  }

  /** 按序号 / id 前缀 / 昵称尾号找账号（CLI 与工具共用）。 */
  resolve(reference) {
    const needle = String(reference ?? '').trim()
    if (needle.length === 0) return undefined
    const entries = this.list()
    const byIndex = Number(needle)
    if (Number.isInteger(byIndex) && byIndex >= 1 && byIndex <= entries.length) return entries[byIndex - 1]
    const exact = entries.find((entry) => entry.id === needle)
    if (exact !== undefined) return exact
    const prefixed = entries.find((entry) => entry.id.startsWith(needle))
    if (prefixed !== undefined) return prefixed
    const byName = entries.find((entry) => entry.nickname.includes(needle))
    return byName
  }

  /** 启用 / 停用。 */
  setEnabled(id, enabled) {
    if (!this.#store.patch(id, { enabled })) throw new Error(`账号不存在：${id}`)
  }

  /**
   * 部分更新账号的**非敏感**字段（管理面板改备注走这里）。
   * ⚠ 只白名单放行 `nickname`：凭据不允许从这条路改（改凭据必须走
   * `updateCredential`，且只许用该账号自己的 id —— 见文件头第 2 条约定）。
   */
  patchAccount(id, patch) {
    const nickname = typeof patch?.nickname === 'string' ? patch.nickname.trim() : ''
    if (nickname.length === 0) return false
    return this.#store.patch(id, { nickname })
  }

  /** 删除。 */
  remove(id) {
    return this.#store.remove(id)
  }

  /** 重排（必须同一集合的一个排列，否则报错而不是尽力而为）。 */
  reorder(orderedIds) {
    const entries = this.list()
    const expected = new Set(entries.map((entry) => entry.id))
    const sameSet =
      orderedIds.length === entries.length &&
      new Set(orderedIds).size === orderedIds.length &&
      orderedIds.every((id) => expected.has(id))
    if (!sameSet) {
      throw new Error(`账号列表已变化，请刷新后重试（期望 ${entries.length} 个账号，收到 ${orderedIds.length} 个）`)
    }
    const byId = new Map(entries.map((entry) => [entry.id, entry]))
    const base = this.#now()
    orderedIds.forEach((id, index) => {
      const entry = byId.get(id)
      this.#store.patch(id, { added_at: base + index })
    })
  }

  /**
   * 取下一个可用账号。
   *
   * @param {string} modelId 目标模型（空串表示不按限流过滤）
   * @param {Set<string> | readonly string[]} [exclude] 本次请求已尝试过的账号 id
   * @returns {{ entry: any, credential: any } | null}
   */
  pick(modelId, exclude) {
    const excluded = exclude instanceof Set ? exclude : new Set(exclude ?? [])
    const now = this.#now()
    const candidates = this.list({ withCredentials: true }).filter((entry) => {
      if (!entry.enabled) return false
      if (excluded.has(entry.id)) return false
      if (typeof modelId !== 'string' || modelId.length === 0) return true
      const resetAt = entry.model_rate_limits?.[modelId]
      return resetAt === undefined || resetAt === 0 || now >= resetAt
    })
    for (const entry of candidates) {
      if (isUsableCredential(entry.credential)) return { entry, credential: entry.credential }
      this.#log(`[pool] 账号 ${entry.id} 凭据不可用，已跳过`)
    }
    return null
  }

  /** 标记「账号 × 模型」在 resetAt 之前不可用。 */
  markModelRateLimited(accountId, modelId, resetAtMs) {
    const entry = this.#store.get(accountId)
    if (entry === undefined) {
      this.#log(`[pool] markModelRateLimited: 账号 ${accountId} 不在池中，已忽略`)
      return
    }
    const limits = { ...(entry.model_rate_limits ?? {}), [modelId]: resetAtMs }
    this.#store.patch(accountId, { model_rate_limits: limits })
    this.#log(`[pool] 已标记限流：${entry.nickname} × ${modelId} → ${new Date(resetAtMs).toISOString()}`)
  }

  /** 清除某账号的限流标记（默认全清）。 */
  clearModelRateLimits(accountId, modelIds) {
    const entry = this.#store.get(accountId)
    if (entry === undefined) return 0
    const limits = { ...(entry.model_rate_limits ?? {}) }
    let removed = 0
    for (const modelId of modelIds ?? Object.keys(limits)) {
      if (Object.prototype.hasOwnProperty.call(limits, modelId)) {
        delete limits[modelId]
        removed += 1
      }
    }
    if (removed > 0) this.#store.patch(accountId, { model_rate_limits: limits })
    return removed
  }

  /** 清理已过期的标记。 */
  sweepExpired() {
    for (const entry of this.list()) {
      const limits = { ...(entry.model_rate_limits ?? {}) }
      let changed = false
      for (const [modelId, resetAt] of Object.entries(limits)) {
        if (resetAt > 0 && this.#now() >= resetAt) {
          delete limits[modelId]
          changed = true
        }
      }
      if (changed) this.#store.patch(entry.id, { model_rate_limits: limits })
    }
  }

  /** 记下某个账号最近一次失败原因（面板/状态工具展示用）。 */
  noteError(accountId, message) {
    this.#store.patch(accountId, { last_error: message })
  }
}

/** 默认数据目录：`~/.dsh/zcode-start-plan`（可用环境变量覆盖）。 */
export function resolveDataDir(env = process.env) {
  const fromEnv = env['ZCODE_START_PLAN_DATA_DIR']
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim()
  const home = env['USERPROFILE'] ?? env['HOME'] ?? '.'
  return join(home, '.dsh', 'zcode-start-plan')
}

/**
 * 账号库文件路径。
 *
 * `dataDir` 显式传入时以它为准（Config 的 `dataDir` 走这条路）——
 * 否则插件在测试/多实例场景下会悄悄读写**用户的真实账号库**。
 */
export function resolveDbFile(env = process.env, dataDir) {
  if (typeof dataDir === 'string' && dataDir.trim().length > 0) {
    return join(dataDir.trim(), 'accounts.db')
  }
  return join(resolveDataDir(env), 'accounts.db')
}
