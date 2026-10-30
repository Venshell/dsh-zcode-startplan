/**
 * 营销活动发现（marketing/touch）与自动领取状态机。
 *
 * 实证来源：ZCode 客户端 3.16.3 反编译（`createMarketingTouchService` / 分发按钮
 * schema `{type:"claim_zcode_plan", args:{plan_id}}`）。响应形状：
 * `{code:0, data:{server_time, language, deliveries:[{campaign_id, priority,
 *   resource_position, banner|popup:{buttons:[…]}]}}}`
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { fetchClaimablePlans } from '../lib/upstream-api.js'
import { createAutoClaim, loadAutoClaimState, saveAutoClaimState } from '../lib/auto-claim.js'

const CREDENTIAL = { zcode_jwt: 'jwt-1', device_mid: 'dev-1', user_id: 'u-1' }

/** 构造一个官方形状的 marketing/touch 响应体。 */
const touchResponse = (deliveries, { withAuth = false } = {}) => ({
  code: 0,
  data: {
    server_time: 1790000000,
    language: 'zh-CN',
    deliveries,
  },
})

const delivery = ({ planId, campaignId = 'camp-1', priority = 50, position = 'popup', label = '立即领取' }) => ({
  campaign_id: campaignId,
  priority,
  resource_position: position,
  ...(position === 'popup'
    ? { popup: { title: { format: 'plaintext', content: '活动' }, buttons: [
        { text: { format: 'plaintext', content: '关闭' }, action: { type: 'close' } },
        { text: { format: 'plaintext', content: label }, action: { type: 'claim_zcode_plan', args: { plan_id: planId } } },
      ] } }
    : { banner: { background: { type: 'image', image: { default: { src: 'https://x/y.png', sha256: 'a'.repeat(64) } } }, buttons: [
        { text: { format: 'plaintext', content: label }, action: { type: 'claim_zcode_plan', args: { plan_id: planId } } },
      ] } }),
})

const response = (body, { status = 200, seenHeaders } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers({ 'content-type': 'application/json' }),
  json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  text: async () => JSON.stringify(body),
  ...(seenHeaders ? {} : {}),
})

test('fetchClaimablePlans: 从 marketing/touch 投放按钮里提取 plan_id', async () => {
  let seen
  const fetchImpl = async (_url, init) => {
    seen = init.headers
    return response(touchResponse([
      delivery({ planId: 'plan-a', priority: 90 }),
      delivery({ planId: 'plan-b', campaignId: 'camp-2', priority: 30, position: 'banner' }),
    ]))
  }
  const plans = await fetchClaimablePlans(CREDENTIAL, fetchImpl)
  assert.deepEqual(plans.map((plan) => plan.planId), ['plan-a', 'plan-b'], '按 priority 降序')
  assert.equal(plans[0].campaignId, 'camp-1')
  assert.equal(plans[0].name, '立即领取', '按钮文案作为活动名')
  assert.equal(seen['X-Device-Mid'], 'dev-1')
  assert.equal(seen['X-Client-Language'], 'zh-CN', '服务端按语言过滤投放')
})

test('fetchClaimablePlans: 同 planId 去重；非 claim 按钮忽略（双来源后同 plan 保留首见 campaign）', async () => {
  const fetchImpl = async () => response(touchResponse([
    delivery({ planId: 'plan-a', campaignId: 'camp-low', priority: 10 }),
    delivery({ planId: 'plan-a', campaignId: 'camp-high', priority: 80 }),
    delivery({ planId: '', priority: 99 }),
  ]))
  const plans = await fetchClaimablePlans(CREDENTIAL, fetchImpl)
  assert.equal(plans.length, 1)
  /**
   * 0.8.0 对齐参考实现的合并语义：同 planId **preview 优先 / 首见保留**，
   * 只补 campaignId，不再按 priority 覆盖 —— 领取成功后回执要发到
   * 「第一次见到它」的那个 campaign。
   */
  assert.equal(plans[0].campaignId, 'camp-low')
  assert.equal(plans[0].priority, 10)
})

test('fetchClaimablePlans: 非 200 / 坏 JSON / 空投放 → 空数组不抛错', async () => {
  assert.deepEqual(await fetchClaimablePlans(CREDENTIAL, async () => response('no', { status: 500 })), [])
  const badJson = { ok: true, status: 200, headers: new Headers(), json: async () => { throw new Error('x') }, text: async () => 'x' }
  assert.deepEqual(await fetchClaimablePlans(CREDENTIAL, async () => badJson), [])
  assert.deepEqual(await fetchClaimablePlans(CREDENTIAL, async () => response(touchResponse([]))), [])
  const networkFail = async () => { throw new Error('ECONNRESET') }
  assert.deepEqual(await fetchClaimablePlans(CREDENTIAL, networkFail), [])
})

/** autoClaim 的最小池。 */
function fakePool(credentials = [{ id: 'acct-a', credential: CREDENTIAL }]) {
  const state = credentials.map((entry) => ({ nickname: entry.id, enabled: true, ...entry }))
  return {
    list: (_options) => state,
    get: (id) => state.find((entry) => entry.id === id),
  }
}

/** 开关语义：探测永远自动，**领取是开关项**（用例验证领取侧，故显式开启）。 */
const enabled = (extra) => ({ enabled: true, ...extra })

function withStateDir(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zsp-auto-claim-'))
    try {
      await fn(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

test('autoClaim: 默认关闭 —— tick 空转，绝不代替用户领取；拨盘即时生效', withStateDir(async (dir) => {
  const stateFile = join(dir, 'auto-claim-state.json')
  const pool = fakePool()
  let minted = 0
  let claimed = 0
  let scanned = 0
  const autoClaim = createAutoClaim({
    pool,
    client: { mintCaptcha: async () => { minted += 1; return { param: 'p', region: 'cn' } } },
    fetchClaimablePlans: async () => { scanned += 1; return [{ planId: 'plan-a' }] },
    claimPlan: async () => { claimed += 1; return { ok: true, code: 0 } },
    stateFile,
  })

  assert.equal(autoClaim.isEnabled(), false, '未显式开启 = 关')
  assert.deepEqual(await autoClaim.tick(), [], '关闭时 tick 不扫、不领')
  assert.equal(scanned, 0, '关闭时连探测都不做（探测由面板/CLI 触发）')
  assert.equal(minted, 0, '绝不烧 captcha')
  assert.equal(claimed, 0)

  /** 打开后立即生效（无需重启）；已领集合从空开始正常记录。 */
  assert.equal(autoClaim.setEnabled(true), true)
  await autoClaim.tick()
  assert.equal(claimed, 1, '开启后才真正领取')
  assert.equal(autoClaim.stats().enabled, true)

  /** 再关掉：记录保留，不再新增。 */
  assert.equal(autoClaim.setEnabled(false), false)
  assert.deepEqual(await autoClaim.tick(), [])
  assert.equal(claimed, 1)
  assert.equal(autoClaim.stats().seenCount, 1, '关掉不清历史记录')
  assert.equal(autoClaim.stats().enabled, false)
}))

test('autoClaim: 发现新 planId 才烧 captcha；终态码记 seen 不再重试', withStateDir(async (dir) => {
  const stateFile = join(dir, 'auto-claim-state.json')
  const pool = fakePool()
  const mints = []
  const claims = []
  const autoClaim = createAutoClaim(enabled({
    pool,
    client: { mintCaptcha: async () => { mints.push(1); return { param: `p-${mints.length}`, region: 'cn' } } },
    fetchClaimablePlans: async () => [{ planId: 'plan-a', campaignId: 'camp-1', name: '活动A' }],
    claimPlan: async (_credential, planId) => {
      claims.push(planId)
      return { ok: true, code: 0 }
    },
    stateFile,
    now: () => 1_000,
  }))

  const first = await autoClaim.tick()
  assert.equal(claims.length, 1)
  assert.equal(first[0].ok, true)
  assert.equal(autoClaim.seenSnapshot()['acct-a']['plan-a'].code, 0)
  assert.equal(readFileSync(stateFile, 'utf8').includes('plan-a'), true, '已持久化')

  /** 第二轮：同一 planId 已是终态 → 不再 mint、不再 claim。 */
  await autoClaim.tick()
  assert.equal(mints.length, 1, 'captcha 不重复烧')
  assert.equal(claims.length, 1)
}))

test('autoClaim: 非终态码（网络/异常）不记 seen，下轮重试', withStateDir(async (dir) => {
  const stateFile = join(dir, 'auto-claim-state.json')
  const pool = fakePool()
  let calls = 0
  const autoClaim = createAutoClaim(enabled({
    pool,
    client: { mintCaptcha: async () => ({ param: 'p', region: 'cn' }) },
    fetchClaimablePlans: async () => [{ planId: 'plan-x' }],
    claimPlan: async () => {
      calls += 1
      return { ok: false, code: 999, message: '服务器开小差' }
    },
    stateFile,
  }))
  await autoClaim.tick()
  await autoClaim.tick()
  assert.equal(calls, 2, '非终态 → 每轮重试')
  assert.equal(autoClaim.seenSnapshot()['acct-a']?.['plan-x'], undefined, '非终态绝不入 seen')

  /** captcha 失败同样不记 seen。 */
  let mintCalls = 0
  const failingCaptcha = createAutoClaim(enabled({
    pool,
    client: { mintCaptcha: async () => { mintCalls += 1; throw new Error('CDP 不可达') } },
    fetchClaimablePlans: async () => [{ planId: 'plan-y' }],
    claimPlan: async () => { throw new Error('should not be called') },
    stateFile,
  }))
  const results = await failingCaptcha.tick()
  assert.equal(results[0].ok, false)
  assert.match(results[0].error, /CDP 不可达/)
  assert.equal(failingCaptcha.seenSnapshot()['acct-a']?.['plan-y'], undefined, 'captcha 失败绝不入 seen')
  assert.equal(failingCaptcha.stats().seenCount, 0)
}))

test('autoClaim: 1003（已领过）与 1005（领完）同样入终态', withStateDir(async (dir) => {
  const pool = fakePool([
    { id: 'acct-a', credential: CREDENTIAL },
    { id: 'acct-b', credential: { ...CREDENTIAL, user_id: 'u-2' } },
  ])
  const autoClaim = createAutoClaim(enabled({
    pool,
    client: { mintCaptcha: async () => ({ param: 'p', region: 'cn' }) },
    fetchClaimablePlans: async (credential) => [
      { planId: credential.user_id === 'u-1' ? 'plan-claimed' : 'plan-gone' },
    ],
    claimPlan: async (credential) => (credential.user_id === 'u-1' ? { ok: true, code: 1003, alreadyClaimed: true } : { ok: false, code: 1005 }),
    stateFile: join(dir, 'state.json'),
  }))
  await autoClaim.tick()
  const seen = autoClaim.seenSnapshot()
  assert.equal(seen['acct-a']['plan-claimed'].code, 1003)
  assert.equal(seen['acct-b']['plan-gone'].code, 1005)
  assert.equal(autoClaim.stats().seenCount, 2)
}))

test('autoClaim: 状态文件坏 / 版本不识别 → 空状态起跑；禁用账号跳过', withStateDir(async (dir) => {
  const stateFile = join(dir, 'state.json')
  writeFileSync(stateFile, '{broken json')
  assert.deepEqual(loadAutoClaimState(stateFile), {})
  writeFileSync(stateFile, JSON.stringify({ version: 99, seen: { a: { p: { code: 0 } } } }))
  assert.deepEqual(loadAutoClaimState(stateFile), {})
  /** 非终态码（如 999）在加载时被剔除。 */
  writeFileSync(stateFile, JSON.stringify({ version: 1, seen: { acct: { keep: { code: 1003, at: 5 }, drop: { code: 999, at: 5 } } } }))
  assert.deepEqual(loadAutoClaimState(stateFile), { acct: { keep: { code: 1003, at: 5 } } })

  const pool = fakePool([
    { id: 'acct-on', credential: CREDENTIAL },
    { id: 'acct-off', credential: { ...CREDENTIAL, user_id: 'u-2' }, enabled: false },
  ])
  const probed = []
  const autoClaim = createAutoClaim(enabled({
    pool,
    client: { mintCaptcha: async () => ({ param: 'p', region: 'cn' }) },
    fetchClaimablePlans: async (credential) => { probed.push(credential.user_id); return [] },
    claimPlan: async () => ({}),
    stateFile,
  }))
  await autoClaim.tick()
  assert.deepEqual(probed, ['u-1'], '停用账号不参与扫描')
  /** 父路径是文件 → mkdir 必失败 → 返回 false 而不是抛（轮询链路绝不能崩）。 */
  const blocker = join(dir, 'blocker.txt')
  writeFileSync(blocker, 'x')
  assert.equal(saveAutoClaimState(join(blocker, 'child', 's.json'), {}), false, '目录建不出时报告失败而不是抛')
}))
