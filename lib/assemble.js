/**
 * 把 `apply` 里「异步就绪 + 注册 + 释放」这三件事收在一处。
 *
 * 拆出来的原因：`ctx.effect` 的回调必须是**同步**的（disposer 由 effect 持有），
 * 而账号库打开（`node:sqlite` 动态 import）和本地端点监听都是异步的。
 * 所以这里用「一次性的 `ctx.on('dispose')` + 惰性就绪」组合，而不是在
 * 异步函数里调 `ctx.effect`（那样拿到的是未挂到 fiber 的注册，热重载后不会被撤销）。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SqliteStore, AccountPool, resolveDbFile, resolveDataDir } from './pool.js'
import { CaptchaMinter } from './captcha/minter.js'
import { ZcodePlanClient } from './plan-client.js'
import { NativeZcodeStartPlanAdapter } from './adapter.js'
import { startLocalEndpoint, resolveEndpointToken, resolvePort } from './local-endpoint.js'
import { startOpenAiGateway, resolveOpenAiApiKey } from './openai-gateway.js'
import { fetchBalance, fetchCaptchaConfig, fetchModels, fetchClaimablePlans, claimPlan, reportMarketingAction } from './upstream-api.js'
import { createAutoClaim } from './auto-claim.js'
import { ZCODE_FALLBACK_MODELS } from './upstream.js'
import { makeManageRoutes } from './manage-routes.js'

/**
 * 以调试端口重启宿主的实现（供管理路由的 `/restart-cdp` 调用）。
 *
 * 跑 `scripts/restart-dsh.ps1`，三件事必须同时成立：
 * 1. `detached: true` + `unref()`：脚本要在**本请求返回之后**才杀宿主，
 *    若子进程挂在宿主进程树下，宿主一死它跟着死 → 没人拉起新实例；
 * 2. 用 `powershell.exe`（Windows PowerShell 5.1 一定在）而不是 `pwsh`：
 *    用户机器未必装了 PowerShell 7；
 * 3. `cwd` 指到插件目录，脚本内部的相对路径才成立。
 *
 * ⚠ 脚本已按 DSH 官方的 `app.relaunch(); app.quit();` 语义重写（0.6.3）：
 * 只杀**真正的 Electron 主进程**（排除 `--expose-internals … dsh-desktop-host`
 * 与 `runner.js`），优雅退出并**等它真的消失**，再用**原 argv + CDP 参数**拉起。
 * 旧实现因为把 host 子进程当主进程、且不等单实例锁释放，`--remote-debugging-port`
 * 永远带不上（见脚本头注释）。
 *
 * `-GracefulTimeoutSec` 透传：给用户/会话留出优雅退出的时间。
 *
 * @param {{ debugPort: number, waitSeconds: number }} options
 */
/**
 * 构造「带调试端口启动 DSH」的命令行（供用户**手动**重启时用）。
 *
 * ## 为什么不替用户重启了（0.6.6）
 *
 * 旧实现 spawn 一个 PowerShell 脚本做「杀宿主 → 等它退出 → 拉起新实例」，
 * 还叠加了计划任务、`-ExecutionPolicy Bypass`、隐藏窗口、临时 .cmd 等手段。
 * 这组特征与恶意软件的持久化/提权手法高度重合，**被火绒等 AV 拦截是正确行为**
 * （用户实际遇到了报毒）。
 *
 * 而且技术上也是死路：脚本作为宿主子进程位于宿主的 Job Object 内，
 * 宿主一死脚本被杀（实测日志停在 `forcing pid N` 之后），
 * 能脱离 job 的手段（计划任务）恰恰是 AV 最敏感的那类。
 *
 * 现在改为**只告知、不执行**：返回一条用户可直接复制的命令，
 * 由用户自己退出并重开 DSH。重启本来就是用户的决定，插件不越权。
 *
 * @param {{ debugPort?: number }} options
 * @returns {{ command: string, port: number | null, note: string }}
 */
export function buildRestartCommand(options = {}) {
  const port = Number.isInteger(options.debugPort) && options.debugPort > 0 ? options.debugPort : null
  /** 宿主 exe 的常见位置（与 scripts/restart-dsh.ps1 的 Resolve-HostExe 保持一致）。 */
  const candidates = [
    'D:\\software\\dsh\\DeepSeek Harness.exe',
    process.env['LOCALAPPDATA'] ? join(process.env['LOCALAPPDATA'], 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe') : '',
    process.env['ProgramFiles'] ? join(process.env['ProgramFiles'], 'DeepSeek Harness', 'DeepSeek Harness.exe') : '',
  ].filter((value) => value.length > 0)
  let exe = candidates.find((value) => {
    try {
      return existsSync(value)
    } catch {
      return false
    }
  })
  /** 探不到就留占位，由用户补全；绝不猜一个会误跑的路径。 */
  if (exe === undefined) exe = '<DeepSeek Harness.exe 的完整路径>'
  const command = port === null ? `"${exe}"` : `"${exe}" --remote-debugging-port=${port}`
  return {
    command,
    port,
    note:
      port === null
        ? '普通重启（重载插件）。请自行退出并重新打开 DSH。'
        : `要让 captcha 可用，请退出 DSH 后用这条命令重新打开（会开启调试端口 ${port}）。`,
  }
}

/**
 * 装配并返回运行时句柄。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {any} config 已解析的配置
 * @param {{ log: (message: string) => void, warn: (message: string) => void }} logger
 */
export function assemble(ctx, config, logger) {
  const { log, warn } = logger
  const dataDir = config.dataDir.trim().length > 0 ? config.dataDir.trim() : resolveDataDir(process.env)

  /**
   * 面板开关的持久化（settings.json in dataDir）。
   *
   * 只存「非默认的偏好」，坏文件按默认值处理 —— 一个开关状态不该让插件起不来。
   * 字段：
   * - unifiedModelList：统一选号栏位是否显示（默认 true）；
   * - hiddenModelLists：被隐藏「模型栏位」的账号 id 数组（默认空 = 全显示）；
   * - autoClaim：面板「自动领取」拨盘的最后位置（缺省 = 跟随 config.autoClaim.enabled）。
   */
  const settingsFile = join(dataDir, 'settings.json')
  const settings = { unifiedModelList: true, hiddenModelLists: [] }
  try {
    const raw = readFileSync(settingsFile, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object') {
      if (typeof parsed.unifiedModelList === 'boolean') settings.unifiedModelList = parsed.unifiedModelList
      if (Array.isArray(parsed.hiddenModelLists)) {
        settings.hiddenModelLists = parsed.hiddenModelLists.filter((id) => typeof id === 'string')
      }
      if (typeof parsed.autoClaim === 'boolean') settings.autoClaim = parsed.autoClaim
    }
  } catch {
    // 没有文件 / 坏 JSON：全按默认值。
  }
  const saveSettings = () => {
    try {
      mkdirSync(dataDir, { recursive: true })
      writeFileSync(settingsFile, JSON.stringify(settings, null, 2))
    } catch (error) {
      warn(`保存 settings.json 失败（开关状态重启后会丢失）：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 资源句柄（由 `dispose` 统一释放）。 */
  const runtime = {
    pool: undefined,
    store: undefined,
    minter: undefined,
    client: undefined,
    endpoint: undefined,
    ready: false,
    /** 适配器是否真的注册上了（状态工具据此报「为什么模型列表里没有」）。 */
    adapterRegistered: false,
    /** 最近一次致命错误（初始化 / 注册 / 加载）。 */
    error: undefined,
    /** llm 适配器实例（管理路由的可见性开关要用；`register()` 里建立）。 */
    adapter: undefined,
    /** 账号增删/启停/置顶后原子换路由（由 `register()` 里赋值）。 */
    syncAdapterRoutes: undefined,
    /** 自动领取控制器（config.autoClaim.enabled 时建；状态工具观测用）。 */
    autoClaim: undefined,
  }

  /** 模型目录缓存（拉上游一次，失败回退到 config.models + 兜底表）。 */
  let modelsCache = { at: 0, value: undefined }

  const loadModels = async () => {
    if (modelsCache.value !== undefined && Date.now() - modelsCache.at < config.modelCacheMs) {
      return modelsCache.value
    }
    const fallback = config.models.map((id) => {
      const known = ZCODE_FALLBACK_MODELS.find((model) => model.id === id)
      return known ?? { id, name: id, contextWindow: 1_000_000, maxTokens: 32_768, supportsImage: true }
    })
    try {
      const first = runtime.pool?.list({ withCredentials: true })[0]
      if (first?.credential !== undefined) {
        const remote = await fetchModels(first.credential)
        if (remote !== undefined) {
          const filtered = remote.filter((model) => config.models.includes(model.id))
          const picked = filtered.length > 0 ? filtered : remote
          modelsCache = { at: Date.now(), value: picked }
          return picked
        }
      }
    } catch (error) {
      warn(`拉取模型目录失败：${error instanceof Error ? error.message : String(error)}`)
    }
    /**
     * 拉取失败时的次序：**先过期缓存，再兜底表**。
     *
     * ⚠ 不能直接跳兜底表：拉取是间歇性的（网络抖动 / 上游过载），而兜底表若是
     * 旧版（无 `reasoningLevels`）会让宿主抛 `UNSUPPORTED_REASONING_EFFORT` ——
     * 用户此刻选档位就报「不支持当前档位」且无输出（2026-10-25 实测踩坑）。
     * 过期缓存虽旧但元数据结构完整，比兜底表安全；兜底表只给冷启动用。
     * 缓存为 undefined（从未成功过）才落兜底，且缓存兜底值以便下次直接命中过期缓存。
     */
    if (modelsCache.value !== undefined) return modelsCache.value
    modelsCache = { at: Date.now(), value: fallback }
    return fallback
  }

  const dispose = async () => {
    try {
      runtime.minter?.dispose()
    } catch {
      // 已释放。
    }
    try {
      await runtime.endpoint?.close()
    } catch {
      // 已关闭。
    }
    try {
      await runtime.openaiGateway?.close()
    } catch {
      // 已关闭。
    }
    try {
      runtime.store?.close()
    } catch {
      // 已关闭。
    }
  }

  /** 异步初始化（只做「建资源」，不注册任何 fiber 内对象）。 */
  const init = async () => {
    /**
     * ⚠ 用 `dataDir` 解析库路径（而不是只读 `process.env`）：`config.dataDir` 必须真的
     * 决定落盘位置，否则测试/多实例会读写用户的**真实账号库**（本仓库的 apply 单测
     * 就因此读到了真实登录的账号，导致断言随环境漂移）。
     */
    const dbFile = resolveDbFile(process.env, dataDir)
    runtime.store = await new SqliteStore(dbFile)
    if (runtime.store.inMemory === true) {
      warn(
        '账号库落盘失败（目录不可写 / 被占用），已降级为**内存库**：' +
        '本次运行内可用，但重启后账号会消失。请用 config.dataDir 指到一个可写目录，' +
        '或设环境变量 ZCODE_START_PLAN_DATA_DIR。原因：' +
        `${runtime.store.mkdirError instanceof Error ? runtime.store.mkdirError.message : '未知'}`,
      )
    }
    runtime.pool = new AccountPool({ store: runtime.store, log })
    /** 统一选号顺序（0.7.0）：'expiry'（默认，快过期先用）| 'manual'（置顶优先）。 */
    runtime.pool.setSelectionOrder(config.selectionOrder)
    runtime.pool.sweepExpired()

    runtime.minter = new CaptchaMinter({
      debugPort: config.captcha.debugPort,
      origin: config.captcha.origin,
      log,
    })
    /** plan 客户端通过这个钩子拉服务端下发的 captcha 配置（60s TTL 在客户端里）。 */
    runtime.minter.fetchConfig = (credential) => fetchCaptchaConfig(credential)

    runtime.client = new ZcodePlanClient({
      pool: runtime.pool,
      minter: runtime.minter,
      log,
      /**
       * 图片输入：宿主把上传图片存进附件库，适配器只收到持久引用；
       * 这里回调取挂载的附件服务（`ctx.get('attachments')`，沙箱 façade 允许
       * 未声明服务的只读查询），plan-client 据此把引用解析成请求字节
       * （官方 `dsh-llm-deepseek` 同款链路）。⚠ 惰性求值：附件服务可能晚于
       * 本插件初始化挂载；缺席（undefined）时图片降级为占位文本。
       */
      resolveAttachments: typeof ctx.get === 'function' ? () => ctx.get('attachments') : undefined,
    })

    /**
     * 自动领取控制器 —— **常驻创建**（不再只在 config 开启时建）。
     *
     * 领取的开关是运行期状态（面板「自动领取」拨盘），轮询定时器一直挂着，
     * `enabled=false` 时 tick 空转。初值优先级：
     * `settings.json`（面板最后拨到的位置）> `config.autoClaim.enabled`。
     * 探测（`/claimable`）与开关无关，永远可用。
     */
    runtime.autoClaim = createAutoClaim({
      pool: runtime.pool,
      client: runtime.client,
      enabled: settings.autoClaim === true || config.autoClaim?.enabled === true,
      fetchClaimablePlans: (credential) => fetchClaimablePlans(credential),
      claimPlan: (credential, planId, captcha) => claimPlan(credential, planId, captcha),
      reportMarketingAction: (credential, campaignId, actionType) => reportMarketingAction(credential, campaignId, actionType),
      stateFile: join(dataDir, 'auto-claim-state.json'),
      log,
    })
    if (runtime.autoClaim.isEnabled() === true) {
      log(`自动领取已开启（每 ${Math.round(config.autoClaim.intervalMs / 60_000)} 分钟探测并领取新活动）`)
    }

    if (config.openaiGateway?.enabled === true) {
      try {
        const key = resolveOpenAiApiKey(dataDir, process.env)
        runtime.openaiGateway = await startOpenAiGateway({
          port: resolvePort(config.openaiGateway.port),
          token: key.value,
          planClient: runtime.client,
          models: loadModels,
          log,
        })
        /** ⚠ 日志里**不打印 key** —— 它会被贴进配置文件与 bug 报告。 */
        log(
          `OpenAI 兼容端点就绪：${runtime.openaiGateway.baseUrl}` +
          `（Bearer key 见 ${key.path ?? 'DSH_OPENAI_GATEWAY_API_KEY 环境变量'}）`,
        )
      } catch (error) {
        warn(`OpenAI 兼容端点启动失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }

    if (config.endpoint.enabled === true) {
      try {
        const token = resolveEndpointToken(dataDir, process.env)
        runtime.endpoint = await startLocalEndpoint({
          port: resolvePort(config.endpoint.port),
          token,
          planClient: runtime.client,
          models: loadModels,
          log,
        })
        log(`本地端点就绪：${runtime.endpoint.baseUrl}（pi-ai 路线的 baseURL / apiKey）`)
      } catch (error) {
        warn(`本地端点启动失败（pi-ai 回落路线不可用）：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    runtime.ready = true
    log(`账号库：${dbFile}（${runtime.pool.list().length} 个账号）`)
    return runtime
  }

  /**
   * 注册 DSH 的扩展点（**同步**），返回可撤销的 cleanup。
   *
   * 官方标准：`apply` 内每个资源都用 `ctx.effect` / `ctx.on` 注册并交出 cleanup。
   * 这里把「适配器 + 状态工具 + 定期清理」打成**一个** effect，返回的 disposer
   * 会按反序释放它们 —— 这样插件被禁用/热重载时不会留下悬挂的 llm 路由。
   *
   * ⚠ 两条硬约束（都是「插件加载了但模型列表里没有」的直接成因）：
   * 1. `ctx.effect` 缺失时**直接注册**，不能整体放弃；
   * 2. `ctx.llm` 此刻可能还没就绪 → 退到 `ctx.inject(['llm'])` 等它出现；
   *    两者都不可用时把原因写进 `runtime.error`，让状态工具报出来。
   */
  const register = () => {
    /** 已登记的撤销函数（反序执行）。 */
    const undos = []
    const addUndo = (undo) => {
      if (typeof undo === 'function' && undo !== ctx) undos.push(undo)
    }

    const doRegister = () => {
      /** ① llm 适配器路由（统一 + 每账号一栏，workbuddy 模式）。 */
      const adapter = new NativeZcodeStartPlanAdapter({
        client: runtime.client,
        models: loadModels,
        provider: config.provider,
        displayName: config.displayName,
        log,
        /** 每个启用账号一个独立 provider 栏位（config.accountProviders 可关）。 */
        accountProviders: config.accountProviders !== false,
        pool: runtime.pool,
        unifiedVisible: settings.unifiedModelList !== false,
        hiddenAccounts: settings.hiddenModelLists,
      })
      runtime.adapter = adapter
      /**
       * 当前注册的路由集合（统一栏位 + 启用账号的栏位）。账号增删/启停/
       * 统一栏位开关时用 `handle.replace()` 原子换路由 —— 宿主会在
       * commitRoutes 里自动广播 `llm/adapters-updated`，模型选择器随即重拉。
       */
      let registrationHandle
      const currentRoutes = () => {
        /** 统一栏位永远注册（关掉只是空目录隐藏，路由保留让老会话不炸）。 */
        const routes = [config.provider]
        if (config.accountProviders !== false) {
          for (const entry of runtime.pool.list()) {
            if (entry.enabled === true) {
              routes.push(NativeZcodeStartPlanAdapter.accountRoute(config.provider, entry.id))
            }
          }
        }
        return routes
      }
      const syncRoutes = () => {
        try {
          registrationHandle?.replace?.(currentRoutes())
        } catch (error) {
          warn(`切换 llm 路由失败：${error instanceof Error ? error.message : String(error)}`)
        }
      }
      try {
        registrationHandle = ctx.llm.registerAdapter(currentRoutes(), adapter)
        addUndo(registrationHandle)
        runtime.adapterRegistered = true
        runtime.syncAdapterRoutes = syncRoutes
        log(
          `llm 路由已注册：${currentRoutes().length} 条` +
          `（统一：${config.provider}；账号栏位：${config.accountProviders !== false ? '开' : '关'}）`,
        )
      } catch (error) {
        runtime.error = `注册 llm 路由失败：${error instanceof Error ? error.message : String(error)}`
        warn(`${runtime.error}（可能与其他适配器重名）；本插件降级为仅提供状态工具。`)
      }

      /** ② 状态工具。 */
      if (config.statusTool === true && ctx.tools !== undefined) {
        addUndo(registerStatusTool(ctx, runtime, config, loadModels))
      }

      /** ③ 每小时清一次过期的「账号×模型」限流标记（免费额度按自然日结算）。 */
      /**
       * ⚠ 沙箱里**没有** `ctx.setInterval`（宿主禁掉了 Node 定时器），
       * 必须用 `ctx.timer.interval` —— 且 `timer` 要先在 `inject` 里声明。
       * 这是本插件「加载了却不工作」的根因之一。
       */
      if (ctx.timer !== undefined && typeof ctx.timer.interval === 'function') {
        addUndo(ctx.timer.interval(() => runtime.pool?.sweepExpired(), 60 * 60_000))
        /**
         * 自动领取轮询：**常驻挂载**（开关在 tick 内部判断，关着就空转）。
         * 这样面板拨一下即生效，不需要重启宿主。
         */
        const autoClaim = runtime.autoClaim
        if (autoClaim !== undefined) {
          addUndo(ctx.timer.interval(() => {
            autoClaim.tick().catch((error) => {
              warn(`自动领取轮次失败：${error instanceof Error ? error.message : String(error)}`)
            })
          }, Math.max(5 * 60_000, config.autoClaim.intervalMs)))
        }
      } else {
        warn('timer 服务不可用，跳过每小时限流清理与自动领取轮询（限流标记仍会在每次请求时自然过期）')
      }

      /**
       * ④ 账号池管理路由 —— **不在这里注册**。
       *
       * 路由要挂到 `webServer` 上，而 `webServer` 是可选服务：宿主只把
       * `inject` 声明过的服务挂到 facade 上，把 `webServer` 写进硬 inject
       * 又会让 headless profile 整个 fiber 挂起。两种写法都错过一个版本：
       * - 0.4.4：从 facade 探测 `ctx.webServer` → 永远拿不到 → 静默跳过（面板 404）；
       * - 只把 `webServer` 加回 inject → headless 下整插件不加载。
       *
       * 正解在 `index.js` 的 `ctx.inject(['webServer'], …)` 回调里调用
       * `registerManageRoutes(webCtx)`：服务出现才注册、消失则 effect 自动撤销。
       * （`syncRoutes` / `settings` / `log` 都在闭包里，回调直接复用。）
       */
      runtime.syncRoutes = syncRoutes
    }

    /**
     * `inject: ['llm', …]` 已保证 `ctx.llm` 就绪后才 apply，
     * 所以这里直接注册即可；保留一个兜底分支应对宿主延迟挂载的情况。
     * facade 上没有 `ctx.inject`，不能用它做兜底。
     */
    if (ctx.llm !== undefined) {
      doRegister()
    } else {
      runtime.error = 'llm 服务尚未就绪（inject 已声明，但 apply 时仍不可用）。'
      warn(runtime.error)
    }

    /** 返回 cleanup：反序撤销。 */
    return () => {
      for (const undo of undos.splice(0).reverse()) {
        try {
          undo()
        } catch (error) {
          warn(`撤销注册失败：${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
  }

  /**
   * ④ 账号池管理路由（由 `index.js` 的 `ctx.inject(['webServer'], …)` 调用）。
   *
   * 之所以单独暴露而不是在 `register()` 里顺手连上：`webServer` 是**可选**
   * 服务，必须用 cordis 的可选注入在它出现时才注册。这里拿到的 `webCtx`
   * 保证带 `webServer`，于是不需要任何探测分支 —— 路由条目多一条都会被
   * 立刻打日志，面板 404 这类症状下次能直接从日志定位。
   *
   * @param {any} webCtx 带 `webServer` 的 context（可选注入回调参数）
   * @returns {() => void} 撤销函数（已用 effect 托管时宿主会再调一次也无害）
   */
  const registerManageRoutes = (webCtx) => {
    const undos = []
    const addUndo = (undo) => {
      if (typeof undo === 'function' && undo !== webCtx) undos.push(undo)
    }
    const undoAll = () => {
      for (const undo of undos.splice(0).reverse()) {
        try {
          undo()
        } catch (error) {
          warn(`撤销管理路由失败：${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
    if (typeof webCtx?.webServer?.register !== 'function') {
      warn('webServer 服务不可用（预期的可选注入未生效）：账号面板路由已跳过')
      return undoAll
    }
    if (runtime.pool === undefined) {
      warn('账号池尚未就绪：账号面板路由已跳过（初始化失败时才会发生）')
      return undoAll
    }
    if (runtime.adapter === undefined) {
      warn('llm 适配器尚未建立：账号面板路由已跳过（初始化失败时才会发生）')
      return undoAll
    }
    const adapter = runtime.adapter
    const routes = makeManageRoutes({
      pool: runtime.pool,
      fetchBalance: (credential) => fetchBalance(credential),
      /**
       * 领取赠送额度要 captcha：复用 plan-client 的**同一份**串行队列与退避闸门，
       * 避免面板点击与推理链路各自起一份 CDP 会话互相踩页面。
       */
      client: runtime.client,
      /**
       * 0.6.6 起**不再替用户重启**（spawn 杀进程 + 计划任务被火绒判毒，且
       * 宿主 Job Object 会连带杀死脚本）。只生成用户可复制的启动命令。
       */
      buildRestartCommand: (options) => buildRestartCommand(options),
      /**
       * captcha 载体状态：**每次 /summary 都现探一次**（一次本机 HTTP GET，几毫秒）。
       * 不做缓存 —— 用户点「以调试模式重启」后回来刷新，必须立刻看到新状态。
       * 探测本身失败不影响 summary 其余字段。
       */
      probeCaptcha: async () => {
        const minter = runtime.minter
        const fallback = { mode: config.captcha.mode, debugPort: config.captcha.debugPort, reachable: false }
        if (minter === undefined || typeof minter.probe !== 'function') return fallback
        try {
          const outcome = await minter.probe()
          return {
            ...fallback,
            reachable: outcome?.ok === true,
            ...(outcome?.ok === true ? {} : { reason: outcome?.reason }),
          }
        } catch (error) {
          return { ...fallback, reason: error instanceof Error ? error.message : String(error) }
        }
      },
      log,
      settings,
      onChanged: () => runtime.syncAdapterRoutes?.(),
      onSetUnifiedVisible: (visible) => {
        adapter.setUnifiedVisible(visible)
        settings.unifiedModelList = visible === true
        saveSettings()
        runtime.syncAdapterRoutes?.()
        log(`统一选号栏位${visible === true ? '已显示' : '已隐藏'}`)
      },
      onSetAccountVisible: (accountId, visible) => {
        adapter.setAccountVisible(accountId, visible)
        const hidden = new Set(settings.hiddenModelLists)
        if (visible === true) hidden.delete(accountId)
        else hidden.add(accountId)
        settings.hiddenModelLists = [...hidden]
        saveSettings()
        runtime.syncAdapterRoutes?.()
        const nickname = runtime.pool?.get(accountId)?.nickname ?? accountId.slice(0, 8)
        log(`账号「${nickname}」的模型栏位${visible === true ? '已显示' : '已隐藏'}`)
      },
      /** 自动领取开关：拨盘位置写 settings.json（重启后保持），控制器即时生效。 */
      getAutoClaimEnabled: () => runtime.autoClaim?.isEnabled() === true,
      getAutoClaimStats: () => runtime.autoClaim?.stats?.() ?? {},
      onSetAutoClaim: (enabled) => {
        const applied = runtime.autoClaim?.setEnabled(enabled) === true
        settings.autoClaim = enabled === true
        saveSettings()
        log(`自动领取${applied ? '已开启（新活动会被自动领取）' : '已关闭（探测仍可用，领取需手动点）'}`)
        return applied
      },
    })
    for (const route of routes) addUndo(webCtx.webServer.register(route))
    log(`管理路由已注册：${routes.length} 条（/api/zcode-start-plan/*）`)
    return undoAll
  }

  return { runtime, init, register, registerManageRoutes, dispose, loadModels, dataDir }
}

/**
 * 状态工具（模型可见）：账号数 / 模型 / captcha 观测 / 本地端点。
 *
 * 刻意**不**返回凭据、token 或任何可用于登录的秘密 —— 只给可诊断的元数据。
 */
export function registerStatusTool(ctx, runtime, config, loadModels) {
  const tool = {
    name: 'zcode_start_plan_status',
    description:
      'Return the ZCode free-plan channel status for this DSH profile: registered provider route, models, ' +
      'account pool size (no credentials), per-account rate-limit markers, and captcha availability. ' +
      'Use when a model call on the zcode-start-plan provider fails with QUOTA / AUTH / RATE_LIMIT.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object', additionalProperties: true },
      /**
       * ⚠ 输出必须是**无损 JSON**：宿主会校验 `JSON.parse(text)` 再与原值深比较，
       * 带缩进的 `JSON.stringify(value, null, 2)` 会被判 `value is not lossless JSON`
       * 而拒绝整个工具结果。故用紧凑序列化。
       */
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute() {
      /**
       * ⚠ 返回值里**不能有 `undefined`**：`JSON.stringify` 会直接丢掉这些键，
       * 宿主拿 `JSON.parse(text)` 与原值深比较时会判定「不是无损 JSON」而拒绝整个结果。
       * 故缺省值一律用 `null`。
       */
      const accounts = (runtime.pool?.list() ?? []).map((entry, index) => ({
        index: index + 1,
        id: entry.id,
        nickname: entry.nickname,
        enabled: entry.enabled,
        userIdTail: typeof entry.user_id === 'string' ? entry.user_id.slice(-6) : null,
        limitedModels: Object.keys(entry.model_rate_limits ?? {}),
        lastError: entry.last_error ?? null,
      }))
      const captionProbe =
        runtime.minter === undefined ? { ok: false, reason: 'captcha 产出器未初始化' } : await runtime.minter.probe()
      return {
        provider: config.provider,
        displayName: config.displayName,
        models: (await loadModels()).map((model) => model.id),
        accountCount: accounts.length,
        enabledAccountCount: accounts.filter((entry) => entry.enabled).length,
        accounts,
        captcha: {
          mode: config.captcha.mode,
          debugPort: config.captcha.debugPort,
          reachable: captionProbe.ok,
          reason: captionProbe.reason ?? null,
          ...(runtime.client?.observability?.() ?? {}),
        },
        /** 自动领取观测（未开启时 enabled:false）。 */
        autoClaim: {
          enabled: runtime.autoClaim !== undefined,
          ...(runtime.autoClaim?.stats?.() ?? {}),
        },
        endpoint: runtime.endpoint === undefined ? null : { baseUrl: runtime.endpoint.baseUrl, port: runtime.endpoint.port },
        /** 诊断字段：模型没出现在选择器里时，先看这两个。 */
        adapterRegistered: runtime.adapterRegistered === true,
        error: runtime.error ?? null,
      }
    },
  }
  /**
   * 返回 disposer（官方标准：注册即交出 cleanup）。
   * 有 `ctx.effect` 时由它托管；没有时把 `register()` 的撤销函数原样交出去。
   */
  if (typeof ctx.effect === 'function') {
    return ctx.effect(() => ctx.tools.register(tool))
  }
  return ctx.tools.register(tool)
}
