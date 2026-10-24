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
  pool.add(credential('a'), 'A')
  pool.add(credential('b'), 'B')
  const first = pool.pick('GLM-5.3-Flash')
  assert.equal(first.entry.nickname, 'A')
  const second = pool.pick('GLM-5.3-Flash', new Set([first.entry.id]))
  assert.equal(second.entry.nickname, 'B')
  assert.equal(pool.pick('GLM-5.3-Flash', new Set([first.entry.id, second.entry.id])), null)
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
