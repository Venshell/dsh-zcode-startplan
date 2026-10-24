/**
 * Anthropic SSE 事件 → DSH `StreamChunk` 的翻译器。
 *
 * ## DSH 侧的需要（与参考实现的关键差异）
 *
 * 参考实现是一层 **HTTP 代理**：它把上游字节原样透传给 ZCode（ZCode 自带 Anthropic SDK）。
 * DSH 没有这层字节通道 —— 插件必须自己实现 `llm` 适配器，产出 DSH 的
 * `StreamChunk` 词汇（`text-delta` / `reasoning-delta` / `tool-call-delta` / `usage` /
 * `finish`，以 `block-start` / `block-end` 包住），并由 `ctx.llm` 的 `BlockAssembler`
 * 组装成消息。本文件就是这段翻译。
 *
 * ## 协议要点（Anthropic Messages 流式）
 *
 * ```
 * message_start                   → 记录 usage.input_tokens / model
 * content_block_start(index,T)    → 开一个块（text / thinking / tool_use）
 * content_block_delta(index,D)    → 增量（text_delta / thinking_delta / input_json_delta）
 * content_block_stop(index)       → 关块
 * message_delta(delta.stop_reason) → 记录 stop_reason 与 usage.output_tokens
 * message_stop                    → 流结束
 * error                           → 上游错误（含 3012 等业务码）
 * ```
 *
 * ## 顺序约束（DSH 协议）
 *
 * `usage` 必须在 `finish` 之前；`finish` 之后不得再有任何 chunk；工具参数以
 * **原始 JSON 字符串**增量下发。故这里采用「先 `block-end`，再 `usage`，再 `finish`」。
 */

/**
 * 翻译器：逐事件喂入，产出 DSH chunk 数组。
 *
 * @param {{ supportsReasoning?: boolean }} [options]
 */
export class AnthropicStreamTranslator {
  #blocks = new Map()
  #nextChunkIndex = 0
  #model
  #finishReason
  #usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  #sawMessageStart = false
  #sawError

  /** 上游报出来的错误（若在流内出现）。 */
  get error() {
    return this.#sawError
  }

  /** 已看到的模型名（message_start 里带的，可能与请求不同）。 */
  get model() {
    return this.#model
  }

  /** 累积用量。 */
  get usage() {
    return { ...this.#usage }
  }

  /**
   * 喂入一个已解析的 SSE 事件。
   *
   * @param {{ event?: string, data?: any, unparsed?: boolean }} sseEvent
   * @returns {Array<any>} DSH chunk 列表（可能为空）
   */
  push(sseEvent) {
    const data = sseEvent?.data
    if (data === undefined) return []
    /** `[DONE]` 哨兵：部分兼容网关会发，忽略。 */
    if (data === '[DONE]') return []

    switch (data.type) {
      case 'message_start': {
        this.#sawMessageStart = true
        this.#model = data.message?.model
        this.#mergeUsage(data.message?.usage)
        return []
      }
      case 'content_block_start': {
        const index = data.index ?? this.#blocks.size
        const block = data.content_block ?? {}
        const chunkIndex = this.#nextChunkIndex++
        /**
         * ⚠ **DSH `BlockAssembler` 的确切契约**（`dsh-llm/lib/index.js`）：
         *
         *   case "block-start":  partials.set(index, { blockType: chunk.blockType, ... })
         *   case "text-delta" / "reasoning-delta": partial.text += chunk.text
         *   case "tool-call-delta": toolCallId = chunk.id; toolCallName = chunk.name;
         *                            toolCallArguments += chunk.argumentsDelta
         *   case "block-end":    partial.block = chunk.block   ← 必须带完整 block
         *
         * 也就是说：`block-start` 用 **`blockType`（字符串）**，不是 `block`（对象）；
         * `block-end` **必须**带 `block`（assemble 直接返回它，否则按 blockType 兜底拼装，
         * 丢字段）；`tool-call-delta` 的字段名是 `id` / `name` / **`argumentsDelta`**。
         *
         * 之前我发的是 `{ block: {...} }` / `{ arguments }` —— `blockType` 读到 undefined，
         * 宿主侧 `partial.blockType` 解引用即抛
         * `Cannot read properties of undefined (reading 'type')`（思考型模型先出 reasoning 块，
         * 所以只有 Flash 这类模型才暴露）。
         */
        const entry = { chunkIndex, kind: block.type, id: block.id, name: block.name, text: '' }
        this.#blocks.set(index, entry)

        if (block.type === 'text') {
          const out = [{ type: 'block-start', index: chunkIndex, blockType: 'text' }]
          if (typeof block.text === 'string' && block.text.length > 0) {
            entry.text = block.text
            out.push({ type: 'text-delta', index: chunkIndex, text: block.text })
          }
          return out
        }
        if (block.type === 'thinking') {
          const out = [{ type: 'block-start', index: chunkIndex, blockType: 'reasoning' }]
          if (typeof block.thinking === 'string' && block.thinking.length > 0) {
            entry.text = block.thinking
            out.push({ type: 'reasoning-delta', index: chunkIndex, text: block.thinking })
          }
          return out
        }
        if (block.type === 'tool_use') {
          return [
            {
              type: 'block-start',
              index: chunkIndex,
              blockType: 'tool-call',
            },
          ]
        }
        /** 其它块（如 redacted_thinking）：开一个 reasoning 块以保持块序，但无内容可下发。 */
        return [{ type: 'block-start', index: chunkIndex, blockType: 'reasoning' }]
      }
      case 'content_block_delta': {
        const entry = this.#blocks.get(data.index)
        if (entry === undefined) return []
        const delta = data.delta ?? {}
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          entry.text += delta.text
          return [{ type: 'text-delta', index: entry.chunkIndex, text: delta.text }]
        }
        if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          entry.text += delta.thinking
          return [{ type: 'reasoning-delta', index: entry.chunkIndex, text: delta.thinking }]
        }
        if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          entry.arguments = (entry.arguments ?? '') + delta.partial_json
          return [
            {
              type: 'tool-call-delta',
              index: entry.chunkIndex,
              id: entry.id,
              name: entry.name,
              argumentsDelta: delta.partial_json,
            },
          ]
        }
        return []
      }
      case 'content_block_stop': {
        const entry = this.#blocks.get(data.index)
        if (entry === undefined) return []
        this.#blocks.delete(data.index)
        return [{ type: 'block-end', index: entry.chunkIndex, block: this.#assembleBlock(entry) }]
      }
      case 'message_delta': {
        if (typeof data.delta?.stop_reason === 'string') {
          this.#finishReason = mapStopReason(data.delta.stop_reason)
        }
        this.#mergeUsage(data.usage)
        return []
      }
      case 'message_stop':
        return []
      case 'error': {
        this.#sawError = {
          type: data.error?.type,
          message: data.error?.message ?? JSON.stringify(data.error ?? data),
        }
        return []
      }
      case 'ping':
      default:
        return []
    }
  }

  /**
   * 把一个块累积成 DSH 的**完整 block 对象**（`block-end` 必须带它）。
   *
   * 字段名与 `BlockAssembler.assemble()` 的输出严格一致：
   *   text     → { type: 'text', text }
   *   reasoning→ { type: 'reasoning', text }
   *   tool-call→ { type: 'tool-call', id, name, arguments }
   *
   * @param {{ kind: string, id?: string, name?: string, text: string, arguments?: string }} entry
   */
  #assembleBlock(entry) {
    if (entry.kind === 'tool_use' || entry.kind === 'tool-call') {
      /** 工具参数是**原始 JSON 字符串**（宿主不做解析）。 */
      let args = entry.arguments ?? ''
      if (args.length === 0) args = '{}'
      return {
        type: 'tool-call',
        id: entry.id ?? `call_${entry.chunkIndex}`,
        name: entry.name ?? '',
        arguments: args,
      }
    }
    if (entry.kind === 'thinking' || entry.kind === 'redacted_thinking' || entry.kind === 'reasoning') {
      return { type: 'reasoning', text: entry.text ?? '' }
    }
    return { type: 'text', text: entry.text ?? '' }
  }

  /** 收尾：补 `usage` 与 `finish`（顺序固定）。 */
  finish() {
    const out = []
    for (const [index, entry] of this.#blocks) {
      this.#blocks.delete(index)
      out.push({ type: 'block-end', index: entry.chunkIndex, block: this.#assembleBlock(entry) })
    }
    out.push({ type: 'usage', usage: this.#usage })
    if (this.#sawError !== undefined) {
      out.push({
        type: 'finish',
        kind: 'error',
        failure: { code: mapErrorCode(this.#sawError), message: this.#sawError.message },
      })
      return out
    }
    out.push({ type: 'finish', kind: 'stop', reason: this.#finishReason ?? 'stop' })
    return out
  }

  #mergeUsage(usage) {
    if (typeof usage !== 'object' || usage === null) return
    const input = usage.input_tokens ?? usage.inputTokens
    const output = usage.output_tokens ?? usage.outputTokens
    const cacheRead = usage.cache_read_input_tokens ?? usage.cacheReadInputTokens
    const cacheWrite = usage.cache_creation_input_tokens ?? usage.cacheWriteInputTokens
    if (typeof input === 'number') this.#usage.inputTokens = input
    if (typeof output === 'number') this.#usage.outputTokens = output
    if (typeof cacheRead === 'number') this.#usage.cacheReadTokens = cacheRead
    if (typeof cacheWrite === 'number') this.#usage.cacheWriteTokens = cacheWrite
  }
}

/** Anthropic `stop_reason` → DSH finish reason。 */
export function mapStopReason(stopReason) {
  switch (stopReason) {
    case 'tool_use':
      return 'tool-calls'
    case 'max_tokens':
      return 'length'
    case 'end_turn':
    case 'stop_sequence':
      return 'stop'
    default:
      return 'stop'
  }
}

/**
 * 业务码 → DSH 失败码。
 *
 * DSH 的稳定码：`AUTH` / `RATE_LIMIT` / `QUOTA` / `NO_ADAPTER` / `MISSING_CREDENTIAL` …
 * 消费者按 code 路由，**绝不**按 message 文本。
 */
export function mapErrorCode(error) {
  const text = String(error?.message ?? '')
  if (text.includes('3012') || text.includes('3007')) return 'RATE_LIMIT'
  if (text.includes('1005') || text.includes('1113') || text.includes('1003')) return 'QUOTA'
  if (text.includes('1002') || /invalid\s+token|token\s+expired/i.test(text)) return 'AUTH'
  if (error?.type === 'authentication_error') return 'AUTH'
  if (error?.type === 'rate_limit_error') return 'RATE_LIMIT'
  return 'PROVIDER_ERROR'
}
