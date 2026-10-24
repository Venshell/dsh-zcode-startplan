/**
 * Client 模块：官方插件详情页（Plugin Manager → ZCode Start Plan）里的
 * 「账号池管理」面板。
 *
 * ## 挂载点
 *
 * `plugins.detail.section` 是官方插件页声明给贡献区块的座位
 * （root-scope list，随页面 `subject` 渲染在每个插件/条目详情页上）。
 * 本包只在该 subject 提到 `dsh-zcode-start-plan` 时渲染，其余插件页返回 null。
 *
 * ## 数据通道
 *
 * 面板与 Host 之间走同源 fetch：宿主 webserver 上的
 * `/api/zcode-start-plan/*` 路由（`lib/manage-routes.js`，仅 loopback）。
 * 凭据永不外发 —— Host 侧已做脱敏；设备授权的 secret 也留在 Host。
 *
 * ## 实现约束（与宿主一致）
 *
 * - React 来自浏览器模块表（`require('react')`），不自带、不走 CDN；
 * - 样式用宿主主题 token（`--dsw-alias-*`），以组件局部 `<style>` 注入，
 *   卸载即移除；
 * - 工厂无副作用；slot 注册在 `ctx.slots.inject(ownerKey, cb)` 里完成，
 *   宿主负责其生命周期。
 */
window.__ModuleLoader__.load({
  id: 'dsh-zcode-start-plan',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const SLOT = 'plugins.detail.section'
    const API = '/api/zcode-start-plan'
    const CONFIRM_RESET_MS = 3000

    const CSS = `
      .zsp-panel{display:flex;flex-direction:column;gap:10px;max-width:760px;color:var(--dsw-alias-label-primary);font-size:12.5px;line-height:18px}
      .zsp-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
      .zsp-title{margin:0;font-size:13px;font-weight:600;line-height:20px}
      .zsp-muted{color:var(--dsw-alias-label-tertiary);font-size:12px;word-break:break-word}
      .zsp-spacer{flex:1}
      .zsp-btn{font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm,6px);color:var(--dsw-alias-label-primary);background:transparent;padding:3px 10px;font-size:12px;line-height:18px}
      .zsp-btn:hover:enabled{background:var(--dsw-alias-interactive-bg-hover)}
      .zsp-btn:disabled{cursor:default;opacity:.55}
      .zsp-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
      .zsp-btn[data-danger=true]{color:var(--dsw-alias-label-danger)}
      .zsp-error{color:var(--dsw-alias-label-danger);margin:0;font-size:12px;word-break:break-word}
      .zsp-ok{color:var(--dsw-alias-state-success-primary);font-size:12px;word-break:break-word;margin:0}
      .zsp-card{display:flex;flex-direction:column;gap:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:8px;padding:10px 12px}
      .zsp-card[data-next=true]{border-color:var(--dsw-alias-state-business-primary)}
      .zsp-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
      .zsp-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-tertiary);flex:none}
      .zsp-dot[data-on=true]{background:var(--dsw-alias-state-success-primary)}
      .zsp-name{font-weight:600}
      .zsp-chip{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:1px 8px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
      .zsp-chip[data-limited=true]{color:var(--dsw-alias-label-danger);border-color:var(--dsw-alias-label-danger)}
      .zsp-bar{height:6px;border-radius:3px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
      .zsp-bar>span{display:block;height:100%;background:var(--dsw-alias-state-business-primary)}
      .zsp-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:2px}
      .zsp-add{display:flex;flex-direction:column;gap:8px;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;padding:10px 12px}
      .zsp-link{color:var(--dsw-alias-state-business-primary);word-break:break-all}
    `

    /** 同源 API 调用；非 2xx 抛出服务端给的可读 error。 */
    async function api(path, body) {
      const init =
        body === undefined
          ? {}
          : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      const response = await fetch(API + path, init)
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(typeof data?.error === 'string' ? data.error : `HTTP ${response.status}`)
      }
      return data
    }

    /** 座位的 subject 是否指向本插件（对未知 subject 形状保持宽容）。 */
    function isOurSubject(subject) {
      if (subject === undefined || subject === null) return false
      try {
        return JSON.stringify(subject).includes('dsh-zcode-start-plan')
      } catch {
        return false
      }
    }

    function channelLabel(channel) {
      if (channel === 'zai') return 'Z.AI 国际'
      if (channel === 'bigmodel') return '智谱国内'
      return channel === null || channel === undefined ? '渠道未标注' : String(channel)
    }

    function formatReset(resetAt) {
      const ms = Number(resetAt)
      if (!Number.isFinite(ms) || ms <= 0) return ''
      return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }

    /**
     * 单个账号卡片：状态点、昵称、渠道、限流 chips、余额条、操作按钮。
     * 按钮只有两个：「使用」（置顶，下次请求即用它）与「删除」。
     */
    function AccountCard(props) {
      const { account, balance, busy, isNext, confirmId, setConfirmId, onUse, onRemove } = props
      /** Host 下发的是 `modelRateLimits` 对象（model → resetAt），摊平成 chips。 */
      const limited = Object.entries(account.modelRateLimits ?? {})
        .map(([model, resetAt]) => ({ model, resetAt }))
        .filter((item) => Number(item.resetAt) > Date.now())
      const percent =
        balance !== undefined &&
        balance.ok === true &&
        balance.enterprise !== true &&
        typeof balance.total === 'number' &&
        balance.total > 0
          ? Math.max(0, Math.min(100, Math.round(((balance.remaining ?? 0) / balance.total) * 100)))
          : undefined
      return h(
        'div',
        { className: 'zsp-card', 'data-next': isNext === true },
        h(
          'div',
          { className: 'zsp-row' },
          h('span', { className: 'zsp-dot', 'data-on': account.enabled === true }),
          h('span', { className: 'zsp-name' }, account.nickname),
          h(
            'span',
            { className: 'zsp-muted' },
            `#${account.index} · ${channelLabel(account.channel)} · ID 尾 ${account.userIdTail ?? '??????'}`,
          ),
          limited.map((item) =>
            h(
              'span',
              { key: item.model, className: 'zsp-chip', 'data-limited': 'true' },
              `${item.model} 限额至 ${formatReset(item.resetAt)}`,
            ),
          ),
        ),
        balance === undefined
          ? null
          : balance.ok === true
            ? balance.enterprise === true
              ? h('span', { className: 'zsp-muted' }, '企业版：服务端不下发用量数字')
              : h(
                  React.Fragment,
                  null,
                  h('div', { className: 'zsp-bar' }, h('span', { style: { width: `${percent ?? 0}%` } })),
                  h(
                    'span',
                    { className: 'zsp-muted' },
                    `剩余 ${balance.remaining}/${balance.total}${balance.planName ? ` · ${balance.planName}` : ''}`,
                  ),
                )
            : h('span', { className: 'zsp-error' }, balance.error ?? '余额查询失败'),
        h(
          'div',
          { className: 'zsp-actions' },
          /**
           * 「使用」= 把该账号置顶（手动顺序即选号优先级，`pick()` 取第一个
           * 启用且未限流的账号）；正在使用时显示「使用中」并禁用。
           */
          h(
            'button',
            { className: 'zsp-btn', onClick: onUse, disabled: busy || isNext === true },
            isNext === true ? '使用中' : '使用',
          ),
          confirmId === account.id
            ? h(
                'button',
                {
                  className: 'zsp-btn',
                  'data-danger': 'true',
                  disabled: busy,
                  onClick: () => {
                    setConfirmId(undefined)
                    onRemove()
                  },
                },
                '确认删除？',
              )
            : h(
                'button',
                {
                  className: 'zsp-btn',
                  'data-danger': 'true',
                  disabled: busy,
                  onClick: () => {
                    setConfirmId(account.id)
                    setTimeout(
                      () => setConfirmId((current) => (current === account.id ? undefined : current)),
                      CONFIRM_RESET_MS,
                    )
                  },
                },
                '删除',
              ),
        ),
      )
    }

    /**
     * 「添加账号」区块：渠道选择 → 发起授权 → 展示授权链接 → 轮询直到 ready。
     *
     * 两段式设备授权与 CLI 相同：Host 持 flowSecret，Client 只拿 authorizeUrl
     * 和 flowId，凭据永远不经过页面。
     */
    function AddAccountSection(props) {
      const { busy, onAdded } = props
      const [channel, setChannel] = useState('bigmodel')
      const [phase, setPhase] = useState('idle') // idle | starting | waiting | ready | failed
      const [flow, setFlow] = useState(undefined) // { flowId, authorizeUrl, pollIntervalMs }
      const [message, setMessage] = useState(undefined)
      const [copied, setCopied] = useState(false)
      const timerRef = useRef(undefined)

      useEffect(() => {
        /** 组件卸载/流程结束时停掉轮询定时器。 */
        return () => {
          if (timerRef.current !== undefined) clearTimeout(timerRef.current)
        }
      }, [])

      const stopPolling = useCallback(() => {
        if (timerRef.current !== undefined) {
          clearTimeout(timerRef.current)
          timerRef.current = undefined
        }
      }, [])

      const poll = useCallback(
        (flowId, intervalMs) => {
          timerRef.current = setTimeout(async () => {
            try {
              const outcome = await api('/login/poll', { flowId })
              if (outcome.status === 'pending') {
                poll(flowId, intervalMs)
                return
              }
              if (outcome.status === 'ready') {
                setPhase('ready')
                setMessage(
                  `${outcome.created === false ? '已更新' : '已添加'}账号「${outcome.account?.nickname ?? ''}」`,
                )
                stopPolling()
                if (typeof onAdded === 'function') onAdded()
                return
              }
              setPhase('failed')
              setMessage(outcome.error ?? '授权失败')
            } catch (caught) {
              setPhase('failed')
              setMessage(caught instanceof Error ? caught.message : String(caught))
            }
          }, intervalMs)
        },
        [onAdded, stopPolling],
      )

      const start = useCallback(async () => {
        stopPolling()
        setPhase('starting')
        setMessage(undefined)
        setCopied(false)
        try {
          const started = await api('/login/start', { channel })
          setFlow({ flowId: started.flowId, authorizeUrl: started.authorizeUrl, pollIntervalMs: started.pollIntervalMs ?? 2000 })
          setPhase('waiting')
          setMessage(undefined)
          poll(started.flowId, Math.max(1500, started.pollIntervalMs ?? 2000))
        } catch (caught) {
          setPhase('failed')
          setMessage(caught instanceof Error ? caught.message : String(caught))
        }
      }, [channel, poll, stopPolling])

      const cancel = useCallback(() => {
        stopPolling()
        setPhase('idle')
        setFlow(undefined)
        setMessage(undefined)
      }, [stopPolling])

      const copyLink = useCallback(async () => {
        if (flow?.authorizeUrl === undefined) return
        try {
          await navigator.clipboard.writeText(flow.authorizeUrl)
          setCopied(true)
        } catch {
          setCopied(false)
        }
      }, [flow])

      return h(
        'div',
        { className: 'zsp-add' },
        h(
          'div',
          { className: 'zsp-row' },
          h('span', { className: 'zsp-name' }, '添加账号'),
          h(
            'select',
            {
              className: 'zsp-btn',
              value: channel,
              disabled: busy || phase === 'starting' || phase === 'waiting',
              onChange: (event) => setChannel(event.target.value),
            },
            h('option', { value: 'bigmodel' }, '智谱国内（bigmodel.cn）'),
            h('option', { value: 'zai' }, 'Z.AI 国际（z.ai）'),
          ),
          phase === 'waiting' || phase === 'starting'
            ? h('button', { className: 'zsp-btn', onClick: cancel }, '取消')
            : h(
                'button',
                { className: 'zsp-btn', onClick: () => void start(), disabled: busy },
                phase === 'starting' ? '申请中…' : '发起登录',
              ),
        ),
        phase === 'starting' ? h('span', { className: 'zsp-muted' }, '正在向 ZCode 申请设备授权…') : null,
        phase === 'waiting' && flow !== undefined
          ? h(
              React.Fragment,
              null,
              h(
                'span',
                { className: 'zsp-muted' },
                '① 在浏览器打开授权链接并用对应站点的账号登录授权（链接 10 分钟内有效）：',
              ),
              h('a', { className: 'zsp-link', href: flow.authorizeUrl, target: '_blank', rel: 'noreferrer' }, flow.authorizeUrl),
              h(
                'div',
                { className: 'zsp-row' },
                h('button', { className: 'zsp-btn', onClick: () => void copyLink() }, copied ? '已复制' : '复制链接'),
                h('span', { className: 'zsp-muted' }, '② 授权完成后本面板会自动入池（无需其它操作）。'),
              ),
            )
          : null,
        phase === 'ready' ? h('p', { className: 'zsp-ok' }, message) : null,
        phase === 'failed' ? h('p', { className: 'zsp-error' }, message ?? '授权失败') : null,
      )
    }

    /**
     * 面板主体。
     *
     * ⚠ Hooks 全部先于 `isOurSubject` 早退调用（React hooks 顺序约束）。
     */
    function Panel(props) {
      const [data, setData] = useState(undefined)
      const [error, setError] = useState(undefined)
      const [balances, setBalances] = useState({})
      const [busy, setBusy] = useState(false)
      const [confirmId, setConfirmId] = useState(undefined)

      /**
       * 统一刷新：/summary 已带每账号余额；个别账号缺失（拉取失败/新入池）
       * 时再逐个补拉，不再单设「刷新余额」按钮。
       */
      const load = useCallback(async () => {
        try {
          const summary = await api('/summary')
          setData(summary)
          const seeded = {}
          const missing = []
          for (const item of Array.isArray(summary?.accounts) ? summary.accounts : []) {
            if (item.balance !== null && item.balance !== undefined) {
              seeded[item.id] = { ok: true, ...item.balance }
            } else if (item.enabled === true) {
              missing.push(item.id)
            }
          }
          if (missing.length > 0) {
            const extra = await Promise.all(
              missing.map(async (id) => {
                try {
                  const result = await api(`/balance?id=${encodeURIComponent(id)}`)
                  return [
                    id,
                    result.balance === null || result.balance === undefined
                      ? { ok: false, error: typeof result.error === 'string' ? result.error : '余额不可用' }
                      : { ok: true, ...result.balance },
                  ]
                } catch (caught) {
                  return [id, { ok: false, error: caught instanceof Error ? caught.message : String(caught) }]
                }
              }),
            )
            for (const [id, value] of extra) seeded[id] = value
          }
          setBalances(seeded)
          setError(undefined)
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : String(caught))
        }
      }, [])

      useEffect(() => {
        void load()
      }, [load])

      const act = useCallback(
        async (path, body) => {
          setBusy(true)
          try {
            await api(path, body)
            await load()
            setError(undefined)
          } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught))
          } finally {
            setBusy(false)
          }
        },
        [load],
      )

      if (!isOurSubject(props && props.subject)) return null

      const accounts = data !== undefined && Array.isArray(data.accounts) ? data.accounts : undefined
      /** 「按序下一个」= 列表里第一个启用的账号（pool.pick 的取号规则）。 */
      const nextAccount = accounts !== undefined ? accounts.find((account) => account.enabled === true) : undefined

      return h(
        'section',
        { className: 'zsp-panel' },
        h('style', null, CSS),
        h(
          'div',
          { className: 'zsp-head' },
          h('h3', { className: 'zsp-title' }, '账号池管理'),
          data !== undefined
            ? h(
                'span',
                { className: 'zsp-muted' },
                `${[data.displayName ?? data.provider, `${accounts.length} 个账号`].filter(Boolean).join(' · ')}`,
              )
            : null,
          h('span', { className: 'zsp-spacer' }),
          h('button', { className: 'zsp-btn', onClick: () => void load(), disabled: busy }, '刷新'),
        ),
        error !== undefined ? h('p', { className: 'zsp-error' }, error) : null,
        data === undefined && error === undefined ? h('span', { className: 'zsp-muted' }, '加载中…') : null,
        h(AddAccountSection, { busy, onAdded: () => void load() }),
        accounts !== undefined && accounts.length === 0
          ? h('span', { className: 'zsp-muted' }, '账号池为空：用上方「添加账号」登录，或在插件目录运行 node bin/cli.mjs login。')
          : null,
        accounts !== undefined
          ? accounts.map((account) =>
              h(AccountCard, {
                key: account.id,
                account,
                balance: balances[account.id],
                busy,
                isNext: nextAccount !== undefined && nextAccount.id === account.id,
                confirmId,
                setConfirmId,
                onUse: () => void act('/use', { id: account.id }),
                onRemove: () => void act('/remove', { id: account.id }),
              }),
            )
          : null,
        data !== undefined && data.storeInMemory === true
          ? h(
              'span',
              { className: 'zsp-muted' },
              '⚠ 账号库当前是内存库（数据目录不可写），重启后账号会消失。',
            )
          : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject(SLOT, () =>
          ctx.slots.register({ name: SLOT, id: 'zcode-start-plan-accounts', order: 50 }, Panel),
        )
      },
    }
  },
})
