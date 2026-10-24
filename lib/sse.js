/**
 * SSE / JSON 响应首部判定（**「秒回空」检测**）。
 *
 * 上游在「该账号对该模型无权益」时会返回 **HTTP 200 + 一个没有任何内容帧的 SSE 流**。
 * 若直接当正文消费，用户看到的是「模型返回了空响应」；正确处理是**换账号重试**。
 *
 * 透传与重试天然冲突：一旦把内容交给调用方就不能再重试（会出现两份输出）。
 * 故这里**先读到出现内容再决定**：
 * - 见到内容 → 把缓冲的事件原样交给调用方，后续继续流式解析；
 * - 流结束仍无内容 → 判定为无权益，调用方换号重试（调用方**一个 chunk 都没收到**）。
 *
 * ⚠ 判定必须按媒体类型分流：上游对**不带 `stream` 的请求返回单个 JSON message**；
 * 若只用 SSE 特征串去扫，一个正常有内容的 JSON 会被判成「零内容」，
 * 于是①客户端拿到空响应 ②**该账号被错误标记限流到当日结束**。
 */

/** SSE 内容帧的特征串（覆盖文本、思考、工具调用三类）。 */
const CONTENT_MARKERS = [
  'content_block_delta',
  'text_delta',
  'thinking_delta',
  'input_json_delta',
  '"type":"tool_use"',
  '"type": "tool_use"',
]

/** 缓冲上限（异常大的首帧不能无限缓冲；超限即按「有内容」放行，宁可让它自己失败也不要 OOM）。 */
export const DEFAULT_MAX_BUFFER_BYTES = 256 * 1024

/** 是否按 JSON（非流式）形态判定。 */
export function isJsonContentType(contentType) {
  if (contentType === undefined) return false
  const lower = String(contentType).toLowerCase()
  return lower.includes('application/json') && !lower.includes('event-stream')
}

/**
 * 从**已解析的 JSON message** 判断是否真有内容。
 * 只认「有实际产物的块」：文本非空 / 思考非空 / 工具调用块本身即内容。
 */
export function jsonHasContent(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    // 解析不动就保守按「有内容」：不要冤枉账号。
    return true
  }
  if (typeof parsed !== 'object' || parsed === null) return false
  /** 错误载荷算「有响应」，由调用方的错误处理负责 —— 不能当成额度耗尽去换号。 */
  if (parsed.type === 'error' || parsed.error !== undefined) return true
  const content = parsed.content
  if (!Array.isArray(content)) {
    const output = parsed.usage?.output_tokens
    return typeof output === 'number' && output > 0
  }
  for (const raw of content) {
    if (typeof raw !== 'object' || raw === null) continue
    if (raw.type === 'tool_use') return true
    if (raw.type === 'text' && typeof raw.text === 'string' && raw.text.length > 0) return true
    if (raw.type === 'thinking' && typeof raw.thinking === 'string' && raw.thinking.length > 0) return true
    if (raw.type === 'redacted_thinking') return true
  }
  return false
}

/**
 * 把字节流切成 SSE 事件（`data:` 行拼装）。返回 async generator（产出原始事件对象）。
 *
 * 解析同时保留**原始字节**，以便调用方在「判定有内容」后能原样重放首部。
 */
export async function* readSseEvents(body, options = {}) {
  const decode = makeSseDecoder(body, options)
  try {
    for (;;) {
      const next = await decode.read()
      if (next.done === true) return
      yield next.value
    }
  } finally {
    await decode.cancel()
  }
}

/**
 * 构造一个「可交接」的 SSE 解码器。
 *
 * ⚠ 为什么不是 `async function*`：`readContentHead` 判定出「有内容」后要**继续**用同一个
 * 读取器消费剩余事件（首部事件已缓冲）。生成器无法把内部 `reader` 交出去而不丢失已读字节，
 * 所以这里显式暴露 `read()` / `cancel()`，由两处共享。
 *
 * @param {ReadableStream<Uint8Array>} body
 * @param {{ timeoutMs?: number }} [options]
 */
export function makeSseDecoder(body, options = {}) {
  const decoder = new TextDecoder()
  const reader = body.getReader()
  const timeoutMs = options.timeoutMs ?? 180_000
  let buffer = ''
  let finished = false
  /** 已读到但还没返回的完整事件（`\n\n` 分隔）。 */
  const ready = []

  const pump = async () => {
    const chunk = await Promise.race([
      reader.read(),
      new Promise((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`读取上游响应超时（${timeoutMs}ms）`)), timeoutMs)
        timer.unref?.()
      }),
    ])
    if (chunk.done === true) {
      finished = true
      /**
       * ⚠ 必须先 flush `TextDecoder`（多字节字符可能被拆在 chunk 边界）：
       * 不 flush 会让同一个网络包里到达的**最后一个事件**在 EOF 时被吞掉——
       * 表现为「只收到第一个 text-delta，后面全丢」（实测抓到的真实缺陷）。
       */
      buffer += decoder.decode()
      const tail = buffer.trim()
      buffer = ''
      if (tail.length > 0) {
        const event = parseSseEvent(tail)
        if (event !== undefined) ready.push(event)
      }
      return
    }
    if (chunk.value === undefined) return
    buffer += decoder.decode(chunk.value, { stream: true })
    for (;;) {
      const match = /\r?\n\r?\n/.exec(buffer)
      if (match === null) break
      const raw = buffer.slice(0, match.index)
      buffer = buffer.slice(match.index + match[0].length)
      const event = parseSseEvent(raw)
      if (event !== undefined) ready.push(event)
    }
  }

  return {
    /** 读下一个事件；流结束返回 `{ done: true }`。 */
    async read() {
      for (;;) {
        const queued = ready.shift()
        if (queued !== undefined) return { done: false, value: queued }
        if (finished) return { done: true }
        await pump()
        /** 空事件块（`: keep-alive` 注释）不产出任何东西，继续读。 */
      }
    },
    /** 取消读取（客户端断开 / 换号重试时立刻释放上游连接）。 */
    async cancel() {
      if (finished) return
      finished = true
      try {
        await reader.cancel()
      } catch {
        // 已结束。
      }
    },
    /** 是否已读完。 */
    get done() {
      return finished && ready.length === 0
    },
  }
}

/** 解析一个 SSE 事件块；无 `data:` 行返回 undefined。 */
export function parseSseEvent(raw) {
  const lines = raw.split(/\r?\n/)
  let eventName
  const dataLines = []
  for (const line of lines) {
    if (line.length === 0 || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') eventName = value
    else if (field === 'data') dataLines.push(value)
  }
  if (dataLines.length === 0) return undefined
  const data = dataLines.join('\n')
  if (data === '[DONE]') return { event: eventName, data: '[DONE]' }
  try {
    return { event: eventName, data: JSON.parse(data), raw: data }
  } catch {
    return { event: eventName, data: undefined, raw: data, unparsed: true }
  }
}

/**
 * 「先读到出现内容或流结束」——返回 `{ hasContent, head, elapsedMs, decoder, upstreamError }`。
 *
 * `head` 是**已解析但尚未交给调用方**的初始事件（含内容帧），调用方在决定「确实有内容」
 * 后按序消费它，再接续后面的流。
 *
 * ⚠ **上游会把业务错误塞进 HTTP 200**（实测：`{"code":1005,"msg":"exceed quota limit"}`
 * 配 `200 + application/json`）。若不识别，就会被当成「无权益的空响应」，
 * 于是丢掉真正的错误码（`1005` 额度用尽 / `3012` 风控 / `3009` 并发限流），
 * 排查时只看到误导性的「200 但零内容」。故这里先做业务错误识别。
 */
export async function readContentHead(body, options = {}) {
  const startedAt = Date.now()
  const maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES
  const jsonMode = isJsonContentType(options.contentType)
  const head = []
  let scannedBytes = 0

  if (jsonMode) {
    const text = await new Response(body).text()
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = undefined
    }
    /** 业务错误（HTTP 200 + `{code,msg}`）：先于「有没有内容」判定。 */
    const upstreamError = extractUpstreamError(parsed, text)
    if (upstreamError !== undefined) {
      return {
        hasContent: false,
        head,
        elapsedMs: Date.now() - startedAt,
        jsonMode: true,
        decoder: undefined,
        upstreamError,
      }
    }
    const hasContent = jsonHasContent(text)
    if (hasContent) head.push({ data: parsed, raw: text })
    return { hasContent, head, elapsedMs: Date.now() - startedAt, jsonMode: true, decoder: undefined }
  }

  const decoder = makeSseDecoder(body, { timeoutMs: options.timeoutMs })
  for (;;) {
    const next = await decoder.read()
    if (next.done === true) {
      await decoder.cancel()
      return { hasContent: false, head, elapsedMs: Date.now() - startedAt, jsonMode: false, decoder }
    }
    const event = next.value
    head.push(event)
    scannedBytes += (event.raw ?? '').length
    /** 流内错误事件（Anthropic `{"type":"error"}`）也算业务错误，交给调用方按错误表处置。 */
    const upstreamError = extractUpstreamError(event.data, event.raw ?? '')
    if (upstreamError !== undefined) {
      await decoder.cancel()
      return {
        hasContent: false,
        head,
        elapsedMs: Date.now() - startedAt,
        jsonMode: false,
        decoder,
        upstreamError,
      }
    }
    const marker = CONTENT_MARKERS.some((needle) => (event.raw ?? '').includes(needle)) || hasVisibleBlock(event.data)
    if (marker || scannedBytes >= maxBufferBytes) {
      /** 把解码器交给调用方继续消费（而非丢弃剩余事件）。 */
      return { hasContent: true, head, elapsedMs: Date.now() - startedAt, jsonMode: false, decoder }
    }
  }
}

/**
 * 从已解析的载荷里识别**上游业务错误**。
 *
 * 认三种形态：
 * - `{"code":1005,"msg":"..."}`（本渠道实测形态，状态码仍是 200）
 * - `{"type":"error","error":{...}}`（Anthropic 标准错误）
 * - `{"error":{"code":1005,...}}`（个别网关的包裹形态）
 *
 * @param {unknown} parsed
 * @param {string} raw
 * @returns {{ status: number, text: string } | undefined}
 */
export function extractUpstreamError(parsed, raw) {
  if (typeof parsed === 'object' && parsed !== null) {
    const record = /** @type {Record<string, any>} */ (parsed)
    /** Anthropic 标准错误载荷。 */
    if (record.type === 'error' && record.error !== undefined) {
      return { status: 200, text: JSON.stringify(record) }
    }
    /**
     * 业务码形态：`code` 非 0 且不是字符串型成功码。
     * 注意 `code: 0` = 成功，不能被当成错误。
     */
    const code = record.code ?? record.error?.code
    if (typeof code === 'number' && code !== 0) {
      return { status: 200, text: JSON.stringify({ code, msg: record.msg ?? record.message ?? record.error?.message ?? '' }) }
    }
    /** 裸 `error` 字段（无 code）。 */
    if (record.error !== undefined && typeof record.error === 'object') {
      return { status: 200, text: JSON.stringify(record) }
    }
  }
  return undefined
}

/** 事件里是否出现了可见块（结构性判定，比扫特征串更稳）。 */
function hasVisibleBlock(data) {
  if (typeof data !== 'object' || data === null) return false
  if (data.type === 'content_block_start') {
    const block = data.content_block
    if (block?.type === 'tool_use') return true
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.length > 0) return true
    if (block?.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.length > 0) return true
  }
  if (data.type === 'content_block_delta') {
    const delta = data.delta
    if (delta?.type === 'text_delta' && typeof delta.text === 'string' && delta.text.length > 0) return true
    if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking.length > 0) return true
    if (delta?.type === 'input_json_delta') return true
  }
  return false
}
