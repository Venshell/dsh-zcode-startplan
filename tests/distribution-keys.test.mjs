/**
 * 分发 key 持久化（`lib/distribution-keys.js`）。
 *
 * 重点回归：**0.9.6 之前落盘的 key 没有 `id`**（旧格式只存 token）——缺 id 的
 * key 面板永远删不掉（`publicDistributionKey` 投影 `id: undefined`，JSON 丢键，
 * CRUD 请求体没有定位键）。真实报障「已创建的 id 丢失无法删除」。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  loadDistributionKeys,
  saveDistributionKeys,
  createDistributionKey,
  publicDistributionKey,
  DISTRIBUTION_KEY_PATTERN,
} from '../lib/distribution-keys.js'

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'zsp-dist-keys-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const legacyFile = (dir, keys) => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'distribution-keys.json'), JSON.stringify({ keys }, null, 1))
}

test('loadDistributionKeys: 0.9.6 旧格式（无 id）自动补 dk_ id，token 原样保留', () => withDir((dir) => {
  legacyFile(dir, [
    { token: 'zsp-iqajClF9hcsgD7iuNZmLuw', name: '未命名', quotaTotal: null, accountId: null, enabled: true, createdAt: 1, usage: { inputTokens: 0, outputTokens: 0, requests: 0 } },
  ])
  const keys = loadDistributionKeys(dir)
  assert.equal(keys.length, 1)
  assert.match(keys[0].id, /^dk_[A-Za-z0-9_-]+$/, '补上稳定 id')
  assert.equal(keys[0].token, 'zsp-iqajClF9hcsgD7iuNZmLuw', 'token 不变 = 凭据不受影响')
  /** 迁移后的 key 走正常投影：面板有 id 可定位。 */
  const view = publicDistributionKey(keys[0])
  assert.equal(typeof view.id, 'string')
  assert.ok(view.id.length > 0, '投影的 id 不再是 undefined（JSON 会丢 undefined 键）')
}))

test('loadDistributionKeys: 已有 id 不动（迁移幂等，id 跨重启稳定）', () => withDir((dir) => {
  legacyFile(dir, [
    { id: 'dk_keepme', token: 'zsp-hh6NYcPVl9Z_fJuSxpwOag', name: 'x', quotaTotal: null, accountId: null, enabled: true, createdAt: 1, usage: { inputTokens: 0, outputTokens: 0, requests: 0 } },
  ])
  const first = loadDistributionKeys(dir)
  assert.equal(first[0].id, 'dk_keepme')
  const second = loadDistributionKeys(dir)
  assert.equal(second[0].id, 'dk_keepme', '重复加载不换 id')
}))

test('loadDistributionKeys: 新格式往返 / 坏文件 / 空 key 列表', () => withDir((dir) => {
  const created = createDistributionKey('给台式机', { quotaTotal: 5_000_000 })
  saveDistributionKeys(dir, [created])
  const roundTrip = loadDistributionKeys(dir)
  assert.equal(roundTrip.length, 1)
  assert.equal(roundTrip[0].id, created.id)
  assert.equal(roundTrip[0].token, created.token)
  assert.match(roundTrip[0].token, DISTRIBUTION_KEY_PATTERN)

  writeFileSync(join(dir, 'distribution-keys.json'), '{ 坏 JSON')
  assert.deepEqual(loadDistributionKeys(dir), [])
  assert.deepEqual(loadDistributionKeys(join(dir, '不存在')), [])
}))

test('deleteDistributionKey 流程：按 id 删除后落盘文件里真正消失', () => withDir((dir) => {
  /** 模拟旧格式加载 → 迁移 → 按 id 删除 → 落盘 的完整链路（assemble 同款）。 */
  legacyFile(dir, [
    { token: 'zsp-old1aaaaaaaaaaaaaaaaaa', name: '旧key', quotaTotal: null, accountId: null, enabled: true, createdAt: 1, usage: { inputTokens: 1, outputTokens: 2, requests: 1 } },
    { token: 'zsp-old2aaaaaaaaaaaaaaaaaa', name: '留着', quotaTotal: null, accountId: null, enabled: true, createdAt: 2, usage: { inputTokens: 0, outputTokens: 0, requests: 0 } },
  ])
  const keys = loadDistributionKeys(dir)
  const victim = keys.find((key) => key.token === 'zsp-old1aaaaaaaaaaaaaaaaaa')
  assert.notEqual(victim?.id, undefined, '旧 key 迁移后有 id 可定位')
  const remaining = keys.filter((key) => key.id !== victim.id)
  saveDistributionKeys(dir, remaining)
  const onDisk = JSON.parse(readFileSync(join(dir, 'distribution-keys.json'), 'utf8'))
  assert.equal(onDisk.keys.length, 1)
  assert.equal(onDisk.keys[0].token, 'zsp-old2aaaaaaaaaaaaaaaaaa')
  assert.equal(typeof onDisk.keys[0].id, 'string', '落盘把补的 id 持久化了')
}))
