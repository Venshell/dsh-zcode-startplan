/**
 * 两个 llm 适配器：**原生适配器**（默认）与 **pi-ai 适配器**（可选回落）。
 *
 * ## 为什么是「适配器」而不是代理
 *
 * DSH 里每个请求都由 `ctx.llm` 分派给某个 adapter；adapter 负责把上游 wire 翻成 DSH 的
 * `StreamChunk` 词汇。参考实现（ZCode 插件）是一层本地 HTTP 代理，由 ZCode 自带的
 * Anthropic SDK 解析字节流——DSH 侧没有那条通道，所以这里直接实现 adapter：
 *
 * ```
 * NativeZcodeStartPlanAdapter   ← 推荐：账号池 / captcha / 切号 / 重试 全在本插件内
 * PiAiZcodeStartPlanAdapter     ← 可选：沿用 DSH 的 dsh-llm-pi-ai，本插件只做参数注入
 * ```
 *
 * pi-ai 适配器之所以能工作，是因为它只按「provider 名」路由：`llm-pi-ai` 的
 * `providers` 配置里可以声明任意自定义 provider（`api: anthropic-messages` +
 * `baseURL`），而本插件把自己暴露成 `127.0.0.1:<port>` 上的 Anthropic 兼容端点
 * （`lib/local-endpoint.js`）。两条路共用同一套账号池与 captcha 产出器。
 */

import { AnthropicStreamTranslator } from './stream-translator.js'
import { ZCODE_FALLBACK_MODELS } from './upstream.js'

/** 从上游模型目录构造 DSH 的 `LlmModelInfo`。 */
export function toModelInfo(provider, model) {
  const info = {
    provider,
    id: model.id,
    name: model.name ?? model.id,
    inputModalities: model.supportsImage === false ? ['text'] : ['text', 'image'],
    context: { contextWindow: model.contextWindow ?? 1_000_000 },
    defaultMaxTokens: model.maxTokens ?? 32_768,
  }
  if (Array.isArray(model.reasoningLevels) && model.reasoningLevels.length > 0) {
    /**
     * 思考档位。
     *
     * ⚠ 每个 effort **必须同时有非空 `id` 和非空 `name`**，且 `id` 不得重复 ——
     * `dsh-llm` 的 `normalizeModelInfo` 会逐项校验，缺一个字段就抛
     * `INVALID_MODEL_REASONING`（"invalid or duplicate reasoning effort metadata"），
     * 整个模型在宿主里不可用。
     *
     * `name` 用档位 id 的展示名（如 `low` → `Low`）；`id` 原样透传，
     * 因为 `plan-client` 发请求时按上游档位键取值。
     */
    const efforts = []
    const seen = new Set()
    for (const level of model.reasoningLevels) {
      const id = typeof level === 'string' ? level.trim() : ''
      if (id.length === 0 || seen.has(id)) continue
      seen.add(id)
      efforts.push({ id, name: id.charAt(0).toUpperCase() + id.slice(1) })
    }
    if (efforts.length > 0) {
      info.reasoning = {
        efforts,
        ...(typeof model.defaultReasoningLevel === 'string' && model.defaultReasoningLevel.length > 0
          ? { defaultEffort: model.defaultReasoningLevel }
          : {}),
      }
    }
  }
  return info
}

const findModel = (models, id) => models.find((model) => model.id === id)

/**
 * 原生适配器：一次 `stream()` 就是一次 plan-client 调用 + 流翻译。
 *
 * 只实现 DSH `LlmAdapter` 契约里必需的方法（`providerInfo` / `listModels` /
 * `resolveModel` / `stream`）；不 `extends` 具体类，避免与宿主版本耦合。
 */
export class NativeZcodeStartPlanAdapter {
  #client
  #models
  #provider
  #displayName
  #log

  /**
   * @param {{
   *   client: import('./plan-client.js').ZcodePlanClient,
   *   models: () => Promise<Array<any>>,
   *   provider?: string,
   *   displayName?: string,
   *   log?: (message: string) => void,
   * }} options
   */
  constructor(options) {
    this.#client = options.client
    this.#models = options.models
    this.#provider = options.provider ?? 'zcode-start-plan'
    this.#displayName = options.displayName ?? 'ZCode Start Plan（赠送免费 plan）'
    this.#log = options.log ?? (() => {})
  }

  providerInfo(provider) {
    return { id: provider, name: this.#displayName }
  }

  /**
   * 重试策略。
   *
   * ⚠ **必须实现**：`ctx.llm.registerAdapter()` 在 `prepareRoutes` 里会**直接调用**
   * `adapter.providerRetryPolicy(provider)`（没有可选调用保护），漏掉它在宿主里报
   * `adapter.providerRetryPolicy is not a function`，整条路由注册失败 ——
   * 表现为「工具注册成功、模型列表里却没有」。
   *
   * 返回 `undefined` 表示用宿主默认策略：本插件的重试已由
   * `plan-client` 按上游错误表（3009 退避 / 3007 换 captcha / 3012 不重试）编排，
   * 不需要宿主再包一层。
   *
   * @param {string} _provider
   * @returns {undefined}
   */
  providerRetryPolicy(_provider) {
    return undefined
  }

  async listModels(provider) {
    return (await this.#models()).map((model) => toModelInfo(provider, model))
  }

  async resolveModel(provider, model) {
    const found = findModel(await this.#models(), model)
    if (found === undefined) return { provider, id: model, name: model }
    return toModelInfo(provider, found)
  }

  /**
   * 绑定「精确模型元数据」与「最终派发」。
   *
   * ⚠ **必须实现**：宿主在真正发起请求前调用 `adapter.prepareCall(provider, model, signal)`。
   * 基类 `LlmAdapter` 提供了默认实现，但本适配器**没有 extends 基类**（避免与宿主版本耦合），
   * 所以必须自己补 —— 漏掉它表现为
   * `registration.adapter.prepareCall is not a function`：**选模型即报错**。
   *
   * 语义（与宿主基类一致）：返回的 `model` 是该模型的精确元数据，
   * `stream` 是**同一次准备代际**的流入口。
   *
   * @param {string} provider
   * @param {string} model
   * @param {AbortSignal} [signal]
   */
  async prepareCall(provider, model, signal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => this.stream(options),
    }
  }

  /**
   * 流式调用。
   *
   * ⚠ 失败以 **terminal `finish` 错误 chunk** 收尾（DSH 契约：每次流恰好一个终止 chunk），
   * 而不是抛异常 —— 抛异常会让 agent-loop 把整步标成插件崩溃。
   *
   * @param {any} options DSH GenerateOptions
   */
  stream(options) {
    const adapter = this
    return (async function* () {
      const provider = options.provider ?? adapter.#provider
      const translator = new AnthropicStreamTranslator()
      let failure
      try {
        const resolved = findModel(await adapter.#models(), options.model)
        const result = await adapter.#client.call({
          options: { ...options, provider },
          model: resolved,
          maxTokens: options.maxTokens,
          signal: options.signal,
          onRetry: (info) => adapter.#log(`[zcode] 重试（${info.reason}，第 ${info.attempt + 1} 次）：${info.message}`),
        })

        /** ① 先消费判定阶段缓冲的事件（含首个内容帧），② 再接续剩余流。 */
        for (const event of result.head) {
          for (const chunk of translator.push(event)) yield chunk
        }
        if (result.decoder !== undefined) {
          for (;;) {
            const next = await result.decoder.read()
            if (next.done === true) break
            for (const chunk of translator.push(next.value)) yield chunk
          }
        }
      } catch (error) {
        failure = {
          code: error?.code ?? 'PROVIDER_ERROR',
          message: error instanceof Error ? error.message : String(error),
        }
        adapter.#log(`[zcode] 调用失败（${failure.code}）：${failure.message}`)
      }

      if (failure !== undefined) {
        yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }
        /**
         * ⚠ 终止块形状：`{ type: 'finish', reason: { kind, failure } }`。
         * `BlockAssembler` 读 `chunk.reason`；kind 放顶层时宿主读到 undefined，
         * 会把这次失败静默吞成「正常结束」—— 重试与错误上报全部失效。
         */
        yield { type: 'finish', reason: { kind: 'error', failure } }
        return
      }
      if (translator.error !== undefined) {
        for (const chunk of translator.finish()) yield chunk
        return
      }
      for (const chunk of translator.finish()) yield chunk
    })()
  }
}

/**
 * pi-ai 回落适配器：只提供 provider 元数据，真正的 wire 由 `dsh-llm-pi-ai` 负责。
 *
 * 使用条件：profile 里同时启用 `llm-pi-ai`，并给它声明本插件暴露的 provider：
 *
 * ```yaml
 * - id: llm-pi-ai
 *   name: '@deepseek-ai/dsh-llm-pi-ai'
 *   config:
 *     providers:
 *       zcode-start-plan:
 *         displayName: ZCode Start Plan
 *         api: anthropic-messages
 *         baseURL: http://127.0.0.1:17899
 *         apiKeyEnv: ZCODE_START_PLAN_LOCAL_TOKEN
 *         models: [{ id: GLM-5.3-Flash, name: GLM-5.3-Flash }]
 * ```
 *
 * ⚠ 选它就意味着**放弃**本插件的切号/自动 captcha（那些在原生适配器里），
 * 只保留「本地端点 + captcha 产出」；默认配置里它是关的。
 */
export class PiAiZcodeStartPlanAdapter {
  #models
  #displayName

  constructor(options) {
    this.#models = options.models
    this.#displayName = options.displayName ?? 'ZCode Start Plan（pi-ai 路由）'
  }

  providerInfo(provider) {
    return { id: provider, name: this.#displayName }
  }

  /**
   * 重试策略。
   *
   * ⚠ **必须实现**：`ctx.llm.registerAdapter()` 在 `prepareRoutes` 里会**直接调用**
   * `adapter.providerRetryPolicy(provider)`（没有可选调用保护），漏掉它在宿主里报
   * `adapter.providerRetryPolicy is not a function`，整条路由注册失败 ——
   * 表现为「工具注册成功、模型列表里却没有」。
   *
   * 返回 `undefined` 表示用宿主默认策略：本插件的重试已由
   * `plan-client` 按上游错误表（3009 退避 / 3007 换 captcha / 3012 不重试）编排，
   * 不需要宿主再包一层。
   *
   * @param {string} _provider
   * @returns {undefined}
   */
  providerRetryPolicy(_provider) {
    return undefined
  }

  async listModels(provider) {
    return (await this.#models()).map((model) => toModelInfo(provider, model))
  }

  /**
   * 绑定「精确模型元数据」与「最终派发」。
   *
   * ⚠ 必须实现：宿主在真正发起请求前调用 `adapter.prepareCall(provider, model, signal)`；
   * 漏掉它表现为 `registration.adapter.prepareCall is not a function`（选模型即报错）。
   * 本回落适配器不自己发流（由 `dsh-llm-pi-ai` 负责），故 `stream` 交回宿主默认路径。
   *
   * @param {string} provider
   * @param {string} model
   * @param {AbortSignal} [signal]
   */
  async prepareCall(provider, model, signal) {
    const found = findModel(await this.#models(), model)
    const resolved = found === undefined ? { provider, id: model, name: model } : toModelInfo(provider, found)
    return { model: resolved, stream: undefined }
  }
}

/** 兜底模型表。 */
export { ZCODE_FALLBACK_MODELS }
