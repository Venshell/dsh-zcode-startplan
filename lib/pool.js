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
import { MODEL_BUSY_TTL_MS, isZcodeQuotaExhausted } from './errors.js'

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
 * 选号规则（两档）：
 * 1. `enabled=true` 且「该模型不在限流期」且**不忙** → 按**手动顺序**取第一个；
 * 2. 全都不忙的没有时，回落到「忙」（3009 短窗标记）的账号 —— 忙是软状态，
 *    排队等它好过空手报错；
 * `exclude` 允许调用方在请求内逐个换号（否则换号形同虚设）。
 */
export class AccountPool {
  #store
  #log
  #now
  /** 进程内忙标记：`"${accountId}|${modelId}"` → busyUntil（不落库，见 markModelBusy）。 */
  #busy = new Map()
  /**
   * 进程内「零内容观察窗」：`"${accountId}|${modelId}"` → until（1.0.1，不落库）。
   *
   * ⚠ 与 `markModelRateLimited`（当日硬过滤）不同级：这里只是**软优先**——
   * 选号先避开观察中的账号，但所有账号都在观察时仍照常选（避免唯一账号
   * 被一次抖动锁死整条链路）。`plan-client` 借它实现零内容两级证据：
   * 窗口内再吃一次零内容才升级当日硬标记。
   */
  #emptyContentWatch = new Map()
  /**
   * 进程内到期缓存：accountId → 最早的有余额桶到期时间（毫秒）。
   * 由 manage-routes 的 /balance 拉取成功时回填（noteExpiry），pick 按「快过期先用」
   * 排序消费。不落库：余额是上游现拉的数据，落库只会引入过期快照。
   */
  #expiry = new Map()
  /** 选号顺序：'expiry'（默认，快过期先用）| 'manual'（手动置顶优先）。 */
  #selectionOrder = 'expiry'
  /**
   * **最近一次真实派发**的账号（1.0.0）：`{ accountId, nickname, modelId, at }`。
   *
   * 统一选号意味着「选中的模型栏位」≠「真正吃额度的账号」—— 每次请求都可能换号。
   * 模型栏旁的「当前使用账号」必须显示**这个**，而不是配置里的钉定账号。
   * 由 plan-client 在选出账号后、发请求前回填；进程内状态，不落库。
   */
  #lastRouted

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
   * 取下一个可用账号（两档）。
   *
   * 第一档：启用 + 未被 `exclude` + 该模型不在限流期 + **不忙**（3009 短窗标记）
   * → 按手动顺序取第一个 —— 「另一个账号空闲时，请求路由到空闲账号」就靠这一档。
   * 第二档：第一档为空时，放宽忙标记（限流标记仍硬过滤），回落到忙账号排队。
   *
   * @param {string} modelId 目标模型（空串表示不按限流/忙过滤）
   * @param {Set<string> | readonly string[]} [exclude] 本次请求已尝试过的账号 id
   * @param {{ exhausted?: Set<string> }} [sink] 见 `candidates`
   * @returns {{ entry: any, credential: any } | null}
   */
  pick(modelId, exclude, sink) {
    for (const entry of this.candidates(modelId, exclude, sink)) {
      if (isUsableCredential(entry.credential)) return { entry, credential: entry.credential }
      this.#log(`[pool] 账号 ${entry.id} 凭据不可用，已跳过`)
    }
    return null
  }

  /**
   * 选号顺序策略：'expiry'（默认，快过期先用）| 'manual'（手动置顶优先）。
   * 由 Config 下发（config.selectionOrder）；两种策略下「使用」按钮语义见
   * client.js —— expiry 模式下置顶不再决定取号顺序。
   */
  setSelectionOrder(order) {
    this.#selectionOrder = order === 'manual' ? 'manual' : 'expiry'
  }

  get selectionOrder() {
    return this.#selectionOrder
  }

  /**
   * 回填账号的「最早有余额桶到期时间」（/balance 拉取成功时调用）。
   * expiresAtMs <= 0（全用光/未知）= 移除缓存条目（按无穷大排序）。
   */
  noteExpiry(accountId, expiresAtMs) {
    if (Number.isFinite(expiresAtMs) && expiresAtMs > 0) {
      this.#expiry.set(accountId, expiresAtMs)
    } else {
      this.#expiry.delete(accountId)
    }
  }

  /** 某账号当前的到期缓存值（观测用；无缓存 = undefined）。 */
  expiryOf(accountId) {
    return this.#expiry.get(accountId)
  }

  /**
   * 记一次**真实派发**（统一选号每请求都会调；钉定栏位同样回填 ——
   * 「当前使用账号」对两种栏位都成立，只是文案不同）。
   *
   * ⚠ 审计修复（1.0.1）：`outcome` 必须由调用方在**每次尝试真正发出去之前**
   * 提供 —— 此前只在进入账号轮次时记一次，若该账号随后被上游判额度用尽、
   * 换号成功，徽标会一直显示那个**没在服务**的账号（正是最需要看准的时刻）。
   * 约定：
   * - `'outcome'` 缺省 = 派发前占位（`attempting`）；
   * - 命中即 `'ok'`；被判额度用尽 `'exhausted'`；其它失败仍为 `'attempting'`。
   *
   * @param {string} accountId 实际吃这次请求额度的账号
   * @param {string} [modelId] 实际发出的模型 id（基础模型，不含 @acct: 后缀）
   * @param {{ outcome?: 'attempting' | 'ok' | 'exhausted', reason?: string }} [detail]
   * @returns {{ accountId: string, nickname: string, modelId: string, at: number, outcome: string } | undefined}
   */
  noteRouted(accountId, modelId, detail = {}) {
    if (typeof accountId !== 'string' || accountId.length === 0) return this.#lastRouted
    const entry = this.#store.get(accountId)
    this.#lastRouted = {
      accountId,
      nickname: typeof entry?.nickname === 'string' ? entry.nickname : accountId.slice(0, 8),
      modelId: typeof modelId === 'string' ? modelId : '',
      at: this.#now(),
      outcome: detail.outcome ?? 'attempting',
      ...(typeof detail.reason === 'string' && detail.reason.length > 0 ? { reason: detail.reason } : {}),
    }
    return this.#lastRouted
  }

  /** 最近一次真实派发（观测用；启动后尚未发过请求时为 undefined）。 */
  lastRouted() {
    return this.#lastRouted
  }

  /**
   * 候选账号（**`pick` 与 `previewOrder` 的唯一来源**）。
   *
   * 审计结论（1.0.1）：预览曾经只按排序截取列表，不复刻 `pick` 的筛选 ——
   * 于是「本模型限流中 / 凭据不可用 / 忙」的账号会被预览成「下一条会用它」，
   * 而真实派发会跳过它，徽标在第一次请求前必说谎。这里把筛选收敛到一处，
   * 两个消费者共用，**不允许**再各写一套。
   *
   * 两档语义与 `pick` 一一对应：
   * - 第一档：启用 + 未 exclude + 该模型未限流 + **不忙**；
   * - 第二档：仅当第一档为空时放宽忙标记（限流标记仍硬过滤）。
   *
   * @param {string} modelId 空串表示不按限流/忙过滤（与 `pick` 一致）
   * @param {Set<string> | readonly string[]} [exclude]
   * @param {{ exhausted?: Set<string> }} [sink] 收「因额度用尽被滤掉」的账号 id
   * @returns {Array<any>} 已按选号顺序排好的候选
   */
  candidates(modelId, exclude, sink) {
    const excluded = exclude instanceof Set ? exclude : new Set(exclude ?? [])
    const now = this.#now()
    const exhausted = new Set()
    const byModel = (entry) => {
      if (!entry.enabled) return false
      if (excluded.has(entry.id)) return false
      if (typeof modelId !== 'string' || modelId.length === 0) return true
      const resetAt = entry.model_rate_limits?.[modelId]
      if (resetAt !== undefined && resetAt !== 0 && now < resetAt) return false
      /**
       * 兜底：该账号的 `last_error` 已经是额度用尽（1005/1113）。
       *
       * 标记表只记「账号×模型」，模型 id 一旦对不上（别名 / 大小写 / 上游改目录）
       * 就会漏过滤，于是下一次请求照样发出 → 上游黑洞（issue #4）。
       * 这里把它记进 `exhausted` —— **返回值不变**（仍是候选数组），
       * 只是想报「为什么一个候选都没有」的调用方（plan-client）能拿到真因。
       */
      if (this.hasQuotaError(entry.id)) {
        exhausted.add(entry.id)
        return false
      }
      return true
    }
    const withCredentials = this.list({ withCredentials: true })
    /**
     * 排序（0.7.0，默认策略 = expiry）：**快过期的先用**。
     * 每个账号的额度桶到期时间不同 —— 先吃快过期账号的额度，能减少
     * 「到期作废」的浪费；没有到期数据的账号（还没拉过余额）按无穷大排后，
     * 但仍参与选号（不因缺数据被跳过）。手动排序（/use 置顶）在 expiry 模式
     * 下不再决定取号顺序 —— 两种策略互斥，见 selectionOrder。
     */
    const order = this.#selectionOrder === 'expiry' ? 'expiry' : 'manual'
    const byOrder = (a, b) => {
      if (order === 'expiry') {
        const ea = this.#expiry.get(a.id) ?? Number.POSITIVE_INFINITY
        const eb = this.#expiry.get(b.id) ?? Number.POSITIVE_INFINITY
        if (ea !== eb) return ea - eb
      }
      return a.added_at - b.added_at
    }
    const tier = (entries) => [...entries].sort(byOrder)
    /** 第一档：避开忙账号与零内容观察中的账号（两者都是软优先）。 */
    const candidates = tier(
      withCredentials.filter(
        (entry) => byModel(entry) && !this.isModelBusy(entry.id, modelId) && !this.isEmptyContentWatched(entry.id, modelId),
      ),
    )
    /** 第二档：全部忙/观察中时放宽（限流标记仍硬过滤），排队等待。 */
    if (candidates.length === 0 && typeof modelId === 'string' && modelId.length > 0) {
      candidates.push(...tier(withCredentials.filter((entry) => byModel(entry))))
    }
    if (sink !== undefined && sink.exhausted instanceof Set) {
      for (const id of exhausted) sink.exhausted.add(id)
    }
    return candidates
  }

  /**
   * 下一次取号的候选顺序（**只读预览**，与 `pick` 同一套筛选与排序，不消耗状态）。
   *
   * 用途：模型栏旁的「当前使用账号」在**还没派发过**时，显示「下一条会用谁」——
   * 比显示「未知」有用得多。`pick` 有 modelId 时才有完整语义，所以调用方
   * **必须**带上当前选中的模型；缺省空串只表示「不按模型过滤」，不是等价物。
   *
   * `expiresAt` 语义：`null` = 该账号**没有**有效的到期数据（`pick` 按无穷大排序，
   * 与「未知」无关），`number` = `pick` 实际用于排序的毫秒时间戳。
   *
   * @param {string} [modelId] 当前选中的基础模型 id
   * @param {number} [limit] 最多返回几个
   * @returns {Array<{ accountId: string, nickname: string, expiresAt: number | null }>}
   */
  previewOrder(modelId = '', limit = 3) {
    /** `candidates` 已按选号顺序排好；凭据不可用者与 `pick` 一样跳过。 */
    const sorted = this.candidates(typeof modelId === 'string' ? modelId : '', undefined)
      .filter((entry) => isUsableCredential(entry.credential))
      .slice(0, Math.max(0, limit))
    return sorted.map((entry) => {
      const expiresAt = this.#expiry.get(entry.id)
      return {
        accountId: entry.id,
        nickname: entry.nickname,
        expiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
      }
    })
  }

  /** 标记「账号 × 模型」在 resetAt 之前不可用（**额度用尽**级：硬过滤）。 */
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

  /**
   * 标记「账号 × 模型」忙（**3009 并发限流**级：软优先级，硬过滤的是额度标记）。
   *
   * 进程内存放，**刻意不落库**：忙是秒级瞬态，写库只会让重启后的残留标记
   * 平白多绕开账号一分钟；额度用尽那种要跨重启的状态才值得落盘。
   * resetAtMs 缺省 = now + MODEL_BUSY_TTL_MS。
   */
  markModelBusy(accountId, modelId, resetAtMs) {
    const now = this.#now()
    const until = typeof resetAtMs === 'number' && resetAtMs > now ? resetAtMs : now + MODEL_BUSY_TTL_MS
    const previous = this.#busy.get(`${accountId}|${modelId}`) ?? 0
    if (until <= previous) return
    this.#busy.set(`${accountId}|${modelId}`, until)
    this.#log(`[pool] 已标记忙（3009）：${accountId} × ${modelId}，${Math.ceil((until - now) / 1000)}s 内优先绕开`)
  }

  /**
   * 「账号 × 模型」的**启用侧额度视图**（`/routing` 与徽标用）。
   *
   * ⚠ 审计根因（1.0.1）：面板的「额度开启」来自 `/balance`，它统计的是上游
   * `data.balances` 里**所有已激活 plan 的桶**；而对话准入看的是**当前生效**的
   * 那一桶 —— 上游 `balances` 可以列出余额为 0 的桶（尚未生效的 entitlement、
   * 已过期的旧桶），于是出现「面板显示有额度、对话立刻 1005/零内容」。
   *
   * 这里不改上游数据，只把「准入判定依据」显式化，**三个口径各说各的**：
   * - `available`：面板口径（上游余额接口的生效桶还有没有余额），
   *   **原样透传**：`true`/`false`/`null`（未知），绝不被准入否决洗掉 ——
   *   否则「面板有额度但被拒」这个冲突组合无法在 UI 上呈现；
   * - `limited`：被 1005 之类的当日标记硬过滤；
   * - `expired`：当前时间已过 `expiresAt`（缓存值，可能滞后一个 TTL）；
   * - `usable`：综合结论 = `available === true` 且无否决位；未知保持 `null`。
   *
   * @param {object} quota 面板口径缓存 `{ available: boolean | null, expiresAt: number | null }`
   * @returns {{ available: boolean | null, limited: boolean, expired: boolean, usable: boolean | null, reason: string | null }}
   */
  quotaState(accountId, modelId, quota) {
    const now = this.#now()
    const resetAt = this.get(accountId)?.model_rate_limits?.[modelId]
    const limited = typeof resetAt === 'number' && resetAt > 0 && now < resetAt
    const expiresAt = quota?.expiresAt
    const expired = Number.isFinite(expiresAt) && expiresAt > 0 && now >= expiresAt
    /** 面板口径原样透传；「未知」是独立语义，不许洗成 true 或 false。 */
    const available = typeof quota?.available === 'boolean' ? quota.available : null
    const vetoed = limited || expired
    const usable = vetoed ? false : available
    let reason = null
    if (limited) reason = '上游已判额度用尽（1005/1113）——等待重置或换号'
    else if (expired) reason = '额度桶已过期（缓存值，可能滞后）'
    return { available, limited, expired, usable, reason }
  }

  /** 「账号 × 模型」当前是否忙（标记不存在或已过期 = 不忙）。 */
  isModelBusy(accountId, modelId) {
    const until = this.#busy.get(`${accountId}|${modelId}`) ?? 0
    return this.#now() < until
  }

  /** 清除某账号的忙标记（modelId 缺省清该账号全部）。 */
  clearModelBusy(accountId, modelId) {
    if (typeof modelId === 'string' && modelId.length > 0) {
      this.#busy.delete(`${accountId}|${modelId}`)
      return
    }
    for (const key of this.#busy.keys()) {
      if (key.startsWith(`${accountId}|`)) this.#busy.delete(key)
    }
  }

  /** 当前处于忙标记中的「账号 × 模型」数（状态工具观测用）。 */
  busyCount() {
    const now = this.#now()
    let count = 0
    for (const until of this.#busy.values()) {
      if (now < until) count += 1
    }
    return count
  }

  /**
   * 零内容观察窗（1.0.1，软优先）：标记「该账号×模型刚吃过一次零内容」，
   * pick 第一档先避开它；全部账号都在观察时仍照常选（避免唯一账号被
   * 一次抖动锁死）。until 缺省 = now + windowMs。
   *
   * ⚠ 刻意**不进** `model_rate_limits`：那张表是当日级硬过滤（落库），
   * 短窗放进去会让唯一账号被选不到 → 两级证据永远走不到第二次。
   */
  noteEmptyContentWatch(accountId, modelId, untilMs) {
    if (typeof accountId !== 'string' || accountId.length === 0) return
    const now = this.#now()
    const until = typeof untilMs === 'number' && untilMs > now ? untilMs : now + MODEL_BUSY_TTL_MS
    const previous = this.#emptyContentWatch.get(`${accountId}|${modelId}`) ?? 0
    if (until <= previous) return
    this.#emptyContentWatch.set(`${accountId}|${modelId}`, until)
  }

  /** 该账号×模型是否在零内容观察窗内（pick 第一档避开用；也是两级证据的第二级判据）。 */
  isEmptyContentWatched(accountId, modelId) {
    const until = this.#emptyContentWatch.get(`${accountId}|${modelId}`) ?? 0
    return this.#now() < until
  }

  /** 清除某账号的零内容观察窗（modelId 缺省清该账号全部；命中产出时调用）。 */
  clearEmptyContentWatch(accountId, modelId) {
    if (typeof modelId === 'string' && modelId.length > 0) {
      this.#emptyContentWatch.delete(`${accountId}|${modelId}`)
      return
    }
    for (const key of this.#emptyContentWatch.keys()) {
      if (key.startsWith(`${accountId}|`)) this.#emptyContentWatch.delete(key)
    }
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

  /**
   * 该账号的 `last_error` 是否已经写着**额度用尽**（1005 / 1113 / 裸文案）。
   *
   * ⚠ issue #4 的选号前置判据：额度用尽是**确定性**状态（等账期重置才恢复），
   * 可 `model_rate_limits` 只记「账号×模型」，一旦上游没把模型归对、或标记
   * 恰好覆盖不到当前模型，下一次请求就照样发出去 → 上游黑洞 → 300s × 宿主重试
   * → 用户只看到「超时或不可用」。而 `last_error` 里其实早就写着 1005。
   *
   * 这里只做**纯函数式**判定（不读时钟、不写状态）：是否放行由调用方按
   * `now < model_rate_limits[model]` 这类硬标记优先、本判据兜底的顺序决定。
   *
   * @param {string} accountId
   * @returns {boolean}
   */
  hasQuotaError(accountId) {
    const message = this.get(accountId)?.last_error
    if (typeof message !== 'string' || message.length === 0) return false
    /** 复用 errors.js 的结构化判据（3009 并发限流不算额度用尽）。 */
    return isZcodeQuotaExhausted(message)
  }

  /**
   * 选号时的额度快速失败判据：**硬标记优先，`last_error` 兜底**。
   *
   * 硬标记（`model_rate_limits[model]` 未到期）= 上游已为这个模型判过耗尽；
   * `last_error` 写着 1005/1113 = 上游为**某个**模型判过耗尽（多半就是当前这个）。
   * 只要任一成立，就**不该再发请求** —— 秒级报 QUOTA，让宿主/用户立刻改道，
   * 而不是黑洞挂满两次 300 秒（issue #4 实测）。
   *
   * @param {string} accountId
   * @param {string} [modelId]
   * @returns {{ limited: boolean, resetAt: number | null, reason: 'model' | 'last-error' | null }}
   */
  quotaBlock(accountId, modelId) {
    const now = this.#now()
    const resetAt = typeof modelId === 'string' && modelId.length > 0
      ? this.get(accountId)?.model_rate_limits?.[modelId]
      : undefined
    if (typeof resetAt === 'number' && resetAt > 0 && now < resetAt) {
      return { limited: true, resetAt, reason: 'model' }
    }
    if (this.hasQuotaError(accountId)) return { limited: true, resetAt: null, reason: 'last-error' }
    return { limited: false, resetAt: null, reason: null }
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
