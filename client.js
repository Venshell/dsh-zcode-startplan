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
      /* 探测到的 plan_id：只读展示（没有手输路径，见 ClaimSection 渲染处注释）。 */
      .zsp-plan-id{font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border-radius:4px;padding:1px 6px;user-select:all}
      /* 重启指引块：说明 + 可复制的启动命令。 */
      .zsp-restart-guide{display:flex;flex-direction:column;gap:4px;min-width:0}
      .zsp-restart-guide .zsp-plan-id{font-size:12px;line-height:20px;align-self:flex-start;max-width:100%;white-space:pre-wrap;word-break:break-all}
      .zsp-chip[data-limited=true]{color:var(--dsw-alias-label-danger);border-color:var(--dsw-alias-label-danger)}
      .zsp-bar{height:6px;border-radius:3px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;width:100%}
      .zsp-bar>span{display:block;height:100%;background:var(--dsw-alias-state-business-primary)}
      /**
       * 未生效额度：同一条进度条，但**用条纹 + 半透明**区分「还没到点的钱」，
       * 避免与已生效的满格条混淆（满格实色 = 现在就能用）。
       */
      .zsp-meter{display:flex;flex-direction:column;gap:4px;min-width:0}
      .zsp-meter-caption{margin:0}
      .zsp-bar[data-pending=true]{background:repeating-linear-gradient(45deg,var(--dsw-alias-bg-layer-2) 0 4px,var(--dsw-alias-border-l1) 4px 8px)}
      .zsp-bar[data-pending=true]>span{background:var(--dsw-alias-state-business-primary);opacity:.45}
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
     * `label` 覆盖 aria-label（自动领取拨盘用它，不然读屏会念成「模型列表」）。
     */
    function Toggle(props) {
      const { checked, disabled, onChange, label } = props
      return h(
        'label',
        { className: 'zsp-toggle' },
        h('input', {
          type: 'checkbox',
          checked: checked === true,
          disabled,
          'aria-label': label ?? '在模型列表中显示这一栏',
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
     * 未生效额度的到点时间：跨天要带日期（「明天 23:00」看不出来是哪天），
     * 今天内只显示时刻，与限额 chips 的风格一致。
     */
    function formatEffective(effectiveAt) {
      const ms = Number(effectiveAt)
      if (!Number.isFinite(ms) || ms <= 0) return ''
      const date = new Date(ms)
      const today = new Date()
      const sameDay =
        date.getFullYear() === today.getFullYear() &&
        date.getMonth() === today.getMonth() &&
        date.getDate() === today.getDate()
      return sameDay
        ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : date.toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    }

    /** 未生效额度的可读文案：`GLM-5.3-Flash 3亿 tokens` 之类。 */
    function formatPendingUnits(pending) {
      const units = Number(pending?.grantUnits)
      if (!Number.isFinite(units) || units <= 0) return ''
      if (units >= 100_000_000) return `${(units / 100_000_000).toFixed(units % 100_000_000 === 0 ? 0 : 1)}亿`
      if (units >= 10_000) return `${Math.round(units / 10_000)}万`
      return String(units)
    }

    /**
     * 还多久到期，如「3 小时后」「12 分钟后」「2 天后」「已过期」。
     *
     * 为什么还要给相对时长：额度按自然日结算，看到的永远是「今天 23:59」这种
     * 绝对时间，用户得心算「那还剩多久」。两者并排给，判断成本最低。
     */
    function formatRemaining(expiresAt, now = Date.now()) {
      const ms = Number(expiresAt)
      if (!Number.isFinite(ms) || ms <= 0) return ''
      const diff = ms - now
      if (diff <= 0) return '已过期'
      const minutes = Math.floor(diff / 60_000)
      if (minutes < 1) return '不到 1 分钟'
      if (minutes < 60) return `${minutes} 分钟后`
      const hours = Math.floor(minutes / 60)
      if (hours < 24) {
        const restMinutes = minutes % 60
        return restMinutes === 0 ? `${hours} 小时后` : `${hours} 小时 ${restMinutes} 分后`
      }
      const days = Math.floor(hours / 24)
      const restHours = hours % 24
      return restHours === 0 ? `${days} 天后` : `${days} 天 ${restHours} 小时后`
    }

    /**
     * 一条额度进度条（已生效 / 未生效共用同一形状）。
     *
     * 为什么共用一个组件：两种额度对用户是**同一件事的两种时态**——
     * 已生效的现在就能用，未生效的到点就能用。形状一致，差别只在
     * 条纹（`data-pending`）与底部那句提示。
     *
     * `remaining`/`total` 缺失时（未生效的只有 `grantUnits`）按满格画：
     * 尚未启用的额度必然是 100% 剩余。
     */
    function QuotaMeter(props) {
      const { remaining, total, planName, pending, effectiveAt, expiresAt } = props
      const percent = pending === true
        ? 100
        : typeof total === 'number' && total > 0 && typeof remaining === 'number'
          ? Math.max(0, Math.min(100, Math.round((remaining / total) * 100)))
          : 0
      /**
       * 底部一句话：已生效 = 剩余 + 计划名 + 到期；未生效 = 何时启用 + 何时作废。
       * 到期信息缺失（上游没给 / 已用光）时整段不出现，不留「undefined」。
       */
      const effectiveLabel = effectiveAt ? `${formatEffective(effectiveAt)} 起可用` : '待生效'
      const expireLabel = expiresAt
        ? `${formatEffective(expiresAt)} 到期（${formatRemaining(expiresAt)}）`
        : ''
      return h(
        'div',
        { className: 'zsp-meter' },
        h(
          'div',
          { className: 'zsp-bar', 'data-pending': pending === true },
          h('span', { style: { width: `${percent}%` } }),
        ),
        h(
          'span',
          { className: 'zsp-muted zsp-meter-caption' },
          pending === true
            ? `${effectiveLabel}${expireLabel ? ` · ${expireLabel}` : ''}`
            : `剩余 ${remaining}/${total}${planName ? ` · ${planName}` : ''}${expireLabel ? ` · ${expireLabel}` : ''}`,
        ),
      )
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
     * 赠送额度领取区（面板底部）。
     *
     * ## 为什么不是「先查列表再点领取」
     *
     * 2026-10-28 分析官方 ZCode 客户端日志（2962 次 RPC）得出：
     *
     * | RPC | 全天调用次数 |
     * |---|---|
     * | `coding-plan-subscription.getManualClaimPlanPreviews`（`/billing/preview`） | **0** |
     * | `coding-plan-subscription.claimManualPlan`（`/billing/claim`） | 1（用户点击时） |
     *
     * 官方客户端**从不预判有没有活动**：它直接发 claim，用服务端返回的
     * `code`/`msg` 告诉用户结果。我们此前的「先查 preview，有才显示按钮」
     * 导致面板永远显示「暂无可领取」——因为 preview 恒空，而活动实际存在。
     *
     * 故改为**忠实执行 + 忠实报告**：填 `planId` 直接领，业务码原样显示
     * （`0` 成功 / `1003` 已领过 / `1005` 领完）。「有没有名额」由服务端裁决。
     *
     * ⚠ captcha 失败会原地重试一次（官方日志实证：一次点击里
     * `send_preflight outcome=error` → 6 秒后 `outcome=success`，因为阿里云
     * CDN 首轮抖动是常态）。这里是「按两次才领到」的服务端侧对策。
     */
    function ClaimSection(props) {
      const { accounts, busy, onClaimed, captcha, autoClaim, onToggleAutoClaim } = props
      /** accountId → { planId, loading, results, error } */
      const [state, setState] = useState({})
      const [open, setOpen] = useState(false)
      const [restarting, setRestarting] = useState(false)
      const [togglingAuto, setTogglingAuto] = useState(false)

      const patch = (id, next) => setState((prev) => ({ ...prev, [id]: { ...prev[id], ...next } }))

      const claim = useCallback(
        async (id) => {
          /** plan_id 只来自探测结果 —— 没有手输路径（见渲染处注释）。 */
          const planId = state[id]?.plans?.[0]?.planId
          if (typeof planId !== 'string' || planId.length === 0) {
            patch(id, { error: '当前没有探测到可领取的活动' })
            return
          }
          patch(id, { loading: true, error: undefined, results: undefined })
          try {
            const data = await api('/claim', { id, planId })
            patch(id, { loading: false, results: Array.isArray(data.results) ? data.results : [] })
            /** 领取会改变余额（或生成 pending），刷新面板让进度条同步。 */
            if (typeof onClaimed === 'function') await onClaimed()
          } catch (caught) {
            patch(id, { loading: false, error: caught instanceof Error ? caught.message : String(caught) })
          }
        },
        [onClaimed, state],
      )

      /**
       * 探测活动：调 /claimable（官方 marketing/touch 发现端点，GET、零 captcha）。
       * **自动执行**（展开即探），结果存进 state 供渲染与领取使用。
       */
      const probe = useCallback(
        async (id) => {
          patch(id, { probing: true, error: undefined, results: undefined })
          try {
            /** /claimable 是 GET（id 走 query），不走 POST 版 api() 助手。 */
            const response = await fetch(`${API}/claimable?id=${encodeURIComponent(id)}`)
            const data = await response.json().catch(() => ({}))
            if (!response.ok) throw new Error(typeof data?.error === 'string' ? data.error : `HTTP ${response.status}`)
            const plans = Array.isArray(data.plans) ? data.plans : []
            patch(id, {
              probing: false,
              plans,
              ...(plans.length === 0 ? { error: data.error ?? '当前没有探测到可领取的活动' } : {}),
            })
          } catch (caught) {
            patch(id, { probing: false, plans: [], error: caught instanceof Error ? caught.message : String(caught) })
          }
        },
        [],
      )

      /**
       * 展开时自动探测一次（探测零成本：GET、不烧 captcha）。
       * ⚠ effect 依赖 `open` 与 `accounts`；已探测过的账号跳过，避免反复请求投放端点。
       */
      useEffect(() => {
        if (open !== true) return
        for (const account of accounts) {
          if (state[account.id] !== undefined) continue
          void probe(account.id)
        }
      }, [open, accounts, probe, state])

      /** 自动领取开关（拨盘）：写入宿主 settings，重启后保持。 */
      const toggleAutoClaim = useCallback(async () => {
        if (typeof onToggleAutoClaim !== 'function') return
        setTogglingAuto(true)
        try {
          await onToggleAutoClaim(autoClaim?.enabled !== true)
        } finally {
          setTogglingAuto(false)
        }
      }, [autoClaim, onToggleAutoClaim])

      /**
       * ⚠ 所有 hooks 必须在任何早退之前调用。
       * 0.5.0 曾把 useCallback 放在 `return null` 之后 → 两次渲染 hook 数不一致
       * → React 抛 Rendered fewer hooks than expected → 整个面板白屏。
       *
       * 0.6.6 起「重启」改为**取指引**：端点不再替用户执行（杀进程 + 计划任务
       * 被火绒判毒，且宿主 Job Object 会连带杀死脚本），只返回用户可复制的
       * 启动命令。这里拿到后展示出来，让用户自己完成重启。
       *
       * @param {'plain' | 'debug'} mode `debug` 才带 `--remote-debugging-port`。
       */
      const restart = useCallback(async (mode = 'debug') => {
        setRestarting(true)
        try {
          const debugPort = mode === 'debug' ? captcha?.debugPort ?? 9229 : undefined
          const data = await api('/restart-cdp', { ...(debugPort !== undefined ? { debugPort } : {}) })
          setState((prev) => ({
            ...prev,
            __restart: data?.command ?? '未拿到重启指引（请查看插件日志）',
            __restartNote: data?.note,
          }))
        } catch (caught) {
          setState((prev) => ({ ...prev, __restart: `获取指引失败：${caught instanceof Error ? caught.message : String(caught)}` }))
        } finally {
          setRestarting(false)
        }
      }, [captcha])

      if (!Array.isArray(accounts) || accounts.length === 0) return null

      const captchaReachable = captcha !== undefined && captcha.reachable === true
      const captchaReason = captcha?.reason

      return h(
        'div',
        { className: 'zsp-group' },
        h(
          'div',
          { className: 'zsp-row' },
          h('span', { className: 'zsp-name' }, '赠送额度'),
          h(
            'span',
            { className: 'zsp-muted' },
            captchaReachable
              ? '展开即自动探测活动（零 captcha），领取才需要 captcha'
              : '展开即自动探测活动；日常调用模型不受影响，只有领取需要 captcha',
          ),
          h('span', { className: 'zsp-spacer' }),
          /**
           * ⚠ 两件事别混成一件：
           * - **重载插件**：任何模式下重启都行，与 `--remote-debugging-port` 无关；
           * - **开调试端口**：只为 captcha 载体。
           *
           * 0.6.6 起按钮只做「取指引」：点击后展示可复制的启动命令，由**用户**
           * 自己退出并重开 —— 插件不再杀进程（杀进程 + 计划任务被火绒判毒，
           * 且宿主 Job Object 会连带杀死执行脚本）。
           */
          captchaReachable
            ? h(
                'button',
                {
                  className: 'zsp-btn',
                  onClick: () => void restart('plain'),
                  disabled: busy || restarting,
                  title: '生成普通重启指引（重载插件，不带调试端口）',
                },
                restarting ? '获取中…' : '重启指引',
              )
            : h(
                'button',
                {
                  className: 'zsp-btn',
                  onClick: () => void restart('debug'),
                  disabled: busy || restarting,
                  title:
                    `${captchaReason ?? '需要调试端口才能产出 captcha'}。` +
                    '点击获取带调试端口的启动命令（由你手动执行）。',
                },
                restarting ? '获取中…' : '开调试端口重启',
              ),
          h(
            'button',
            { className: 'zsp-btn', onClick: () => setOpen((prev) => !prev), disabled: busy },
            open ? '收起' : '领取',
          ),
        ),
        /**
         * 自动领取拨盘：**说明在左、开关在右**（与其他行的「标签 … 控件」同构）。
         * ⚠ 顺序不能反过来：右对齐是一列，开关放左边会与上面的按钮错位。
         */
        h(
          'div',
          { className: 'zsp-row', style: { alignItems: 'center' } },
          h(
            'span',
            { className: 'zsp-muted', style: { flex: '1 1 auto', minWidth: 0 } },
            autoClaim?.enabled === true
              ? `自动领取已开启：定时探测，发现新活动自动领取${
                  Number.isFinite(autoClaim?.seenCount) && autoClaim.seenCount > 0
                    ? `（已记录 ${autoClaim.seenCount} 个，不会重复领）`
                    : ''
                }`
              : '自动领取已关闭：探测仍然自动，领取需手动点',
          ),
          h(Toggle, {
            checked: autoClaim?.enabled === true,
            disabled: busy || togglingAuto,
            onChange: () => void toggleAutoClaim(),
            label: '自动领取',
          }),
        ),
        state.__restart !== undefined
          ? h(
              'div',
              { className: 'zsp-restart-guide' },
              h('div', { className: 'zsp-muted' }, state.__restartNote ?? '请手动完成重启：'),
              /** 命令用 code 块展示（user-select:all，点一下全选，方便复制）。 */
              h('code', { className: 'zsp-plan-id' }, state.__restart),
            )
          : null,
        open
          ? accounts.map((account) => {
              const slot = state[account.id] ?? {}
              /**
               * ⚠ 这里**没有 plan_id 输入框**：探测是自动的（展开即探），
               * plan_id 只作为**只读**标识展示。手工粘贴活动 id 的路径已移除 ——
               * 它只会让人填错、填过期的 id，然后白烧一次 captcha。
               */
              const plans = Array.isArray(slot.plans) ? slot.plans : []
              const planId = plans[0]?.planId
              return h(
                'div',
                { key: account.id, className: 'zsp-row', style: { alignItems: 'flex-start' } },
                h('span', { className: 'zsp-muted', style: { minWidth: '96px' } }, `#${account.index} ${account.nickname}`),
                h(
                  'div',
                  { className: 'zsp-meter', style: { flex: '1 1 auto' } },
                  h('code', { className: 'zsp-plan-id' }, planId ?? '—'),
                  slot.probing === true
                    ? h('span', { className: 'zsp-muted' }, '探测中…')
                    : plans.length > 1
                      ? h('span', { className: 'zsp-muted' }, `等 ${plans.length} 个活动`)
                      : null,
                  slot.loading === true
                    ? h('span', { className: 'zsp-muted' }, '领取中…（captcha 失败会自动重试一次）')
                    : slot.error !== undefined
                      ? h('span', { className: 'zsp-error' }, slot.error)
                      : slot.results !== undefined
                        ? h(
                            'span',
                            { className: 'zsp-muted' },
                            slot.results
                              .map((item) => {
                                /** 忠实回传服务端裁决，不做含糊翻译。 */
                                if (item.ok === true) {
                                  return `✓ 领取成功${item.alreadyClaimed === true ? '（此前已领过，幂等）' : ''}`
                                }
                                const code = item.code !== undefined ? `code ${item.code}` : `HTTP ${item.httpStatus}`
                                return `✗ ${code}：${item.message ?? item.error ?? '未知原因'}`
                              })
                              .join('；'),
                          )
                        : null,
                ),
                h(
                  'div',
                  { className: 'zsp-actions', style: { marginTop: 0 } },
                  h(
                    'button',
                    {
                      className: 'zsp-btn',
                      onClick: () => void claim(account.id),
                      disabled: busy || slot.loading === true || slot.probing === true || planId === undefined,
                      title: planId === undefined ? '当前没有探测到可领取的活动' : `领取 ${planId}`,
                    },
                    slot.loading === true ? '领取中…' : '领取',
                  ),
                ),
              )
            })
          : null,
      )
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
                  /**
                   * 已生效额度一条、每个未生效的领取包各一条——形状完全相同，
                   * 未生效的用条纹 + 底部「X 起可用」区分。
                   */
                  h(QuotaMeter, {
                    remaining: balance.remaining,
                    total: balance.total,
                    planName: balance.planName,
                    expiresAt: balance.expiresAt,
                  }),
                  (balance.pending ?? []).map((item, index) =>
                    h(
                      React.Fragment,
                      { key: `${item.planId ?? 'plan'}-${index}` },
                      h(QuotaMeter, {
                        pending: true,
                        effectiveAt: item.effectiveAt,
                        expiresAt: item.expiresAt,
                        planName: item.showName,
                      }),
                      h(
                        'span',
                        { className: 'zsp-muted', style: { fontSize: '11px' } },
                        `${item.showName ?? '额度'} ${formatPendingUnits(item)} tokens`,
                      ),
                    ),
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
          for (const item of Array.isArray(summary?.accounts) ? summary.accounts : []) {
            if (item.balance !== null && item.balance !== undefined) {
              seeded[item.id] = { ok: true, ...item.balance }
            } else {
              /**
               * summary 对余额并行拉取且失败显式下发 `balance: null`（上游已明确
               * 不可用）；不再逐个补打 /balance —— 那是对同一端点的重复请求。
               * 单账号刷新仍走面板「刷新」→ /summary。
               */
              seeded[item.id] = { ok: false, error: '余额不可用' }
            }
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
        h(ClaimSection, {
          accounts,
          busy,
          onClaimed: () => load(),
          captcha: data?.captcha,
          autoClaim: data?.autoClaim,
          /**
           * 自动领取拨盘：写入宿主（持久化 settings.json）后重新拉 summary，
           * 让拨盘状态与服务端观测（seenCount）保持同源。
           */
          onToggleAutoClaim: async (enabled) => {
            try {
              await api('/auto-claim', { enabled })
            } finally {
              await load()
            }
          },
        }),
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
