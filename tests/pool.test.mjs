import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AccountPool, SqliteStore, isUsableCredential } from '../lib/pool.js'

const credential = (id) => ({ zcode_jwt: `jwt-${id}`, device_mid: `dev-${id}`, user_id: `u-${id}` })

function withPool(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zsp-pool-'))
    try {
      const store = await new SqliteStore(join(dir, 'accounts.db'))
      const pool = new AccountPool({ store })
      await fn(pool, store)
      store.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

test('add 以 user_id 去重：同账号再登录只更新凭据', withPool(async (pool, store) => {
  const first = pool.add(credential('a'), '账号A')
  assert.equal(first.created, true)
  const second = pool.add({ ...credential('a'), zcode_jwt: 'jwt-renewed' }, '账号A-改名')
  assert.equal(second.created, false)
  assert.equal(pool.list().length, 1)
  const stored = store.get(first.entry.id)
  assert.equal(stored.credential.zcode_jwt, 'jwt-renewed')
  assert.equal(stored.nickname, '账号A-改名')
}))

test('pick 遵守手动顺序，并跳过 exclude 中的账号', withPool(async (pool) => {
  pool.setSelectionOrder('manual')
  pool.add(credential('a'), 'A')
  pool.add(credential('b'), 'B')
  const first = pool.pick('GLM-5.3-Flash')
  assert.equal(first.entry.nickname, 'A')
  const second = pool.pick('GLM-5.3-Flash', new Set([first.entry.id]))
  assert.equal(second.entry.nickname, 'B')
  assert.equal(pool.pick('GLM-5.3-Flash', new Set([first.entry.id, second.entry.id])), null)
}))

test('默认 expiry 选号：快过期的先用，无到期数据的排后但不被跳过', withPool(async (pool) => {
  assert.equal(pool.selectionOrder, 'expiry', '0.7.0 起默认 expiry')
  const a = pool.add(credential('a'), 'A').entry
  const b = pool.add(credential('b'), 'B').entry
  const c = pool.add(credential('c'), 'C').entry

  /** A 还没拉过余额（无缓存）；B 7 天后到期；C 1 小时后到期 → C 最优先。 */
  pool.noteExpiry(b.id, Date.now() + 7 * 86_400_000)
  pool.noteExpiry(c.id, Date.now() + 3_600_000)
  assert.equal(pool.pick('GLM-5.3-Flash').entry.nickname, 'C', '快过期先用')
  assert.equal(pool.pick('GLM-5.3-Flash', new Set([c.id])).entry.nickname, 'B')
  assert.equal(pool.pick('GLM-5.3-Flash', new Set([c.id, b.id])).entry.nickname, 'A', '无到期数据仍参与（排最后）')

  /** 全部用光（noteExpiry 0）= 回到手动顺序兜底。 */
  pool.noteExpiry(c.id, 0)
  pool.noteExpiry(b.id, 0)
  assert.equal(pool.pick('GLM-5.3-Flash').entry.nickname, 'A')
  /** noteExpiry 负数/NaN 同样按「无数据」处理。 */
  pool.noteExpiry(a.id, -5)
  assert.equal(pool.expiryOf(a.id), undefined)
}))

test('expiry 模式下 /use 置顶不再决定取号顺序（两种策略互斥）', withPool(async (pool) => {
  const a = pool.add(credential('a'), 'A').entry
  const b = pool.add(credential('b'), 'B').entry
  pool.noteExpiry(b.id, Date.now() + 3_600_000)
  /** 置顶 A（模拟 /use：改 added_at 顺序）—— expiry 模式下 B 仍因快过期而优先。 */
  pool.reorder([a.id, b.id])
  assert.equal(pool.pick('GLM-5.3-Flash').entry.nickname, 'B', '快过期优先于置顶')
  /** 切回 manual：置顶立即生效。 */
  pool.setSelectionOrder('manual')
  assert.equal(pool.pick('GLM-5.3-Flash').entry.nickname, 'A')
  /** 非法值回落 expiry（默认）。 */
  pool.setSelectionOrder('bogus')
  assert.equal(pool.selectionOrder, 'expiry')
}))

test('markModelRateLimited 只影响那一对「账号×模型」，且到期后恢复', withPool(async (pool, store) => {
  const { entry } = pool.add(credential('a'), 'A')
  const now = Date.now()
  pool.markModelRateLimited(entry.id, 'GLM-5.3-Flash', now + 60_000)
  assert.equal(pool.pick('GLM-5.3-Flash'), null)
  assert.notEqual(pool.pick('GLM-5.3'), null, '另一个模型不受影响')

  /** 模拟时间流逝：把标记改成已过期再 sweep。 */
  store.patch(entry.id, { model_rate_limits: { 'GLM-5.3-Flash': now - 1 } })
  pool.sweepExpired()
  assert.notEqual(pool.pick('GLM-5.3-Flash'), null)
}))

test('忙标记：pick 优先绕开忙账号；全部忙时回落排队', withPool(async (pool) => {
  const a = pool.add(credential('a'), 'A').entry
  const b = pool.add(credential('b'), 'B').entry

  /** A 忙 → 统一选号直接路由到空闲的 B（修复的核心行为）。 */
  pool.markModelBusy(a.id, 'GLM-5.3-Flash')
  assert.equal(pool.pick('GLM-5.3-Flash').entry.id, b.id)
  assert.equal(pool.pick('GLM-5.3-Flash').entry.id, b.id, '后续请求同样绕开 A')

  /** B 也忙 → 回落到忙账号（软状态，排队好过报错）。 */
  pool.markModelBusy(b.id, 'GLM-5.3-Flash')
  assert.equal(pool.pick('GLM-5.3-Flash').entry.id, a.id)

  /** exclude 过的账号不会被第二档「捞回来」。 */
  const picked = pool.pick('GLM-5.3-Flash', new Set([a.id]))
  assert.equal(picked.entry.id, b.id)
  assert.equal(pool.pick('GLM-5.3-Flash', new Set([a.id, b.id])), null)

  /** 忙标记是「账号×模型」粒度：另一个模型不受影响。 */
  assert.equal(pool.pick('GLM-5.3').entry.id, a.id)
}))

test('忙标记：过期自动恢复、clearModelBusy 与 busyCount', withPool(async (pool) => {
  const a = pool.add(credential('a'), 'A').entry
  pool.add(credential('b'), 'B')
  pool.markModelBusy(a.id, 'GLM-5.3-Flash', Date.now() + 50)
  assert.equal(pool.isModelBusy(a.id, 'GLM-5.3-Flash'), true)
  assert.equal(pool.busyCount(), 1)

  /** 到期后恢复：不 busy 的账号重新排回第一优先。 */
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(pool.isModelBusy(a.id, 'GLM-5.3-Flash'), false)
  assert.equal(pool.busyCount(), 0)
  assert.equal(pool.pick('GLM-5.3-Flash').entry.id, a.id)

  /** clearModelBusy 单模型 / 全账号两种粒度。 */
  pool.markModelBusy(a.id, 'GLM-5.3-Flash')
  pool.markModelBusy(a.id, 'GLM-5.3')
  pool.clearModelBusy(a.id, 'GLM-5.3-Flash')
  assert.equal(pool.isModelBusy(a.id, 'GLM-5.3-Flash'), false)
  assert.equal(pool.isModelBusy(a.id, 'GLM-5.3'), true)
  pool.clearModelBusy(a.id)
  assert.equal(pool.isModelBusy(a.id, 'GLM-5.3'), false)
}))

test('忙标记不影响额度标记：限流中的账号不会被第二档捞回', withPool(async (pool) => {
  const a = pool.add(credential('a'), 'A').entry
  const b = pool.add(credential('b'), 'B').entry
  pool.markModelRateLimited(a.id, 'GLM-5.3-Flash', Date.now() + 60_000)
  pool.markModelBusy(b.id, 'GLM-5.3-Flash')
  assert.equal(pool.pick('GLM-5.3-Flash').entry.id, b.id, 'A 额度尽是硬过滤；B 忙但第二档可回落')
  pool.markModelBusy(a.id, 'GLM-5.3-Flash')
  assert.equal(pool.pick('GLM-5.3-Flash').entry.id, b.id, 'A 忙也不影响 —— 它本来就因限流被硬过滤')
  assert.equal(pool.pick('GLM-5.3-Flash', new Set([b.id])), null, 'B 被排除后无可选账号（A 限流硬过滤，绝不捞回）')
}))

test('停用的账号不参与选号；reorder 改变优先级', withPool(async (pool) => {
  const a = pool.add(credential('a'), 'A').entry
  pool.add(credential('b'), 'B')
  pool.setEnabled(a.id, false)
  assert.equal(pool.pick('GLM-5.3-Flash').entry.nickname, 'B')
  pool.setEnabled(a.id, true)

  const ids = pool.list().map((entry) => entry.id)
  pool.reorder([...ids].reverse())
  assert.equal(pool.pick('GLM-5.3-Flash').entry.nickname, 'B', '反转后 B 排到最前')
}))

test('reorder 拒绝不同集合（而不是尽力而为）', withPool(async (pool) => {
  pool.add(credential('a'), 'A')
  assert.throws(() => pool.reorder(['not-an-id']), /账号列表已变化/)
}))

test('resolve 支持序号 / id 前缀 / 昵称片段', withPool(async (pool) => {
  const a = pool.add(credential('a'), '尾号1234').entry
  assert.equal(pool.resolve('1').id, a.id)
  assert.equal(pool.resolve(a.id.slice(0, 8)).id, a.id)
  assert.equal(pool.resolve('1234').id, a.id)
  assert.equal(pool.resolve('nope'), undefined)
}))

test('isUsableCredential: 缺 zcode_jwt 或 device_mid 一律不可用', () => {
  assert.equal(isUsableCredential({ zcode_jwt: 'x', device_mid: 'y' }), true)
  assert.equal(isUsableCredential({ zcode_jwt: '', device_mid: 'y' }), false)
  assert.equal(isUsableCredential({ zcode_jwt: 'x' }), false)
  assert.equal(isUsableCredential(null), false)
})

test('add 拒绝形状不合法的凭据（写入侧也要校验）', withPool(async (pool) => {
  assert.throws(() => pool.add({ zcode_jwt: 'x' }), /凭据形状不合法/)
}))

/**
 * 1.0.0 实时路由：模型栏旁的「当前使用账号」读的是**每次真实派发**的记录，
 * 而不是配置里的钉定账号 —— 统一选号会换号，配置值会立刻说谎。
 */
test('noteRouted: 记录每次真实派发，换号跟着走，改名即时生效', withPool(async (pool) => {
  assert.equal(pool.lastRouted(), undefined, '启动后未发请求 = undefined（不是「没有账号」）')
  const a = pool.add(credential('a'), '账号A').entry
  const b = pool.add(credential('b'), '账号B').entry

  const first = pool.noteRouted(a.id, 'GLM-5.3-Flash')
  assert.equal(first.accountId, a.id)
  assert.equal(first.nickname, '账号A')
  assert.equal(first.modelId, 'GLM-5.3-Flash')
  assert.ok(first.at > 0)

  /** 换号：记录必须跟着走（这正是「实时」的含义）。 */
  assert.equal(pool.noteRouted(b.id, 'GLM-5.3').accountId, b.id)
  assert.equal(pool.lastRouted().nickname, '账号B')

  /** 改名后下一次记录带新昵称（不卡旧名）。 */
  pool.patchAccount(b.id, { nickname: '改名后的B' })
  assert.equal(pool.noteRouted(b.id, 'GLM-5.3').nickname, '改名后的B')
}))

test('noteRouted: 空入参不覆盖上一条；记录里绝不含凭据', withPool(async (pool) => {
  const a = pool.add(credential('a'), 'A').entry
  pool.noteRouted(a.id, 'GLM-5.3-Flash')
  const before = pool.lastRouted()
  pool.noteRouted('', 'GLM-5.3')
  pool.noteRouted(undefined)
  assert.equal(pool.lastRouted(), before, '非法入参不覆盖真实记录')
  assert.equal(JSON.stringify(before).includes('jwt-a'), false, '路由记录不含 zcode_jwt')
  assert.equal(JSON.stringify(before).includes('dev-a'), false, '路由记录不含 device_mid')
}))

/**
 * 1.0.1 审计回归：`preview` 是「模型栏旁徽标在首次请求前」的唯一数据源，
 * 只要它和 `pick` 的筛选不一致，徽标就必然显示一个**真实派发时会跳过**的账号。
 */
test('previewOrder 与 pick 同筛选：限流 / 忙 / 凭据不可用的账号不会被预览', withPool(async (pool) => {
  const a = pool.add(credential('a'), 'A').entry
  const b = pool.add(credential('b'), 'B').entry
  const c = pool.add(credential('c'), 'C').entry

  /** 无任何标记时，预览第一 = pick 第一。 */
  assert.equal(pool.previewOrder('GLM-5.3-Flash', 1)[0].accountId, pool.pick('GLM-5.3-Flash').entry.id)

  /** A 在该模型上限流 → 预览必须跳过 A（而不是按 added_at 取第一个）。 */
  pool.markModelRateLimited(a.id, 'GLM-5.3-Flash', Date.now() + 3_600_000)
  assert.notEqual(pool.previewOrder('GLM-5.3-Flash', 1)[0].accountId, a.id, '限流账号不能出现在预览里')
  assert.equal(pool.previewOrder('GLM-5.3-Flash', 1)[0].accountId, pool.pick('GLM-5.3-Flash').entry.id)
  /** 另一个模型不受影响。 */
  assert.equal(pool.previewOrder('GLM-5.3', 1)[0].accountId, a.id)

  /**
   * 忙标记（3009）：第一档避开；全都忙时 pick 回落第二档，预览也必须回落。
   */
  pool.markModelBusy(b.id, 'GLM-5.3', 60_000)
  pool.markModelBusy(c.id, 'GLM-5.3', 60_000)
  assert.equal(pool.previewOrder('GLM-5.3', 1)[0].accountId, a.id, '忙账号在有空闲账号时不进预览')
  pool.markModelBusy(a.id, 'GLM-5.3', 60_000)
  assert.equal(
    pool.previewOrder('GLM-5.3', 1)[0].accountId,
    pool.pick('GLM-5.3').entry.id,
    '全部忙时两者回落同一档（按排序取第一个）',
  )
}))

test('previewOrder: 停用账号不参与（与 pick 一致）', withPool(async (pool) => {
  const a = pool.add(credential('a'), 'A').entry
  const b = pool.add(credential('b'), 'B').entry
  /** `store.patch/upsert` 校验凭据形状，坏凭据写不进去 —— 这里覆盖可构造的停用路径。 */
  pool.setEnabled(a.id, false)
  assert.equal(pool.previewOrder('GLM-5.3-Flash', 1)[0].accountId, b.id)
  assert.equal(pool.pick('GLM-5.3-Flash').entry.id, b.id, '两者必须一致')
  pool.setEnabled(a.id, true)
  assert.equal(pool.previewOrder('GLM-5.3-Flash', 1)[0].accountId, a.id, '重新启用后回到首选')
}))

/**
 * 用户实测故障：**面板显示额度开启，对话却说额度耗尽**。
 * 面板口径 = 上游余额接口里所有已激活桶；对话准入 = 当前生效桶 + 1005 标记。
 * `quotaState` 必须把「准入已拒」显式暴露出来，否则徽标只能继续显示健康账号。
 */
test('quotaState: 上游已判额度用尽时 available=false（解释面板/对话不一致）', withPool(async (pool) => {
  const a = pool.add(credential('a'), 'A').entry
  const model = 'GLM-5.3-Flash'

  /** 没有否决位、也没有面板数据 → usable 未知（null），**不是**「有额度」。 */
  assert.deepEqual(pool.quotaState(a.id, model, {}), {
    available: null,
    limited: false,
    expired: false,
    usable: null,
    reason: null,
  })
  /** 面板确认有余量且无否决位 → 可用。 */
  assert.equal(pool.quotaState(a.id, model, { available: true }).usable, true)

  pool.markModelRateLimited(a.id, model, Date.now() + 3_600_000)
  const limited = pool.quotaState(a.id, model, { available: true, expiresAt: null })
  /** ⚠ 关键：面板口径 available=true 原样保留，冲突由 usable=false 表达。 */
  assert.equal(limited.available, true, '面板口径不被准入否决洗掉')
  assert.equal(limited.usable, false, '综合结论：不可用')
  assert.equal(limited.limited, true)
  assert.match(limited.reason, /额度用尽/)
  /** 同一账号的其它模型不受影响。 */
  assert.equal(pool.quotaState(a.id, 'GLM-5.3', { available: true }).usable, true)

  /** 缓存里的生效桶已过期 → 同样不可用（提示为上游客口径的副作用）。 */
  const expired = pool.quotaState(a.id, 'GLM-5.3', { available: true, expiresAt: Date.now() - 1 })
  assert.equal(expired.usable, false)
  assert.equal(expired.expired, true)
}))

test('noteRouted: outcome 记录「正在服务 / 已判耗尽」，换号后不停在失败账号上', withPool(async (pool) => {
  const a = pool.add(credential('a'), 'A').entry
  const b = pool.add(credential('b'), 'B').entry

  pool.noteRouted(a.id, 'GLM-5.3-Flash', { outcome: 'attempting' })
  assert.equal(pool.lastRouted().outcome, 'attempting')
  /** 上游判 A 额度用尽（零内容 / 1005）→ 记录必须转成 exhausted。 */
  pool.noteRouted(a.id, 'GLM-5.3-Flash', { outcome: 'exhausted', reason: 'HTTP 200 但零内容' })
  assert.equal(pool.lastRouted().outcome, 'exhausted')
  assert.match(pool.lastRouted().reason, /零内容/)
  /** 换到 B 并命中 → 徽标显示 B（真实在服务的那个）。 */
  pool.noteRouted(b.id, 'GLM-5.3-Flash', { outcome: 'ok' })
  assert.equal(pool.lastRouted().accountId, b.id)
  assert.equal(pool.lastRouted().outcome, 'ok')
  assert.equal(pool.lastRouted().reason, undefined, '成功记录不带失败原因')
}))
