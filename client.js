/**
 * Client 模块：官方插件详情页（Plugin Manager → ZCode Start Plan）里的
 * 「账号池管理」面板。
 *
 * ## 挂载点（照抄 dsh-workbuddy-connect 的实证写法）
 *
 * `plugins.bundle.config` 是官方插件页按**包名 key 派发**的配置区块座位，
 * 渲染在详情页「包含的组件」列表上方；宿主只在本包的详情页派发
 * `key === 'dsh-zcode-startplan'` 的条目，列表页则以 `view === 'summary'`
 * 请求一行简介。组件无需自己做 subject 过滤。
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
  id: 'dsh-zcode-startplan',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const SLOT = 'plugins.bundle.config'
    /** 宿主按包名派发此座位（workbuddy 实证：key 必须与安装的包名一字不差）。 */
    const BUNDLE_KEY = 'dsh-zcode-startplan'
    const API = '/api/zcode-start-plan'
    const CONFIRM_RESET_MS = 3000

    const CSS = `
      .zsp-panel{display:flex;flex-direction:column;gap:10px;width:100%;min-width:0;color:var(--dsw-alias-label-primary);font-size:12.5px;line-height:18px}
      .zsp-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
      .zsp-title{margin:0;font-size:13px;font-weight:600;line-height:20px}
      .zsp-muted{color:var(--dsw-alias-label-tertiary);font-size:12px;word-break:break-word;min-width:0}
      .zsp-spacer{flex:1}
      .zsp-btn{font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm,6px);color:var(--dsw-alias-label-primary);background:transparent;padding:3px 10px;font-size:12px;line-height:18px;flex:none}
      .zsp-btn:hover:enabled{background:var(--dsw-alias-interactive-bg-hover)}
      .zsp-btn:disabled{cursor:default;opacity:.55}
      .zsp-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
      .zsp-btn[data-danger=true]{color:var(--dsw-alias-label-danger)}
      .zsp-error{color:var(--dsw-alias-label-danger);margin:0;font-size:12px;word-break:break-word}
      .zsp-ok{color:var(--dsw-alias-state-success-primary);font-size:12px;word-break:break-word;margin:0}
      .zsp-card{display:flex;flex-direction:column;gap:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:8px;padding:10px 12px;min-width:0}
      .zsp-card[data-next=true]{border-color:var(--dsw-alias-state-business-primary)}
      .zsp-card[data-hidden=true]{opacity:.62}
      .zsp-group{display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:10px 12px;min-width:0}
      .zsp-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0}
      .zsp-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-tertiary);flex:none}
      .zsp-dot[data-on=true]{background:var(--dsw-alias-state-success-primary)}
      .zsp-name{font-weight:600}
      .zsp-name-edit{font:inherit;font-weight:600;color:inherit;background:transparent;border:0;padding:0;cursor:text;text-align:left}
      .zsp-name-edit:hover:enabled{text-decoration:underline dotted var(--dsw-alias-label-tertiary)}
      .zsp-name-edit:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
      .zsp-name-input{font:inherit;font-weight:600;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-state-business-primary);border-radius:4px;padding:1px 6px;width:180px;max-width:100%}
      .zsp-name-input:focus-visible{outline:none}
      .zsp-chip{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:1px 8px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
      .zsp-chip[data-limited=true]{color:var(--dsw-alias-label-danger);border-color:var(--dsw-alias-label-danger)}
      .zsp-bar{height:6px;border-radius:3px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;width:100%}
      .zsp-bar>span{display:block;height:100%;background:var(--dsw-alias-state-business-primary)}
      .zsp-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:2px}
      .zsp-add{display:flex;flex-direction:column;gap:8px;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;padding:10px 12px;min-width:0}
      .zsp-link{color:var(--dsw-alias-state-business-primary);word-break:break-all}
      .zsp-select{position:relative;display:inline-flex;min-width:0}
      .zsp-select-trigger{display:inline-flex;align-items:center;gap:8px;font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm,6px);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);padding:4px 10px;font-size:12px;line-height:18px;min-width:0}
      .zsp-select-trigger:hover{background:var(--dsw-alias-interactive-bg-hover)}
      .zsp-select-trigger:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
      .zsp-select-trigger[aria-expanded=true]{border-color:var(--dsw-alias-state-business-primary)}
      .zsp-select-label{font-weight:600;white-space:nowrap}
      .zsp-select-desc{color:var(--dsw-alias-label-tertiary);font-size:11px;white-space:nowrap}
      .zsp-caret{flex:none;width:0;height:0;border-left:4px solid transparent;border-right:4px solid transparent;border-top:5px solid var(--dsw-alias-label-tertiary);transition:transform .15s ease}
      .zsp-select-trigger[aria-expanded=true] .zsp-caret{transform:rotate(180deg)}
      .zsp-select-menu{position:absolute;top:calc(100% + 4px);left:0;z-index:30;display:flex;flex-direction:column;gap:2px;min-width:100%;max-height:260px;overflow:auto;padding:4px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);box-shadow:0 8px 24px rgb(0 0 0 / 18%);animation:zsp-pop .14s ease}
      @keyframes zsp-pop{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:none}}
      .zsp-option{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;cursor:pointer;color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;border:0;background:transparent;text-align:left;width:100%}
      .zsp-option:hover,.zsp-option[data-active=true]{background:var(--dsw-alias-interactive-bg-hover)}
      .zsp-option[aria-selected=true]{background:var(--dsw-alias-interactive-bg-selected,var(--dsw-alias-interactive-bg-hover))}
      .zsp-option-check{flex:none;color:var(--dsw-alias-state-business-primary);font-size:12px;visibility:hidden}
      .zsp-option[aria-selected=true] .zsp-option-check{visibility:visible}
      .zsp-option-text{display:flex;flex-direction:column;min-width:0}
      .zsp-badge{flex:none;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:5px;font-size:10px;font-weight:700;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
      .zsp-toggle-row{margin-left:auto;display:inline-flex;align-items:center;gap:6px;flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px}
      /**
       * 三颗开关同列（不贴边）：卡片开关留在卡片内的自然位置（距卡片边框
       * 12px，缩进 1+12+1+12=26px）；统一行比卡片少一层卡片边框+内边距
       * （13px），补 13px 内边距对齐到同一条竖线。
       */
      .zsp-unified{padding-right:13px}
      .zsp-toggle{position:relative;display:inline-block;flex:none;width:30px;height:17px;margin-left:auto}
      .zsp-toggle input{position:absolute;opacity:0;width:100%;height:100%;margin:0;cursor:pointer}
      .zsp-toggle-track{position:absolute;inset:0;border-radius:999px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);transition:background .15s ease,border-color .15s ease;pointer-events:none}
      .zsp-toggle-track::after{content:'';position:absolute;top:1px;left:1px;width:13px;height:13px;border-radius:50%;background:var(--dsw-alias-label-primary);transition:transform .15s ease}
      .zsp-toggle input:checked + .zsp-toggle-track{background:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary)}
      .zsp-toggle input:checked + .zsp-toggle-track::after{transform:translateX(13px);background:#fff}
      .zsp-toggle input:focus-visible + .zsp-toggle-track{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
      .zsp-toggle input:disabled{cursor:default}
      .zsp-toggle input:disabled + .zsp-toggle-track{opacity:.5}
      @media (max-width: 520px){
        .zsp-head{gap:6px}
        .zsp-title{font-size:12.5px}
        .zsp-card{padding:8px 10px}
        .zsp-add{padding:8px 10px}
        .zsp-actions{gap:4px}
      }
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

    /**
     * 开关（iOS 风格）：「模型列表里显示这一栏」的每栏右侧开关。
     * checked = 显示；原生 checkbox 保证可访问性（键盘/读屏）。
     */
    function Toggle(props) {
      const { checked, disabled, onChange } = props
      return h(
        'label',
        { className: 'zsp-toggle' },
        h('input', {
          type: 'checkbox',
          checked: checked === true,
          disabled,
          'aria-label': '在模型列表中显示这一栏',
          onChange: (event) => onChange(event.target.checked),
        }),
        h('span', { className: 'zsp-toggle-track', 'aria-hidden': 'true' }),
      )
    }

    /** 渠道显示名：直接用官方 provider id（zai / bigmodel），不做本地化称呼。 */
    function channelLabel(channel) {
      if (channel === 'zai') return 'zai'
      if (channel === 'bigmodel') return 'bigmodel'
      return channel === null || channel === undefined ? 'bigmodel' : String(channel)
    }

    function formatReset(resetAt) {
      const ms = Number(resetAt)
      if (!Number.isFinite(ms) || ms <= 0) return ''
      return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }

    /**
     * 卡片标题行的可编辑昵称：点一下变输入框，Enter 提交 / Esc 或失焦取消。
     * 什么都不填直接失焦 = 不改名。
     */
    function NicknameEdit(props) {
      const { nickname, busy, onCommit } = props
      const [editing, setEditing] = useState(false)
      const [draft, setDraft] = useState(nickname)
      const inputRef = useRef(undefined)

      useEffect(() => {
        if (editing === true) {
          setDraft(nickname)
          /** 进入编辑态后自动聚焦并全选，方便整段替换。 */
          inputRef.current?.focus()
          inputRef.current?.select()
        }
      }, [editing, nickname])

      if (editing !== true) {
        return h(
          'button',
          {
            type: 'button',
            className: 'zsp-name zsp-name-edit',
            title: '点击重命名',
            disabled: busy,
            onClick: () => setEditing(true),
          },
          nickname,
        )
      }
      return h('input', {
        ref: inputRef,
        className: 'zsp-name-input',
        value: draft,
        disabled: busy,
        maxLength: 40,
        'aria-label': '账号备注',
        onChange: (event) => setDraft(event.target.value),
        onKeyDown: (event) => {
          if (event.key === 'Enter') {
            const next = draft.trim()
            if (next.length > 0 && next !== nickname) onCommit(next)
            setEditing(false)
          } else if (event.key === 'Escape') {
            setEditing(false)
          }
        },
        onBlur: () => setEditing(false),
      })
    }

    /**
     * 单个账号卡片：状态点、可编辑昵称、渠道、限流 chips、余额条、操作按钮。
     * 按钮只有两个：「使用」（置顶，下次请求即用它）与「删除」。
     */
    function AccountCard(props) {
      const { account, balance, busy, isNext, modelListVisible, onToggleModelList, confirmId, setConfirmId, onUse, onRemove, onRename } = props
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
        { className: 'zsp-card', 'data-next': isNext === true, 'data-hidden': modelListVisible === false },
        h(
          'div',
          { className: 'zsp-row' },
          h('span', { className: 'zsp-dot', 'data-on': account.enabled === true }),
          h(NicknameEdit, {
            nickname: account.nickname,
            busy,
            onCommit: (next) => onRename(next),
          }),
          h(
            'span',
            { className: 'zsp-muted' },
            `#${account.index} · ${channelLabel(account.channel)}`,
          ),
          limited.map((item) =>
            h(
              'span',
              { key: item.model, className: 'zsp-chip', 'data-limited': 'true' },
              `${item.model} 限额至 ${formatReset(item.resetAt)}`,
            ),
          ),
          /** 每栏最右侧的开关：负 margin 拉出卡片缩进，与统一行的开关同列。 */
          h(Toggle, {
            checked: modelListVisible === true,
            disabled: busy,
            onChange: (next) => onToggleModelList(next),
          }),
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
     * 渠道选项（登录渠道与 lib/upstream-api.js 的 LOGIN_CHANNELS 对齐）。
     */
    const CHANNEL_OPTIONS = [
      { value: 'bigmodel', label: 'bigmodel', desc: '智谱开放平台 · bigmodel.cn', badge: '智' },
      { value: 'zai', label: 'zai', desc: 'Z.AI · z.ai', badge: 'Z' },
    ]

    /**
     * 现代化下拉（零依赖手写）：渠道徽标 + 两行选项 + hover 高亮 +
     * 点击外部关闭；不做键盘导航（用不到，从简）。
     */
    function ChannelSelect(props) {
      const { value, onChange, disabled } = props
      const [open, setOpen] = useState(false)
      const rootRef = useRef(undefined)

      const selected = CHANNEL_OPTIONS.find((item) => item.value === value) ?? CHANNEL_OPTIONS[0]

      useEffect(() => {
        if (open !== true) return undefined
        const onPointerDown = (event) => {
          if (rootRef.current !== undefined && !rootRef.current.contains(event.target)) setOpen(false)
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        return () => document.removeEventListener('pointerdown', onPointerDown, true)
      }, [open])

      const commit = useCallback(
        (nextValue) => {
          if (!CHANNEL_OPTIONS.some((item) => item.value === nextValue)) return
          onChange(nextValue)
          setOpen(false)
        },
        [onChange],
      )

      const onKeyDown = useCallback(
        (event) => {
          /** 键盘只保留 Esc 关闭（一般用不到键盘选渠道，从简）。 */
          if (event.key === 'Escape') setOpen(false)
          else if (event.key === 'Tab') setOpen(false)
        },
        [],
      )

      return h(
        'div',
        { className: 'zsp-select', ref: rootRef, onKeyDown },
        h(
          'button',
          {
            type: 'button',
            className: 'zsp-select-trigger',
            'aria-haspopup': 'listbox',
            'aria-expanded': open === true,
            disabled,
            onClick: () => setOpen((current) => !current),
          },
          h('span', { className: 'zsp-badge' }, selected.badge),
          h('span', { className: 'zsp-select-label' }, selected.label),
          h('span', { className: 'zsp-select-desc' }, selected.desc),
          h('span', { className: 'zsp-caret', 'aria-hidden': 'true' }),
        ),
        open === true
          ? h(
              'div',
              { className: 'zsp-select-menu', role: 'listbox', 'aria-label': '登录渠道' },
              CHANNEL_OPTIONS.map((option) =>
                h(
                  'button',
                  {
                    key: option.value,
                    type: 'button',
                    role: 'option',
                    className: 'zsp-option',
                    'aria-selected': option.value === value,
                    onClick: () => commit(option.value),
                  },
                  h('span', { className: 'zsp-badge' }, option.badge),
                  h(
                    'span',
                    { className: 'zsp-option-text' },
                    h('span', null, option.label),
                    h('span', { className: 'zsp-select-desc' }, option.desc),
                  ),
                  h('span', { className: 'zsp-option-check', 'aria-hidden': 'true' }, '✓'),
                ),
              ),
            )
          : null,
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
          h(ChannelSelect, {
            value: channel,
            onChange: setChannel,
            disabled: busy || phase === 'starting' || phase === 'waiting',
          }),
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
     * 宿主以两种 view 调用（workbuddy 实证）：
     * - `view === 'summary'`：插件列表页的一行简介，返回纯文本；
     * - 其余：详情页完整面板。
     *
     * ⚠ Hooks 全部先于 summary 早退调用（React hooks 顺序约束）。
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

      /** 插件列表页的摘要视图：一行文本，不发起请求。 */
      if ((props || {}).view === 'summary') {
        return '管理 ZCode 赠送免费 plan 的账号池：每账号一个模型栏位（各吃各的额度）、统一选号开关、余额与限流、面板内登录添加账号（bigmodel / z.ai）。'
      }

      const accounts = data !== undefined && Array.isArray(data.accounts) ? data.accounts : undefined
      /** 「按序下一个」= 列表里第一个启用的账号（pool.pick 的取号规则）。 */
      const nextAccount = accounts !== undefined ? accounts.find((account) => account.enabled === true) : undefined
      /** 统一选号栏位当前是否显示（关掉 = 模型列表只留每账号一栏）。 */
      const unifiedVisible = data?.unifiedModelList !== false

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
        /**
         * 账号区方块：最顶一行是「统一选号」+ 贴方块右上角的开关，
         * 下面是各账号卡片 —— 面板顺序 = 模型选择器顺序。
         */
        h(
          'div',
          { className: 'zsp-group' },
          h(
            'div',
            { className: 'zsp-row zsp-unified' },
            h('span', { className: 'zsp-dot', 'data-on': unifiedVisible === true }),
            h('span', { className: 'zsp-name' }, '统一选号'),
            h(
              'span',
              { className: 'zsp-toggle-row' },
              h(Toggle, {
                checked: unifiedVisible === true,
                disabled: busy,
                onChange: (visible) => void act('/unified-list', { visible }),
              }),
            ),
          ),
          accounts !== undefined
            ? accounts.map((account) =>
                h(AccountCard, {
                  key: account.id,
                  account,
                  balance: balances[account.id],
                  busy,
                  isNext: nextAccount !== undefined && nextAccount.id === account.id,
                  modelListVisible: account.modelListVisible !== false,
                  onToggleModelList: (visible) => void act('/model-list-visible', { id: account.id, visible }),
                  confirmId,
                  setConfirmId,
                  onUse: () => void act('/use', { id: account.id }),
                  onRemove: () => void act('/remove', { id: account.id }),
                  onRename: (nickname) => void act('/rename', { id: account.id, nickname }),
                }),
              )
            : null,
        ),
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
          /** key = 包名：宿主只在 dsh-zcode-startplan 的详情页派发本条目。 */
          ctx.slots.register({ name: SLOT, key: BUNDLE_KEY }, Panel),
        )
      },
    }
  },
})
