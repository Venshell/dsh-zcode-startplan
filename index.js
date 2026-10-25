/**
 * 插件入口：把「ZCode 赠送免费 plan」接进 DSH 的 `llm` 服务。
 *
 * ## 装配（顺序不可乱）
 *
 * ```
 * 解析配置 → 异步建资源（账号库 / 账号池 / captcha 产出器 / plan 客户端 / 可选本地端点）
 *   → 同步注册 llm 适配器（路由名 = config.provider，默认 zcode-start-plan）
 *   → 同步注册状态工具
 *   → 就绪后向 ctx 发出 `llm/adapters-updated`，让模型选择器立刻刷新
 * ```
 *
 * ## 为什么「注册」必须同步
 *
 * `ctx.effect(fn)` 要求 `fn` 同步返回 disposer；在异步函数里调用 `ctx.effect` 会拿到
 * 一条**未挂到 fiber** 的注册 —— 热重载或禁用插件后路由不会被撤销，表现为
 * 「插件已禁用，模型却还在选择器里且每次调用都失败」。故异步部分只负责**建资源**，
 * 注册统一放在同步入口里做。
 *
 * ## 与其他 llm 插件的关系
 *
 * 只要 `config.provider` 不与 `llm-pi-ai` / `llm-deepseek` 的路由重名就不会冲突。
 * 重名时 `registerAdapter` 抛 `DUPLICATE_ADAPTER`：这里捕获并降级为「只提供状态工具」，
 * 不让整个 fiber 崩掉（其余模型仍可正常服务）。
 */

import { assemble } from './lib/assemble.js'
import { LOGIN_CHANNELS } from './lib/upstream-api.js'

/** 默认模型列表（同时作为 Config 的默认值来源）。 */
const DEFAULT_MODELS = Object.freeze(['GLM-5.3-Flash', 'GLM-5.3'])

/** 插件名（Cordis 用它标识 fiber）。 */
export const name = 'zcode-start-plan'

/**
 * 依赖的服务。
 *
 * ⚠ 宿主 ctx 是沙箱 façade：**只有这里列出的服务才会挂到 ctx 上**，
 * 少写一个，`apply` 里一碰就抛 `cannot get property "X" without inject`，
 * 整个插件静默失效（宿主只往 stderr 打一条 warning，打包态下看不到）。
 *
 * - `llm`   注册 provider 适配器（本插件的主用途）
 * - `tools` 注册 `zcode_start_plan_status` 状态工具
 * - `timer` 每小时清理过期的「账号×模型」限流标记
 * - `webServer` 注册账号池管理路由（Web UI 面板的数据通道；可选增强）
 *
 * ⚠ 图片输入**不**走 inject：cordis 的 inject 是硬依赖（声明的服务缺席时整个
 * fiber 挂起，插件完全不加载）。附件服务经沙箱 façade 的 `ctx.get('attachments')`
 * 探测（宿主允许未声明查询），缺席时图片消息降级为占位文本，主功能不受影响。
 */
export const inject = ['llm', 'tools', 'timer', 'webServer']

const PROVIDER = 'zcode-start-plan'

/** 默认配置（每个字段都能由 profile 的 cordis.patch.yml 覆盖）。 */
const DEFAULT_CONFIG = Object.freeze({
  /** DSH 里的路由名；模型选择器里显示为 `<displayName>`。 */
  provider: PROVIDER,
  displayName: 'ZCode Start Plan（赠送免费 plan）',
  /** 暴露给 DSH 的模型 id 列表（与上游模型目录求交集；拉不到时直接用这份）。 */
  models: DEFAULT_MODELS,
  /**
   * 为每个启用账号注册一个独立的 provider 栏位（像 workbuddy 一样一栏一个
   * 账号，路由名 `<provider>-acct-<账号id>`、显示名「ZCode Start Plan · 昵称」），
   * 选中即只消耗该账号的额度，不自动换号。关闭后只有统一选号栏位。
   * （0.3.0 的 `pinnedAccounts` 同义更名，旧值仍被接受。）
   */
  accountProviders: true,
  /** 上游模型目录缓存时长（毫秒）。 */
  modelCacheMs: 10 * 60_000,
  /** 数据目录（空 = ~/.dsh/zcode-start-plan）。 */
  dataDir: '',
  /**
   * 登录渠道：`cn`（智谱国内站 bigmodel.cn）或 `intl`（Z.AI 国际站 z.ai）。
   *
   * 两条渠道**协议完全一致**，只是 `provider` 与授权站点不同：
   * 国内账号用 `cn`，国际账号用 `intl`。账号池可以同时容纳两边登录进来的账号
   * （每条凭据都记着自己的 `login_channel`，推理走同一个 zcode-plan 端点）。
   *
   * 这个配置只影响「在 DSH 里发起登录」的场景；用 CLI 登录时以 `--channel` 为准。
   */
  channel: 'cn',
  captcha: Object.freeze({
    /** 'cdp' = 用宿主 Electron 产出（默认）；'manual' = 由人工粘贴 param（见 CLI）。 */
    mode: 'cdp',
    /** 宿主调试端口（DSH 桌面端需以 --remote-debugging-port 启动）。 */
    debugPort: 9229,
    /** captcha 页面 origin（必须是真实 https origin，否则二次 mint 必失败）。 */
    origin: 'https://zcode.z.ai/',
  }),
  endpoint: Object.freeze({
    /** 是否启动本地 Anthropic 兼容端点（仅 `llm-pi-ai` 回落路线需要）。 */
    enabled: false,
    port: 17_899,
  }),
  /** 是否注册 `zcode_start_plan_status` 工具。 */
  statusTool: true,
})

/**
 * 深合并默认值（只做一层嵌套：够用且不易写错）。
 *
 * ⚠ `models` 只在**未写**（undefined/null）时补默认值；写了但类型不对
 * （例如 `models: "GLM"`）必须原样保留，让 `validateConfig` 报错 ——
 * 若在这里悄悄替换成默认值，非法配置就会被静默接受。
 */
export function resolveConfig(raw) {
  const src = raw !== null && typeof raw === 'object' ? raw : {}
  const out = { ...DEFAULT_CONFIG, ...src }
  out.captcha = { ...DEFAULT_CONFIG.captcha, ...(src.captcha ?? {}) }
  out.endpoint = { ...DEFAULT_CONFIG.endpoint, ...(src.endpoint ?? {}) }
  if (src.models === undefined || src.models === null) out.models = [...DEFAULT_CONFIG.models]
  else if (Array.isArray(src.models)) out.models = src.models.length > 0 ? src.models.slice() : [...DEFAULT_CONFIG.models]
  /** 0.3.0 的 `pinnedAccounts` 同义更名：旧名仍被接受，新名优先。 */
  if (src.accountProviders === undefined && typeof src.pinnedAccounts === 'boolean') {
    out.accountProviders = src.pinnedAccounts
  }
  return out
}

/**
 * Config 契约：**零依赖的 schemastery 兼容 schema**。
 *
 * ## 为什么必须"长得像 schemastery"
 *
 * DSH 用 `isNativeConfigSchema(config)` 判定一行能否进配置目录：
 * `Symbol.for('schemastery') === true` + string `type` + object `meta`。
 * 不属于 native 就得到 `status: 'unsupported'`，于是设置页不可编辑、
 * **provider 也进不了模型选择器**（选择器按配置目录解析 provider）。
 *
 * ## 为什么不直接 `import '@deepseek-ai/schemastery'`
 *
 * `plugin_manager` 用**软链**安装 bundle（`link:`），插件的 `index.js` 实际运行在
 * 源码目录，那里解析不到 profile 的 `node_modules` —— 一旦顶层静态 import 就
 * `ERR_MODULE_NOT_FOUND`，模块加载失败，`apply` 永不执行：表现为
 * "行状态 schema、插件列表可见，但工具与模型全都没有"（本仓库真实踩过）。
 *
 * 官方标准也明确：Host-only bundle 不需要运行时依赖。
 * 故这里手写一个**最小兼容对象**：属性名与判据完全一致，求值语义与 schemastery
 * 的 `Schema(...)` 调用一致（返回补全默认值后的配置，非法值抛错）。
 */
const SCHEMASTERNY_SYMBOL = Symbol.for('schemastery')

/**
 * 构造一个 schemastery 兼容的 object schema。
 *
 * @param {(value: any) => any} validate 校验并补全默认值；非法值应抛错
 * @param {Record<string, any>} fields 字段名 → 该字段的默认值（供文档/投影使用）
 */
function makeConfigSchema(validate, fields) {
  const schema = (value) => validate(value ?? {})
  Object.defineProperty(schema, SCHEMASTERNY_SYMBOL, { value: true, enumerable: false })
  Object.defineProperty(schema, 'type', { value: 'object', enumerable: true })
  Object.defineProperty(schema, 'meta', { value: { default: {}, ...fields }, enumerable: true })
  /** Standard Schema 兼容层：让不认识 schemastery 的消费者也能校验。 */
  Object.defineProperty(schema, '~standard', {
    value: {
      version: 1,
      vendor: 'dsh-zcode-startplan',
      validate: (value) => {
        try {
          return { value: validate(value ?? {}) }
        } catch (error) {
          return { issues: [{ message: error instanceof Error ? error.message : String(error) }] }
        }
      },
    },
    enumerable: false,
  })
  return schema
}

/** 单个 `channel` 值是否合法（与运行时归一化共用同一张表）。 */
const isChannelValue = (value) => {
  const raw = String(value ?? '').trim().toLowerCase()
  return raw.length > 0 && Object.values(LOGIN_CHANNELS).some(
    (entry) => entry.provider === raw || entry.aliases.some((alias) => alias.toLowerCase() === raw),
  )
}

/**
 * 校验并补全配置。非法值**抛错**（激活期即失败，不静默降级）。
 *
 * @param {any} value
 */
export function validateConfig(value) {
  const src = value === undefined || value === null ? {} : value
  if (typeof src !== 'object' || Array.isArray(src)) throw new Error('config 必须是对象')

  const out = resolveConfig(src)

  if (typeof out.provider !== 'string' || out.provider.trim().length === 0) {
    throw new Error('config.provider 必须是非空字符串')
  }
  if (!Array.isArray(out.models) || !out.models.every((id) => typeof id === 'string')) {
    throw new Error('config.models 必须是字符串数组')
  }
  if (typeof out.accountProviders !== 'boolean') {
    throw new Error('config.accountProviders 必须是布尔值')
  }
  if (!Number.isInteger(out.modelCacheMs) || out.modelCacheMs < 0) {
    throw new Error('config.modelCacheMs 必须是非负整数')
  }
  if (!isChannelValue(out.channel)) {
    throw new Error('config.channel 只能是 "cn"（国内智谱）或 "intl"（国际 Z.AI）')
  }

  const { captcha, endpoint } = out
  if (typeof captcha !== 'object' || captcha === null) throw new Error('config.captcha 必须是对象')
  if (captcha.mode !== 'cdp' && captcha.mode !== 'manual') {
    throw new Error('config.captcha.mode 只能是 "cdp" 或 "manual"')
  }
  if (!Number.isInteger(captcha.debugPort) || captcha.debugPort < 1 || captcha.debugPort > 65_535) {
    throw new Error('config.captcha.debugPort 必须是 1-65535 的整数')
  }
  if (typeof captcha.origin !== 'string' || !captcha.origin.startsWith('http')) {
    throw new Error('config.captcha.origin 必须是 http(s) URL')
  }
  if (typeof endpoint !== 'object' || endpoint === null) throw new Error('config.endpoint 必须是对象')
  if (!Number.isInteger(endpoint.port) || endpoint.port < 0 || endpoint.port > 65_535) {
    throw new Error('config.endpoint.port 必须是 0-65535 的整数')
  }
  if (typeof endpoint.enabled !== 'boolean') throw new Error('config.endpoint.enabled 必须是布尔值')
  if (typeof out.statusTool !== 'boolean') throw new Error('config.statusTool 必须是布尔值')

  return out
}

export const Config = makeConfigSchema(validateConfig, {
  provider: PROVIDER,
  displayName: 'ZCode Start Plan（赠送免费 plan）',
  models: [...DEFAULT_MODELS],
  accountProviders: true,
  modelCacheMs: 10 * 60_000,
  dataDir: '',
  channel: 'cn',
  captcha: { mode: 'cdp', debugPort: 9229, origin: 'https://zcode.z.ai/' },
  endpoint: { enabled: false, port: 17_899 },
  statusTool: true,
})

/**
 * Cordis 插件入口。
 *
 * ## ⚠ 宿主的 `ctx` 是**沙箱 façade**，这是本插件最大的坑
 *
 * 宿主只把 `inject` 声明过的服务挂到 ctx 上。实测（一次性诊断插件）：
 * `Object.keys(ctx)` 只有 `['fiber']`，未声明的服务访问即抛
 * `cannot get property "tools" without inject`，整个 `apply` 失败 ——
 * 而宿主只把它当一条 warning 打到 stderr（打包态被丢弃），
 * 表现为「插件在列表里、Config 是 schema，但工具和模型全都没有」。
 *
 * 因此：**用到哪个服务就必须在 `inject` 里声明**。本插件用到
 * `llm`（注册适配器）、`tools`（状态工具）、`timer`（定期清理）、
 * `webServer`（账号池管理路由，供插件 Web UI 面板调用）。
 * 后两处都有容错（服务不可用时面板路由跳过 / 图片降级占位文本）。
 * 图片输入的附件服务**刻意不进 inject**（硬依赖会把插件整体挂起），
 * 由 assemble 在建资源时用 `ctx.get('attachments')` 探测。
 *
 * 另外 `ctx.effect` 在沙箱里可用（它不是服务，是 ctx 动词），
 * 而 `ctx.emit` / `ctx.on` / `ctx.setInterval` **不可用** ——
 * 分别改用 `ctx.llm.emitAdaptersUpdated?.()` 与 `ctx.timer.interval`。
 *
 * `webServer`（账号池管理路由）也在 `inject` 里声明了，但注册处做了
 * 容错（`ctx.webServer?.register` 探测 + try/catch 降级）：单测假 ctx、
 * 或未来宿主版本缺该服务时，只跳过面板路由，其余功能不受影响。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {ReturnType<typeof resolveConfig>} rawConfig
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const log = (message) => {
    try {
      ctx.logger?.info?.(`[zcode-start-plan] ${message}`)
    } catch {
      // logger 不可用时静默（不要让日志把插件弄崩）。
    }
  }
  const warn = (message) => {
    try {
      ctx.logger?.warn?.(`[zcode-start-plan] ${message}`)
    } catch {
      // 同上。
    }
  }

  const assembled = assemble(ctx, config, { log, warn })
  let adapterRegistered = false
  let disposed = false

  /**
   * 异步建资源；就绪后才注册适配器。
   *
   * 官方标准：每个资源都用 `ctx.effect` 注册并交出 cleanup。
   *   ① 适配器 / 工具 / 定时器 —— 就绪后在 `ctx.effect` 里注册；
   *   ② 账号库 / 端点 / DB 句柄 —— 异步资源，由 `apply` 返回的 cleanup 释放。
   */
  void assembled
    .init()
    .then(() => {
      if (adapterRegistered || disposed) return
      adapterRegistered = true
      ctx.effect(() => {
        const undo = assembled.register()
        return () => {
          if (typeof undo === 'function') undo()
        }
      })
      /**
       * 拓扑变了：让模型选择器重读注册表。
       * ⚠ 沙箱里没有 `ctx.emit`，改用 `ctx.llm.emitAdaptersUpdated?.()`
       * （`dsh-llm` 自己的发布入口，`workbuddy` 插件也是这么用的）。
       */
      try {
        ctx.llm.emitAdaptersUpdated?.()
      } catch {
        // 老版本没有这个方法；选择器下次刷新自然会看到。
      }
    })
    .catch((error) => {
      warn(
        `初始化失败（本插件不提供服务，其它模型不受影响）：${error instanceof Error ? error.message : String(error)}`,
      )
    })

  /**
   * 插件级 cleanup（官方标准：`apply` 返回它）。
   */
  return async () => {
    disposed = true
    await assembled.dispose()
  }
}
