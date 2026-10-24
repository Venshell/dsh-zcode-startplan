/**
 * 把 `apply` 里「异步就绪 + 注册 + 释放」这三件事收在一处。
 *
 * 拆出来的原因：`ctx.effect` 的回调必须是**同步**的（disposer 由 effect 持有），
 * 而账号库打开（`node:sqlite` 动态 import）和本地端点监听都是异步的。
 * 所以这里用「一次性的 `ctx.on('dispose')` + 惰性就绪」组合，而不是在
 * 异步函数里调 `ctx.effect`（那样拿到的是未挂到 fiber 的注册，热重载后不会被撤销）。
 */

import { SqliteStore, AccountPool, resolveDbFile, resolveDataDir } from './pool.js'
import { CaptchaMinter } from './captcha/minter.js'
import { ZcodePlanClient } from './plan-client.js'
import { NativeZcodeStartPlanAdapter } from './adapter.js'
import { startLocalEndpoint, resolveEndpointToken, resolvePort } from './local-endpoint.js'
import { fetchModels, fetchCaptchaConfig } from './upstream-api.js'
import { ZCODE_FALLBACK_MODELS } from './upstream.js'

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
      warn(`拉取模型目录失败（用本地兜底表）：${error instanceof Error ? error.message : String(error)}`)
    }
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
    })

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
      /** ① llm 适配器路由。 */
      const adapter = new NativeZcodeStartPlanAdapter({
        client: runtime.client,
        models: loadModels,
        provider: config.provider,
        displayName: config.displayName,
        log,
      })
      try {
        addUndo(ctx.llm.registerAdapter([config.provider], adapter))
        runtime.adapterRegistered = true
        log(`llm 路由已注册：${config.provider}（模型：${config.models.join(', ')}）`)
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
      } else {
        warn('timer 服务不可用，跳过每小时限流清理（限流标记仍会在每次请求时自然过期）')
      }
    }

    /**
     * `inject: ['llm', …]` 已保证 `ctx.llm` 就绪后才 apply，
     * 所以这里直接注册即可；保留一个兜底分支应对宿主延迟挂载的情况。
     * ⚠ 沙箱 façade 上没有 `ctx.inject`，不能用它做兜底。
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

  return { runtime, init, register, dispose, loadModels, dataDir }
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
