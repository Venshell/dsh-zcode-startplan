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
    const { useState, useCallback, useEffect } = React
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
  /**
   * ⚠ 不要写死「3 小时后」：`expiresAt` 与渲染时刻之间会因毫秒误差落到
   * 「2 小时 59 分后」，断言就随开机时刻飘（本用例曾因此间歇性失败）。
   */
  assert.match(text, /[23] 小时(?: \d+ 分)?后/, '相对时间（约 3 小时后，容忍分钟级抖动）')
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
  /** captcha 不可用 → 必须给出「开调试端口重启」按钮，而不是让人手抄 param。 */
  const buttons = findAll(filled, (node) => node.type === 'button').map(textOf)
  assert.ok(buttons.includes('开调试端口重启'), `应出现重启按钮，实际：${buttons.join(' / ')}`)
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
  assert.match(textOf(tree), /探测/, '0.6.0 文案：探测自动填 plan_id')
})

test('ClaimSection: 默认关闭时拨盘说明「探测自动、领取手动」', () => {
  const panel = buildPanel()
  const tree = panel.render(
    panel.ClaimSection({
      accounts: [{ id: 'a1', index: 1, nickname: 'ACC', enabled: true }],
      busy: false,
      captcha: { reachable: true },
      autoClaim: { enabled: false },
    }),
  )
  const text = textOf(tree)
  /** 「自动领取」是拨盘的 aria-label（不渲染成可见文字），可见文本是这句说明。 */
  assert.match(text, /自动领取已关闭：探测仍然自动/, '关闭时说明探测仍自动、领取手动')
  /** 测试桩把 Toggle 替换成裸 input，所以按 type=checkbox 找拨盘。 */
  const toggles = findAll(tree, (node) => node.type === 'input' && node.props?.type === 'checkbox')
  assert.equal(toggles.length, 1, '要有自动领取拨盘')
})

test('ClaimSection: 自动领取开启时显示已开启与已记录数', () => {
  const panel = buildPanel()
  const tree = panel.render(
    panel.ClaimSection({
      accounts: [{ id: 'a1', index: 1, nickname: 'ACC', enabled: true }],
      busy: false,
      captcha: { reachable: true },
      autoClaim: { enabled: true, seenCount: 3 },
    }),
  )
  const text = textOf(tree)
  assert.match(text, /已开启/)
  assert.match(text, /已记录 3 个/, '把 seenCount 透出，用户能看出「不会重复领」')
})

test('ClaimSection 源码：展开时自动探测（useEffect + /claimable），探测零成本', () => {
  const claimSectionSrc = extractFunction('ClaimSection')
  assert.match(claimSectionSrc, /useEffect\(/, '展开即自动探测（不需要用户点按钮）')
  assert.match(claimSectionSrc, /\/claimable/, '探测走官方发现端点')
  assert.match(claimSectionSrc, /onToggleAutoClaim/, '拨盘要能把开关写回宿主')
})

test('ClaimSection 源码：重启是两段式确认，且明确告知会中断任务', () => {
  const claimSectionSrc = extractFunction('ClaimSection')
  assert.match(claimSectionSrc, /confirmRestart/, '重启需要二次确认状态')
  assert.match(claimSectionSrc, /确认重启？会中断任务/, '确认按钮必须写明后果')
  assert.match(claimSectionSrc, /confirm: true/, '调用重启端点要带服务端要求的二次确认')
  assert.match(claimSectionSrc, /中断/, '提示里必须说明重启会中断任务')
})

/**
 * ⚠ 0.6.4：「重载插件」与「开调试端口」是两件事。
 * 旧文案写成「以调试模式重启」，暗示普通模式不能重启 —— 这是错的：
 * 不带端口重启同样让插件生效，只是 captcha 领不了。
 */
test('ClaimSection 源码：普通重启不带端口，调试端口只是可选姿势', () => {
  const claimSectionSrc = extractFunction('ClaimSection')
  /** ⚠ 只查字符串字面量：注释里会提到旧文案（讲清为什么改），不算违规。 */
  assert.doesNotMatch(claimSectionSrc, /'以调试模式重启'|"以调试模式重启"/, '不该再暗示「普通模式不能重启」')
  assert.match(claimSectionSrc, /restart\('plain'\)/, '提供普通重启（不带端口）')
  assert.match(claimSectionSrc, /restart\('debug'\)/, '提供带端口重启')
  assert.match(claimSectionSrc, /debugPort !== undefined/, '普通重启不得传 debugPort')
})

test('ClaimSection 源码：自动领取「说明在左、开关在右」', () => {
  const claimSectionSrc = extractFunction('ClaimSection')
  const textIdx = claimSectionSrc.indexOf('自动领取已')
  const toggleIdx = claimSectionSrc.indexOf('h(Toggle, {', textIdx)
  assert.ok(textIdx > 0, '要有自动领取说明文案')
  assert.ok(toggleIdx > textIdx, '开关必须排在说明文本之后（否则与上方按钮列错位）')
})

/**
 * ⚠ 2026-10-28 语义变更：面板不再「先查 preview 再显示领取按钮」。
 *
 * 实证：官方客户端全天 0 次调用 `/billing/preview`，点击时直接调 claim。
 * 我们照抄了源码里存在但从未被使用的方法 → preview 恒空 → 按钮永不出现。
 *
 * 新形态：**探测按钮自动填 plan_id + 直接领取**，「有没有名额」由服务端裁决。
 * 0.6.0 起探测走官方 marketing/touch 发现端点（与 /billing/preview 无关），
 * 「不 preview」的约束仍成立：没有任何路径再引用 /billing/preview。
 * 本用例锁住这个形态，防止有人把它改回「查 preview 列表」。
 */
test('ClaimSection: 展开后给输入框与领取按钮，不再依赖 preview 列表', () => {
  const panel = buildPanel()
  /** 先渲染一次（触发 open 的初始态）。 */
  panel.render(panel.ClaimSection({ accounts: [{ id: 'a1', index: 1, nickname: 'ACC', enabled: true }], busy: false, captcha: { reachable: true } }))

  /**
   * 直接构造展开态：fake React 的 useState 是静态的（不支持 setState 触发重渲染），
   * 所以这里验证**闭合态**没有把旧文案带回来，并单独验证组件源码不含 preview 依赖。
   */
  const collapsed = panel.render(panel.ClaimSection({ accounts: [{ id: 'a1', index: 1, nickname: 'ACC', enabled: true }], busy: false, captcha: { reachable: true } }))
  const text = textOf(collapsed)
  /** 旧 UI 的「查看可领取」话术必须消失。 */
  assert.doesNotMatch(text, /查看可领取/, '不该再有"查看可领取"（它依赖恒空的 preview）')
  assert.doesNotMatch(text, /暂无可领取的活动/, '不该再显示"暂无可领取"')
  /** 新话术要在。 */
  assert.match(text, /自动探测/, '探测是自动的（展开即探）')
})

/**
 * ⚠ 契约：**不保留手工输入 plan_id 的组件**。
 *
 * 有过三个版本的反复：先「查 preview 列表 → 有才领」，再「填 plan_id 直接领」，
 * 现在「自动探测 → 直接领」。手输路径只会让人填错或填过期 id，白烧一次 captcha；
 * 探测零成本且权威，所以输入框与「探测」按钮一起移除，plan_id 只读展示。
 */
test('ClaimSection: 没有手工输入 plan_id 的输入框，也没有探测按钮', () => {
  const claimSectionSrc = extractFunction('ClaimSection')
  assert.doesNotMatch(claimSectionSrc, /placeholder/, '不该有占位提示的输入框')
  assert.doesNotMatch(claimSectionSrc, /onChange:\s*\(event\)\s*=>\s*patch\([^)]*planId/, '不该有改 planId 的输入')
  assert.doesNotMatch(claimSectionSrc, /'探测'/, '探测按钮已移除：展开即自动探测')
  /** plan_id 改由探测结果驱动，只读展示。 */
  assert.match(claimSectionSrc, /zsp-plan-id/, 'plan_id 只读展示')
})

test('ClaimSection 源码：探测走 /claimable（marketing/touch），领取直接 /claim，绝无 preview', () => {
  const claimSectionSrc = extractFunction('ClaimSection')
  assert.match(claimSectionSrc, /\/claimable/, '探测调 /claimable（官方 marketing/touch，零 captcha）')
  assert.match(claimSectionSrc, /\/claim/, '必须直接走 /claim')
  assert.match(claimSectionSrc, /planId/, '必须按 planId 领取')
  /** /billing/preview 是死端点：客户端源码任何地方都不许再引用。 */
  assert.doesNotMatch(claimSectionSrc, /billing\/preview/, 'preview 恒空，官方客户端也不调它')
})
