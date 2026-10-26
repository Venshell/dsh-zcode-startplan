/**
 * client.js 面板的**结构级**测试。
 *
 * client.js 是宿主注入 `React` 的浏览器 bundle（不 import react），
 * 所以这里塞一个**最小 createElement 实现**，把渲染结果摊成可断言的树：
 * 只关心「有没有那条进度条 / 条纹标记对不对 / 底部那句时间在不在」。
 *
 * 覆盖 0.4.7 的需求：未生效额度与已生效额度**同形状一条进度条**，
 * 区别只在 `data-pending` 与底部「X 起可用」。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * 极简 h()：只认 type / props / children，够断言用。
 *
 * ⚠ hooks 是**带计数**的桩：同一组件在两次渲染里调用的 hook 数不一致时抛错
 * （复刻 React 的「Rendered fewer hooks than expected」）。0.5.0 的
 * ClaimSection 把 useCallback 放在早退之后，账号非空时多调一个 → 整个面板白屏。
 */
function makeReact() {
  const h = (type, props, ...children) => ({
    type,
    props: props ?? {},
    children: children.flat().filter((child) => child !== null && child !== undefined && child !== false),
  })
  /** 当前组件的 hook 计数（渲染前由 render() 重置）。 */
  let hookCount = 0
  let expectedHookCount
  const tick = () => {
    hookCount += 1
  }
  return {
    createElement: h,
    Fragment: Symbol('Fragment'),
    useState: (initial) => {
      tick()
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
    useEffect: () => tick(),
    useRef: (initial) => {
      tick()
      return { current: initial }
    },
    useCallback: (fn) => {
      tick()
      return fn
    },
    __hooks: {
      begin: (expected) => {
        expectedHookCount = expected
        hookCount = 0
      },
      end: () => {
        if (expectedHookCount !== undefined && hookCount !== expectedHookCount) {
          throw new Error(`渲染之间 hook 数量变化：${expectedHookCount} → ${hookCount}（React 会抛 Rendered fewer hooks than expected）`)
        }
        expectedHookCount = hookCount
        return hookCount
      },
    },
  }
}

/**
 * 把 client.js 当作工厂函数求值。它导出 `(ctx) => …`，内部用闭包里的
 * `React`；这里用一个假的 React 与环境把面板组件取出来。
 */
const SOURCE = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

/** 全局共享的假 React（buildPanel 与 resolve 用同一份 Fragment 符号）。 */
const FakeReact = makeReact()

/**
 * 从源码里抠出一个函数定义（按名 + 括号配平）。
 *
 * 不能用 `function NAME(props)` 定位：辅助函数签名各异
 * （`formatReset(resetAt)` / `QuotaMeter(props)`），统一按名字找。
 */
function extractFunction(name) {
  const pattern = new RegExp(`function ${name}\\s*\\(`)
  const match = pattern.exec(SOURCE)
  assert.notEqual(match, null, `client.js 里找不到 function ${name}`)
  const start = match.index
  let depth = 0
  let i = SOURCE.indexOf('{', start)
  for (; i < SOURCE.length; i += 1) {
    if (SOURCE[i] === '{') depth += 1
    else if (SOURCE[i] === '}') {
      depth -= 1
      if (depth === 0) break
    }
  }
  return SOURCE.slice(start, i + 1)
}

/** 把抽出来的组件 + 依赖函数拼成一个可执行模块。 */
function buildPanel() {
  const helpers = ['formatReset', 'formatEffective', 'formatPendingUnits', 'formatRemaining', 'channelLabel'].map(extractFunction).join('\n')
  const quota = extractFunction('QuotaMeter')
  const card = extractFunction('AccountCard')
  const claimSection = extractFunction('ClaimSection')
  /**
   * 桩件：NicknameEdit / Toggle / api 用最简实现替代（它们的渲染不是本测试的主题），
   * `h`/`Fragment` 从 fake React 取。
   */
  const code = `
    const h = React.createElement
    const Fragment = React.Fragment
    const { useState, useCallback } = React
    const api = async () => ({ ok: true, plans: [] })
    function NicknameEdit(props) { return h('span', null, props.nickname) }
    function Toggle() { return h('input', { type: 'checkbox' }) }
    ${helpers}
    ${quota}
    ${card}
    ${claimSection}
    return { AccountCard, QuotaMeter, ClaimSection, formatEffective, formatPendingUnits, formatRemaining }
  `
  // eslint-disable-next-line no-new-func
  const mod = new Function('React', code)(FakeReact)
  return { ...mod, React: FakeReact, render: (node) => resolve(node, FakeReact) }
}

/** 在渲染树里找所有 className 含 needle 的节点。 */
function findAll(node, predicate, out = []) {
  if (node === null || typeof node !== 'object') return out
  if (predicate(node)) out.push(node)
  for (const child of node.children ?? []) findAll(child, predicate, out)
  return out
}

/**
 * 展开树里的函数组件（`h(QuotaMeter, props)` 的 type 是函数）。
 * 不做 memo / hooks 状态，但**校验 hook 数量**：同一个组件先后渲染时
 * hook 数必须一致，否则就是 React 层面的白屏 bug。
 */
function resolve(node, React, seen = new Map()) {
  if (node === null || typeof node !== 'object') return node
  if (typeof node.type === 'function') {
    const name = node.type.name || 'anonymous'
    React.__hooks.begin(seen.has(name) ? seen.get(name) : undefined)
    let rendered
    try {
      rendered = node.type(node.props)
    } finally {
      seen.set(name, React.__hooks.end())
    }
    return resolve(rendered, React, seen)
  }
  return { ...node, children: node.children.map((child) => resolve(child, React, seen)) }
}

const textOf = (node) =>
  node === null || node === undefined
    ? ''
    : typeof node === 'string' || typeof node === 'number'
      ? String(node)
      : (node.children ?? []).map(textOf).join('')

const baseAccount = {
  id: 'acc-1',
  index: 1,
  nickname: 'ACC_B',
  enabled: true,
  channel: 'zai',
  modelRateLimits: {},
}

test('AccountCard: 已生效额度只有一条实色进度条', () => {
  const panel = buildPanel()
  const tree = panel.render(panel.AccountCard({
    account: baseAccount,
    balance: { ok: true, enterprise: false, remaining: 7_876_044, total: 8_000_000, planName: 'GLM-5.3' },
    modelListVisible: true,
  }))
  const bars = findAll(tree, (node) => node.props?.className === 'zsp-bar')
  assert.equal(bars.length, 1, '已生效时应有一条进度条')
  assert.notEqual(bars[0].props['data-pending'], true, '已生效的条不能打 pending 标记')
  const text = textOf(tree)
  assert.match(text, /剩余 7876044\/8000000/)
  assert.match(text, /GLM-5\.3/)
})

test('AccountCard: 未生效额度与已生效额度同形状，底部标启用时间', () => {
  const panel = buildPanel()
  const effectiveAt = Date.now() + 2 * 60 * 60 * 1000
  const tree = panel.render(panel.AccountCard({
    account: baseAccount,
    balance: {
      ok: true,
      enterprise: false,
      remaining: 0,
      total: 0,
      planName: null,
      pending: [{ planId: 'zcode-v3-start-plan-nt-1026', showName: 'GLM-5.3-Flash', grantUnits: 300_000_000, effectiveAt }],
    },
    modelListVisible: true,
  }))
  const bars = findAll(tree, (node) => node.props?.className === 'zsp-bar')
  assert.equal(bars.length, 2, '已生效 1 条 + 未生效 1 条')
  assert.notEqual(bars[0].props['data-pending'], true, '第一条是已生效的')
  assert.equal(bars[1].props['data-pending'], true, '第二条是未生效的（条纹）')
  /** 未生效那条必须是满格：还没开始消耗。 */
  const fill = bars[1].children[0]
  assert.equal(fill.props.style.width, '100%')

  const text = textOf(tree)
  assert.match(text, /起可用/, '进度条底部要写启用时间')
  assert.match(text, /GLM-5\.3-Flash 3亿 tokens/, '要标出是哪一份额度')
  /** 时间文案应出现在条下方的 caption 里，而不是标题行。 */
  const captions = findAll(tree, (node) => node.props?.className?.includes('zsp-meter-caption'))
  assert.equal(captions.length, 2, '每条进度条各一句 caption')
  assert.match(textOf(captions[1]), /起可用/)
})

test('AccountCard: 多个未生效额度各一条进度条（按到点时间顺序）', () => {
  const panel = buildPanel()
  const now = Date.now()
  const tree = panel.render(panel.AccountCard({
    account: baseAccount,
    balance: {
      ok: true,
      enterprise: false,
      remaining: 0,
      total: 0,
      planName: null,
      pending: [
        { planId: 'a', showName: 'GLM-5.3-Flash', grantUnits: 100_000_000, effectiveAt: now + 3_600_000 },
        { planId: 'b', showName: 'GLM-5.3', grantUnits: 50_000_000, effectiveAt: now + 7_200_000 },
      ],
    },
    modelListVisible: true,
  }))
  const pendingBars = findAll(tree, (node) => node.props?.className === 'zsp-bar' && node.props['data-pending'] === true)
  assert.equal(pendingBars.length, 2)
})

test('QuotaMeter: 缺 total 的额度按 0% 画（不是满格），未生效固定 100%', () => {
  const panel = buildPanel()
  const unknown = panel.QuotaMeter({ remaining: undefined, total: undefined })
  assert.equal(unknown.children[0].children[0].props.style.width, '0%')
  const pending = panel.QuotaMeter({ pending: true, effectiveAt: Date.now() + 1000 })
  assert.equal(pending.children[0].children[0].props.style.width, '100%')
})

test('AccountCard: 企业版与错误态不画进度条', () => {
  const panel = buildPanel()
  const enterprise = panel.render(panel.AccountCard({ account: baseAccount, balance: { ok: true, enterprise: true }, modelListVisible: true }))
  assert.equal(findAll(enterprise, (n) => n.props?.className === 'zsp-bar').length, 0)
  const failed = panel.render(panel.AccountCard({ account: baseAccount, balance: { ok: false, error: '余额不可用' }, modelListVisible: true }))
  assert.equal(findAll(failed, (n) => n.props?.className === 'zsp-bar').length, 0)
  assert.match(textOf(failed), /余额不可用/)
})

test('formatEffective: 今天只给时刻，跨天带日期', () => {
  const panel = buildPanel()
  const { formatEffective } = panel
  const today = new Date()
  const laterToday = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 0).getTime()
  assert.equal(formatEffective(laterToday), '23:00')
  const nextWeek = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 7, 9, 30).getTime()
  assert.match(formatEffective(nextWeek), /\d+\/\d+/)
})

test('formatRemaining: 分钟 / 小时 / 天 / 已过期 四档', () => {
  const panel = buildPanel()
  const { formatRemaining } = panel
  const now = Date.now()
  assert.equal(formatRemaining(now + 12 * 60_000, now), '12 分钟后')
  assert.equal(formatRemaining(now + 3 * 3_600_000, now), '3 小时后')
  assert.equal(formatRemaining(now + 90 * 60_000, now), '1 小时 30 分后')
  assert.equal(formatRemaining(now + 2 * 86_400_000, now), '2 天后')
  assert.equal(formatRemaining(now + 30_000, now), '不到 1 分钟')
  assert.equal(formatRemaining(now - 1000, now), '已过期')
  assert.equal(formatRemaining(0, now), '', '没有到期时间时返回空串，不能出现 1970')
  assert.equal(formatRemaining(undefined, now), '')
})

test('QuotaMeter: caption 同时给出剩余、计划名与到期时间', () => {
  const panel = buildPanel()
  const expiresAt = Date.now() + 3 * 3_600_000 // 3 小时后
  const tree = panel.QuotaMeter({ remaining: 7_876_044, total: 8_000_000, planName: 'GLM-5.3', expiresAt })
  const text = textOf(tree.children[1])
  assert.match(text, /剩余 7876044\/8000000/)
  assert.match(text, /GLM-5\.3/)
  assert.match(text, /到期/)
  assert.match(text, /3 小时后/)
})

test('QuotaMeter: 未生效额度同时给"何时起可用"与"何时到期"', () => {
  const panel = buildPanel()
  const effectiveAt = Date.now() + 60 * 60_000
  const expiresAt = Date.now() + 2 * 86_400_000
  const tree = panel.QuotaMeter({ pending: true, effectiveAt, expiresAt, planName: 'GLM-5.3-Flash' })
  const text = textOf(tree.children[1])
  assert.match(text, /起可用/)
  assert.match(text, /到期/)
})

test('QuotaMeter: 没有 gives 到期信息时不留下 undefined', () => {
  const panel = buildPanel()
  const tree = panel.QuotaMeter({ remaining: 10, total: 10, planName: 'X' })
  const text = textOf(tree.children[1])
  assert.doesNotMatch(text, /undefined/)
  assert.doesNotMatch(text, /NaN/)
  assert.doesNotMatch(text, /1970/)
})

/**
 * ⚠ 白屏回归闸（0.5.0 实际事故）。
 *
 * ClaimSection 曾把 `useCallback` 放在 `return null` 早退之后：
 * 账号为空走早退 → 少调一个 hook；非空 → 多调一个。React 抛
 * 「Rendered fewer hooks than expected」，**整个插件面板白屏**。
 *
 * 本用例用**带计数的 hooks 桩**渲染 ClaimSection 两次（空账号池 / 有账号），
 * 两次 hook 数不一致就抛错。
 */
test('ClaimSection: 空账号池与有账号两次渲染，hook 数量必须一致', () => {
  const panel = buildPanel()
  /** 先渲染空池（走早退）。 */
  const empty = panel.render(panel.ClaimSection({ accounts: [], busy: false, captcha: { reachable: false } }))
  assert.equal(empty, null, '空池时不渲染任何内容')

  /** 再渲染有账号（不应因 hooks 数量变化而抛错）。 */
  const filled = panel.render(
    panel.ClaimSection({
      accounts: [{ id: 'a1', index: 1, nickname: 'ACC', enabled: true }],
      busy: false,
      captcha: { reachable: false, debugPort: 9229, reason: '连不上调试端口' },
    }),
  )
  assert.notEqual(filled, null)
  const text = textOf(filled)
  assert.match(text, /赠送额度/)
  /** captcha 不可用 → 必须给出「以调试模式重启」按钮，而不是让人手抄 param。 */
  const buttons = findAll(filled, (node) => node.type === 'button').map(textOf)
  assert.ok(buttons.includes('以调试模式重启'), `应出现重启按钮，实际：${buttons.join(' / ')}`)
})

test('ClaimSection: captcha 可用时不显示重启按钮', () => {
  const panel = buildPanel()
  const tree = panel.render(
    panel.ClaimSection({
      accounts: [{ id: 'a1', index: 1, nickname: 'ACC', enabled: true }],
      busy: false,
      captcha: { reachable: true, debugPort: 9229 },
    }),
  )
  const buttons = findAll(tree, (node) => node.type === 'button').map(textOf)
  assert.ok(!buttons.includes('以调试模式重启'), '载体已就绪就不该再提示重启')
  assert.match(textOf(tree), /captcha 载体已就绪/)
})
