/**
 * 本地 Anthropic 兼容端点（**可选**，默认关闭）。
 *
 * 只有当用户想走 `dsh-llm-pi-ai` 路由（`api: anthropic-messages` + `baseURL`）时才需要它：
 * 此时请求从 DSH 的 pi-ai 适配器打到 `127.0.0.1:<port>/v1/messages`，本文件把它复用
 * 成一次 `ZcodePlanClient.call()`，再把上游事件以 Anthropic SSE 原样写回。
 *
 * ## 为什么端口与 token 必须固定/持久化
 *
 * profile 里配好的 `baseURL` 与 `apiKeyEnv` 指向它们；端口每次变、token 每次重新随机，
 * 那份配置就每次重启都失效（表现为 404 或 401）。故：
 * - 端口默认 17899（`config.endpoint.port`），被占用时回退随机并在日志/状态里如实告知；
 * - token 首次生成后落盘到数据目录（`endpoint-token.txt`，600）。
 */

import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 解析配置端口（`0` = 随机）。
 * @param {unknown} raw
 * @param {number} fallback
 */
export function resolvePort(raw, fallback = 17_899) {
  if (raw === undefined || raw === null || String(raw).trim().length === 0) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0 || value > 65_535) return fallback
  return Math.floor(value)
}

/** 解析访问 token：环境变量 → 数据目录文件 → 新生成后落盘。 */
export function resolveEndpointToken(dataDir, env = process.env) {
  const fromEnv = env['ZCODE_START_PLAN_TOKEN']?.trim()
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  const file = join(dataDir, 'endpoint-token.txt')
  try {
    if (existsSync(file)) {
      const saved = readFileSync(file, 'utf8').trim()
      if (saved.length >= 16) return saved
    }
  } catch {
    // 读不到就当没有（下面重新生成）。
  }
  const token = globalThis.crypto.randomUUID().replace(/-/g, '') + globalThis.crypto.randomUUID().replace(/-/g, '')
  try {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(file, token, { mode: 0o600 })
  } catch {
    // 落盘失败不阻塞（只是下次会换一个 token）。
  }
  return token
}

/**
 * 启动本地端点。
 *
 * @param {{
 *   port?: number,
 *   host?: string,
 *   token: string,
 *   planClient: import('./plan-client.js').ZcodePlanClient,
 *   models: () => Promise<Array<any>>,
 *   log?: (message: string) => void,
 * }} options
 */
export async function startLocalEndpoint(options) {
  const host = options.host ?? '127.0.0.1'
  const token = options.token
  const log = options.log ?? (() => {})
  const requestedPort = options.port ?? 17_899

  const server = createServer((req, res) => {
    void handle(req, res).catch((error) => {
      log(`[endpoint] 未捕获错误：${String(error)}`)
      try {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: String(error) } }))
      } catch {
        // 响应可能已开始。
      }
    })
  })

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', `http://${host}`)
    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }
    if (url.pathname === '/v1/models') {
      const models = await options.models()
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          data: models.map((model) => ({
            id: model.id,
            type: 'model',
            display_name: model.name ?? model.id,
            created_at: new Date(0).toISOString(),
          })),
          has_more: false,
        }),
      )
      return
    }
    if (url.pathname !== '/v1/messages' || req.method !== 'POST') {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `未知端点 ${url.pathname}` } }))
      return
    }
    if (req.headers['authorization'] !== `Bearer ${token}` && req.headers['x-api-key'] !== token) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: '本地端点访问令牌无效' } }))
      return
    }

    const raw = await readBody(req)
    let body
    try {
      body = JSON.parse(raw)
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: '请求体不是合法 JSON' } }))
      return
    }

    const streaming = body.stream === true || body.stream === 'true'
    const abort = new AbortController()
    res.on('close', () => {
      /** 客户端断开 → 立刻取消上游（否则白耗额度）。 */
      if (!res.writableEnded) abort.abort()
    })

    const result = await options.planClient.call({
      options: {
        ...toGenerateOptions(body),
        provider: 'zcode-start-plan',
        signal: abort.signal,
      },
      maxTokens: body.max_tokens,
      signal: abort.signal,
    })

    if (!streaming) {
      /**
       * 非流式：先读干 decoder 余量再折叠。
       * ⚠ `result.head` 只是「首帧切片」（plan-client 读到首帧就返回，好尽早判定
       * 零内容/业务错误）；正文增量全在 `result.decoder` 里。只折叠 head 会把回答
       * 截成开头几个字 —— 流式分支有读 decoder，这里此前漏了（pi-ai 路线几乎总走
       * 流式所以没暴露；ZCode CLI 冒烟实测踩中）。
       */
      const events = [...result.head]
      if (result.decoder !== undefined) {
        for (;;) {
          const next = await result.decoder.read()
          if (next.done === true) break
          events.push(next.value)
        }
      }
      const message = await collapseToMessage(events)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(message))
      return
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const writeEvent = (eventName, data) => {
      if (res.destroyed || res.writableEnded) return
      try {
        res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`)
      } catch {
        // 客户端已断开。
      }
    }
    for (const event of result.head) {
      if (event.data === undefined) continue
      writeEvent(event.event ?? event.data?.type ?? 'message', event.data)
    }
    if (result.decoder !== undefined) {
      for (;;) {
        const next = await result.decoder.read()
        if (next.done === true) break
        if (next.value.data === undefined) continue
        writeEvent(next.value.event ?? next.value.data?.type ?? 'message', next.value.data)
      }
    }
    if (!res.destroyed) res.end()
  }

  const listen = (port) =>
    new Promise((resolve, reject) => {
      const onError = (error) => {
        server.removeListener('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        server.removeListener('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, host)
    })

  let actualPort
  try {
    await listen(requestedPort)
    actualPort = server.address().port
  } catch (error) {
    if (requestedPort === 0 || (error?.code !== 'EADDRINUSE' && error?.code !== 'EACCES')) throw error
    log(`[endpoint] ⚠ 端口 ${requestedPort} 不可用（${error.code}），已回退随机端口`)
    await listen(0)
    actualPort = server.address().port
  }

  const baseUrl = `http://${host}:${actualPort}`
  log(`[endpoint] 已监听 ${baseUrl}`)

  return {
    port: actualPort,
    baseUrl,
    token,
    async close() {
      await new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

/** 读完整请求体。 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * 把 Anthropic Messages 请求体翻成 DSH 的 GenerateOptions。
 *
 * pi-ai 发来的 body 已经是 Anthropic 形态（`system` / `messages` / `tools`），
 * 这里逆变换回 DSH 词汇，好让 `buildUpstreamBody` 再统一注入身份块与日期块。
 */
export function toGenerateOptions(body) {
  const systemText = Array.isArray(body.system)
    ? body.system.filter((block) => block?.type === 'text').map((block) => block.text).join('\n\n')
    : typeof body.system === 'string'
      ? body.system
      : undefined

  const messages = (Array.isArray(body.messages) ? body.messages : []).map((message) => ({
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content: toDshContent(message.content),
  }))

  const tools = (Array.isArray(body.tools) ? body.tools : []).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema ?? tool.parameters,
  }))

  return {
    model: body.model,
    ...(systemText !== undefined ? { system: [{ type: 'text', text: systemText }] } : {}),
    messages,
    ...(tools.length > 0 ? { tools } : {}),
    ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
  }
}

/** Anthropic content → DSH content blocks。 */
function toDshContent(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (!Array.isArray(content)) return []
  const out = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') out.push({ type: 'text', text: block.text })
    else if (block?.type === 'tool_use') {
      out.push({ type: 'tool-call', id: block.id, name: block.name, arguments: block.input ?? {} })
    } else if (block?.type === 'tool_result') {
      out.push({
        type: 'tool-result',
        toolCallId: block.tool_use_id,
        output: typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? ''),
        isError: block.is_error === true,
      })
    } else if (block?.type === 'image' && block.source?.type === 'base64') {
      out.push({
        type: 'image',
        source: { type: 'base64', media_type: block.source.media_type, data: block.source.data },
      })
    }
  }
  return out
}

/** 把一段流事件折叠成一个 Anthropic message（非流式请求用）。 */
async function collapseToMessage(head) {
  const content = []
  let usage = { input_tokens: 0, output_tokens: 0 }
  let stopReason = 'end_turn'
  const partialJson = new Map()
  for (const event of head) {
    const data = event.data
    if (data === undefined) continue
    if (data.type === 'message_start') {
      usage = { ...usage, ...(data.message?.usage ?? {}) }
    } else if (data.type === 'content_block_start') {
      content[data.index] = { ...data.content_block }
      if (data.content_block?.type === 'tool_use') partialJson.set(data.index, data.content_block.input ?? '')
    } else if (data.type === 'content_block_delta') {
      const block = content[data.index]
      if (block === undefined) continue
      const delta = data.delta ?? {}
      if (delta.type === 'text_delta') block.text = (block.text ?? '') + delta.text
      else if (delta.type === 'thinking_delta') block.thinking = (block.thinking ?? '') + delta.thinking
      else if (delta.type === 'input_json_delta') {
        const current = partialJson.get(data.index) ?? ''
        partialJson.set(data.index, current + delta.partial_json)
      }
    } else if (data.type === 'message_delta') {
      if (typeof data.delta?.stop_reason === 'string') stopReason = data.delta.stop_reason
      usage = { ...usage, ...(data.usage ?? {}) }
    }
  }
  for (const [index, raw] of partialJson) {
    const block = content[index]
    if (block === undefined) continue
    try {
      block.input = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw
    } catch {
      block.input = {}
    }
  }
  return {
    id: `msg_${Math.random().toString(36).slice(2)}`,
    type: 'message',
    role: 'assistant',
    model: 'zcode-start-plan',
    content: content.filter(Boolean),
    stop_reason: stopReason,
    stop_sequence: null,
    usage,
  }
}
