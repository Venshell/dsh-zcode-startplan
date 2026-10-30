/**
 * 本地 **OpenAI 兼容端点**：`/v1/chat/completions` + `/v1/models`。
 *
 * ## 它是什么 / 不是什么
 *
 * 本文件与 `local-endpoint.js`（Anthropic 格式 `/v1/messages`）**并列**：
 * 两者都是「把 DSH 的 StreamChunk 翻译成某个 HTTP 协议」的出口，回落到同一个
 * `planClient.call()` —— 账号池、换号、captcha、限流全部复用，不另起一套。
 *
 * 用途：让**任意 OpenAI 兼容客户端**（Codex / Cline / Continue / 自写脚本）
 * 直接用 `baseURL = http://127.0.0.1:<port>/v1` + `apiKey = <插件生成的 key>`
 * 消耗账号池额度。
 *
 * ## 与 `local-endpoint.js` 的取舍
 *
 * 那份 Anthropic 出口是「原样转发上游 SSE」，字节级透传、零翻译，可靠但只服务
 * 一类客户端。OpenAI 这边**必须真翻译**（两边 chunk 词汇完全不同），故这里
 * 严格对齐参考实现 `deepseek-harness-codearts` 的 `openai-gateway/` 三件套
 * （`stream.ts` / `messages.ts` / `auth.ts`）的实测结论 —— 尤其下面这几个坑：
 *
 * | 坑 | 症状 | 对策 |
 * |---|---|---|
 * | `typeof x === 'string'` vs `!== undefined` | 真实 SSE 里 `content` 与 `reasoning_content` **另一侧恒为 null** ⇒ `.length` 在 null 上崩，首帧就炸 | 一律 `typeof === 'string'` |
 * | 孤儿 `tool` 消息 | 上游 400，而坏历史每轮原样重放 ⇒ **会话永久报废** | 发请求前剔除配对已坏的结果 |
 * | 分片带空 `function.name` | 清空已解析的工具名 ⇒ `unknown tool ""` | 只接受非空覆盖 |
 * | 上游 `{status:200}` 表业务失败 | 原样透出会让「额度用尽」在客户端眼里读成**成功** | 状态码门禁 400–599 |
 */

import { createServer } from 'node:http'
import { randomUUID, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { checkDistributionKey } from './distribution-keys.js'
import { join } from 'node:path'

/** 单次请求体上限（防止一个坏客户端把内存吃穿）。 */
const BODY_LIMIT_BYTES = 32 * 1024 * 1024

/**
 * key 的形态判据：`randomBytes(32).toString('base64url')` 的产物
 * （32 字节 → 定长 43 位，字符集 `[A-Za-z0-9_-]`）。
 *
 * ⚠ **定长**是关键：它让「文件里是我们写的东西」可以被机械判定，从而把
 * 「损坏」与「用户自己换过」区分开。
 */
const KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/

/**
 * 读取网关 apiKey；没有就生成一次并持久化。
 *
 * ## 为什么「文件损坏」要报错而不是换掉（参考实现实证）
 *
 * 「读不到就重新生成」看似自愈，实则：文件被误删/手工改坏时服务端会**悄悄
 * 换一个全新 key**，所有已配置的客户端同时开始 `401 unauthorized` —— 而客户端
 * 只给这一句，用户无从判断是自己粘错了哪一位还是服务端变了。
 *
 * 故区分三种情况：
 * - 不存在 / 空 ⇒ 从未生成过，正常生成；
 * - 符合 {@link KEY_PATTERN} ⇒ 采信；
 * - 有值但不符合 ⇒ **明确报错**并给恢复办法。
 *
 * @param {string} dataDir
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ value: string, fromEnv: boolean, path: string | null }}
 */
export function resolveOpenAiApiKey(dataDir, env = process.env) {
  const fromEnv = env['DSH_OPENAI_GATEWAY_API_KEY']?.trim()
  if (typeof fromEnv === 'string' && fromEnv.length > 0) {
    return { value: fromEnv, fromEnv: true, path: null }
  }
  const file = join(dataDir, 'openai-api-key')
  let stored
  try {
    if (existsSync(file)) stored = readFileSync(file, 'utf8').trim()
  } catch {
    // 不可读 → 走生成路径。
  }
  if (typeof stored === 'string' && stored.length > 0) {
    if (KEY_PATTERN.test(stored)) return { value: stored, fromEnv: false, path: file }
    throw new Error(
      `网关 apiKey 文件内容异常（不是本插件生成的形态）：${file}。`
      + '本插件不会静默更换它，否则已配置的客户端会全部失效。'
      + '如需更换：删除该文件后重启 DSH（会重新生成），或改用 DSH_OPENAI_GATEWAY_API_KEY。',
    )
  }
  const value = randomBytes(32).toString('base64url')
  try {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(file, value, { mode: 0o600 })
  } catch {
    // 落盘失败不阻塞（只是下次会换一个 key）。
  }
  return { value, fromEnv: false, path: file }
}

/**
 * 启动 OpenAI 兼容端点。
 *
 * @param {{
 *   port?: number,
 *   host?: string,
 *   token: string,
 *   planClient: any,
 *   models: () => Promise<Array<any>>,
 *   log?: (message: string) => void,
 * }} options
 */
export async function startOpenAiGateway(options) {
  const host = options.host ?? '127.0.0.1'
  const token = options.token
  const log = options.log ?? (() => {})
  const requestedPort = options.port ?? 17_900

  const server = createServer((req, res) => {
    void handle(req, res).catch((error) => {
      log(`[openai-gateway] 未捕获错误：${String(error)}`)
      try {
        jsonError(res, 500, 'server_error', String(error))
      } catch {
        // 响应可能已开始。
      }
    })
  })

  async function handle(req, res) {
    /** CORS 预检：本地工具站点跨源调它不至于全挂。 */
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'Authorization, Content-Type',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
      })
      res.end()
      return
    }
    const url = new URL(req.url ?? '/', `http://${host}`)

    /** 健康检查刻意**不需要** key（探活工具不该持凭据）。 */
    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }

    /**
     * 鉴权两级（0.9.4）：主 apiKey **或**分发 key。
     * 分发 key 走限额/禁用判定 + （可选）钉定账号；命中即记 `distKey`，
     * 请求结束后记账。
     */
    const presented = extractBearer(req)
    let distKey
    if (presented !== token) {
      distKey = options.findDistributionKey?.(presented)
      const rejection = distKey === undefined ? '无效的分发 key' : checkDistributionKey(distKey)
      if (rejection !== null) {
        jsonError(res, distKey === undefined ? 401 : 429, 'quota_exceeded', rejection)
        return
      }
    }

    if (url.pathname === '/v1/models' && req.method === 'GET') {
      const models = await options.models().catch(() => [])
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          object: 'list',
          data: models.map((model) => ({
            id: model.id,
            object: 'model',
            created: 0,
            owned_by: 'zcode-start-plan',
          })),
        }),
      )
      return
    }

    if (url.pathname !== '/v1/chat/completions' || req.method !== 'POST') {
      jsonError(res, 404, 'not_found', `未知端点 ${url.pathname}（支持 GET /v1/models、POST /v1/chat/completions）`)
      return
    }

    let body
    try {
      body = JSON.parse(await readBody(req))
    } catch (error) {
      jsonError(res, error?.code === 'BODY_TOO_LARGE' ? 413 : 400, 'invalid_request_error', String(error?.message ?? error))
      return
    }

    let generateOptions
    try {
      generateOptions = toGenerateOptions(body)
    } catch (error) {
      jsonError(res, 400, 'invalid_request_error', String(error?.message ?? error))
      return
    }

    const abort = new AbortController()
    res.on('close', () => {
      /** 客户端断开 → 立刻取消上游（否则白耗额度）。 */
      if (!res.writableEnded) abort.abort()
    })

    const streaming = body?.stream === true || body?.stream === 'true'
    const model = typeof body?.model === 'string' ? body.model : 'zcode-start-plan'
    const requestId = `chatcmpl-${randomUUID()}`

    /**
     * 分发 key 钉定账号（0.9.4）：`accountId` 非空 ⇒ 强制选号到该账号
     * （plan-client 的 `pinnedAccountId` 语义：只看它、绝不换号）。
     * 未绑定 = 整个账号池按 expiry 顺序选号。
     * ⚠ provider 保持基础名（钉定语义由 `pinnedAccountId` 承载，不经 @acct 后缀）。
     */
    const pinnedOptions = distKey?.accountId
      ? { ...generateOptions, provider: 'zcode-start-plan', pinnedAccountId: distKey.accountId }
      : { ...generateOptions, provider: 'zcode-start-plan' }

    const result = await options.planClient.call({
      options: pinnedOptions,
      maxTokens: generateOptions.maxTokens,
      signal: abort.signal,
    })

    /**
     * 把 head + decoder 余量合成一条异步序列。
     *
     * ⚠ `result.decoder` **不是**异步生成器，而是
     * `{ read(): Promise<{done, value?}>, cancel? }`（见 plan-client.js 的返回
     * 类型注释）。此前误当生成器 `for await` 消费，运行期报
     * `result.decoder.read is not a function` —— 而它被 catch 兜住后只发一帧
     * error chunk，表现为「流式回答只有一个 reasoning 帧就断了」。
     */
    const chunks = (async function* () {
      for (const event of result.head ?? []) yield event
      const decoder = result.decoder
      if (decoder !== undefined && typeof decoder.read === 'function') {
        for (;;) {
          const next = await decoder.read()
          if (next === undefined || next.done === true) break
          if (next.value !== undefined) yield next.value
        }
      }
    })()

    /**
     * 分发 key 的用量记账（0.9.4）：从 chunk 流里收 usage，请求收尾时回写。
     * 只有产出（usage 块存在）才计 —— 被拒/上游失败的请求不消耗额度。
     * 回写走 `options.recordUsage(distToken, usage)`（assemble 注入：更新内存
     * key 表 + 落盘），限额判定在**下次请求**的 checkDistributionKey 里生效。
     */
    if (distKey !== undefined) {
      void (async () => {
        let usage
        try {
          for await (const chunk of chunks) {
            if (chunk?.type === 'usage' && chunk.usage !== undefined) usage = chunk.usage
            if (chunk?.type === 'finish') break
          }
        } catch {
          // 流断了就没收完 —— 记已有的（少记优于多记）。
        }
        if (usage !== undefined) {
          try {
            await options.recordUsage?.(distKey.token, {
              inputTokens: usage.inputTokens ?? 0,
              outputTokens: usage.outputTokens ?? 0,
            })
          } catch {
            // 记账失败不该让响应出错（响应已发出）。
          }
        }
      })()
    }

    if (!streaming) {
      try {
        const payload = await collectChatCompletion(chunks, requestId, model)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
      } catch (error) {
        jsonError(res, 502, 'server_error', String(error?.message ?? error))
      }
      return
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    try {
      for await (const line of toOpenAiSse(chunks, requestId, model)) {
        if (res.destroyed || res.writableEnded) break
        res.write(line)
      }
    } catch (error) {
      /** 流已开始：只能回一帧错误 chunk（HTTP 状态码已经发出去了）。 */
      if (!res.destroyed && !res.writableEnded) {
        res.write(`data: ${JSON.stringify({
          id: requestId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [],
          error: { message: String(error?.message ?? error), type: 'server_error', code: 'upstream_error' },
        })}\n\n`)
      }
    }
    if (!res.destroyed && !res.writableEnded) {
      res.write('data: [DONE]\n\n')
      res.end()
    }
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
    log(`[openai-gateway] ⚠ 端口 ${requestedPort} 不可用（${error.code}），已回退随机端口`)
    await listen(0)
    actualPort = server.address().port
  }

  const baseUrl = `http://${host}:${actualPort}/v1`
  log(`[openai-gateway] 已监听 ${baseUrl}`)

  return {
    port: actualPort,
    baseUrl,
    token,
    async close() {
      await new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

/** 从请求里取 presented key（Bearer 优先，x-api-key 兜底）；无 = null。 */
function extractBearer(req) {
  const header = req.headers['authorization']
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    const value = header.slice('Bearer '.length).trim()
    return value.length > 0 ? value : null
  }
  const alt = req.headers['x-api-key']
  return typeof alt === 'string' && alt.length > 0 ? alt : null
}

/**
 * 主 apiKey 判定（分发 key 在 handle 里单独走两级判定）。
 * Bearer / x-api-key 双认（OpenAI 客户端发前者，curl 常用后者）。
 */
function isAuthorized(req, token) {
  return extractBearer(req) === token
}

function jsonError(res, status, code, message) {
  if (res.writableEnded) return
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: { message, type: code, code } }))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > BODY_LIMIT_BYTES) {
        const error = new Error(`请求体超过 ${BODY_LIMIT_BYTES} 字节上限`)
        error.code = 'BODY_TOO_LARGE'
        reject(error)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

// ── OpenAI 请求 → DSH GenerateOptions ───────────────────────────────────────

/**
 * 把 OpenAI `/v1/chat/completions` 请求体翻成 DSH 的 GenerateOptions。
 *
 * ⚠ 缺 `messages` 直接报错：空 messages 到底层会变成一条奇怪的请求，不如在
 * 入口就明确拒绝（与参考实现同口径）。
 * ⚠ `tool_choice` 只支持 `auto` / `none`：其余取值（`required`、指名某个函数）
 * DSH 侧表达不出来，静默降级会让客户端以为约束生效了。
 */
export function toGenerateOptions(body) {
  if (!Array.isArray(body?.messages) || body.messages.length === 0) {
    throw new Error('messages must be a non-empty array')
  }
  if (body.tool_choice !== undefined && body.tool_choice !== 'auto' && body.tool_choice !== 'none') {
    throw new Error('only tool_choice auto and none are supported')
  }

  const maxTokens = num(body.max_completion_tokens) ?? num(body.max_tokens)
  const temperature = num(body.temperature)
  const stop = typeof body.stop === 'string'
    ? [body.stop]
    : Array.isArray(body.stop) && body.stop.every((item) => typeof item === 'string')
      ? body.stop
      : undefined

  const tools = convertTools(body.tools)
  if (body.tool_choice === 'none' && tools !== undefined && tools.length > 0) {
    throw new Error('tool_choice "none" with tools cannot be represented')
  }

  /**
   * ⚠ 工具配对**预扫**必须在转换之前：配对的 `role:'tool'` 消息可能排在被剔除
   * 的调用**后面**，逐条转换时已无从知道该剔除谁。
   */
  const callIds = collectCallAvailability(body.messages)
  const messages = []
  for (const message of body.messages) {
    const converted = convertMessage(message, callIds)
    /** `undefined` = 整条剔除（绝不 push 空消息充数）。 */
    if (converted !== undefined) messages.push(converted)
  }

  return {
    messages,
    ...(tools === undefined ? {} : { tools }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(temperature === undefined ? {} : { temperature }),
    ...(stop === undefined ? {} : { stop }),
  }
}

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 把多模态/字符串 content 展平成纯文本。 */
export function contentToText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text')
    .map((block) => (typeof block.text === 'string' ? block.text : ''))
    .join('')
}

/** 工具名判据：trim 后非空（空白名上游同样拒）。**只有这一份判据。** */
function hasUsableToolName(name) {
  return typeof name === 'string' && name.trim().length > 0
}

/** 工具调用 id 判据：非空字符串。⚠ 刻意**不 trim**（id 是不透明标识符）。 */
function isUsableToolCallId(value) {
  return typeof value === 'string' && value.length > 0
}

/**
 * 预扫历史，按 id 分出工具的可用性。
 *
 * ⚠ 剔除条件必须是「**该 id 上没有任何可用调用**」(`dropped && !kept`)：
 * 只看 dropped 会把「同 id 上还有好调用」的结果一起剔掉 ⇒ 留下孤儿 tool-call，
 * 上游照样 400。
 */
function collectCallAvailability(messages) {
  const dropped = new Set()
  const kept = new Set()
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue
    if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue
    for (const call of message.tool_calls) {
      if (call === null || typeof call !== 'object') continue
      if (!isUsableToolCallId(call.id)) continue
      if (hasUsableToolName(call.function?.name)) kept.add(call.id)
      else dropped.add(call.id)
    }
  }
  return { dropped, kept }
}

/** 单条 OpenAI 消息 → DSH Message；`undefined` = 整条剔除。 */
function convertMessage(raw, callIds) {
  if (raw === null || typeof raw !== 'object') throw new Error('messages entries must be objects')
  const role = raw.role

  if (role === 'system' || role === 'developer') {
    const text = contentToText(raw.content)
    if (text.length === 0) return undefined
    return { role: 'system', content: [{ type: 'text', text }] }
  }

  if (role === 'user') {
    const parts = []
    if (typeof raw.content === 'string') {
      parts.push({ type: 'text', text: raw.content })
    } else if (Array.isArray(raw.content)) {
      for (const block of raw.content) {
        if (block === null || typeof block !== 'object') continue
        if (block.type === 'text' && typeof block.text === 'string') {
          parts.push({ type: 'text', text: block.text })
        } else if (block.type === 'image_url') {
          /** ⚠ 图片只在 user 角色被接受；上游只认这一种形态。 */
          const url = typeof block.image_url === 'string' ? block.image_url : block.image_url?.url
          if (typeof url === 'string' && url.length > 0) parts.push({ type: 'image', url })
        }
      }
    }
    if (parts.length === 0) return undefined
    return { role: 'user', content: parts }
  }

  if (role === 'assistant') {
    const content = []
    const text = contentToText(raw.content)
    if (text.length > 0) content.push({ type: 'text', text })
    if (Array.isArray(raw.tool_calls)) {
      for (const call of raw.tool_calls) {
        if (call === null || typeof call !== 'object') continue
        /**
         * ⚠ 名字不可用的调用**剔除**而非报错：坏块会被客户端每轮原样重放，
         * 网关直接 400 等于让整条会话永久不可用（参考实现 issue IKLRIK）。
         * 但 `id` / `arguments` 缺失仍报错 —— 那是真形状错误，剔除会静默丢掉
         * 模型真实发起的调用。
         */
        if (!hasUsableToolName(call.function?.name)) continue
        if (!isUsableToolCallId(call.id)) throw new Error('assistant.tool_calls contains an invalid function call')
        if (typeof call.function?.arguments !== 'string') {
          throw new Error('assistant.tool_calls contains an invalid function call')
        }
        content.push({ type: 'tool-call', id: call.id, name: call.function.name, arguments: call.function.arguments })
      }
    }
    /**
     * ⚠ 调用全被剔光且正文为空 ⇒ 整条剔除。留着会变成 wire 上一条**空的开头
     * assistant 发言**（实测让 OpenAI 兼容端点回 model_param_invalid）。
     * ⚠ 正文非空的（模型真实发言）必须留下 —— 那是用户界面上看到的内容。
     */
    if (content.length === 0) return undefined
    return { role: 'assistant', content }
  }

  if (role === 'tool') {
    if (!isUsableToolCallId(raw.tool_call_id)) throw new Error('tool messages require tool_call_id')
    /** 配对已坏 ⇒ 结果成孤儿，必须一并剔除（上游对孤儿结果同样 400）。 */
    if (callIds.dropped.has(raw.tool_call_id) && !callIds.kept.has(raw.tool_call_id)) return undefined
    const parts = typeof raw.content === 'string'
      ? [{ type: 'text', text: raw.content }]
      : Array.isArray(raw.content)
        ? raw.content
          .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
          .map((block) => ({ type: 'text', text: block.text }))
        : []
    return {
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: raw.tool_call_id, content: parts }],
    }
  }

  throw new Error(`unsupported message role: ${String(role)}`)
}

/** Chat 形状的 tools → DSH ToolSchema。 */
function convertTools(raw) {
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw)) throw new Error('tools must be an array')
  const out = []
  for (const tool of raw) {
    if (tool === null || typeof tool !== 'object') continue
    if (tool.type !== undefined && tool.type !== 'function') continue
    const fn = tool.function
    if (fn === null || typeof fn !== 'object' || !hasUsableToolName(fn.name)) continue
    out.push({
      name: fn.name,
      ...(typeof fn.description === 'string' ? { description: fn.description } : {}),
      /** `parameters` 原样透传：这是模型看的 schema，网关不做改写。 */
      ...(fn.parameters !== undefined ? { parameters: fn.parameters } : {}),
    })
  }
  return out.length > 0 ? out : undefined
}

// ── DSH StreamChunk → OpenAI chunk ─────────────────────────────────────────

/** DSH finish reason → OpenAI `finish_reason`。 */
function finishReason(reason) {
  switch (reason?.kind) {
    case 'stop': return 'stop'
    case 'tool-calls': return 'tool_calls'
    case 'max-tokens': return 'length'
    case 'aborted': return 'error'
    case 'error': return 'error'
    default: return 'stop'
  }
}

/**
 * DSH usage → OpenAI `usage`。
 *
 * ⚠ `prompt_tokens` 含缓存命中（DSH 的 `inputTokens` 口径），`cached_tokens`
 * 是它的**子集**；两个明细字段（官方形态）必须给 —— 标准客户端只认官方名字。
 */
function usageJson(usage) {
  if (usage === null || typeof usage !== 'object') return undefined
  const input = num(usage.inputTokens) ?? 0
  const output = num(usage.outputTokens) ?? 0
  const cached = num(usage.cachedInputTokens) ?? 0
  const reasoning = num(usage.reasoningTokens)
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: input + output,
    prompt_tokens_details: { cached_tokens: cached },
    ...(reasoning === undefined
      ? {}
      : { reasoning_tokens: reasoning, completion_tokens_details: { reasoning_tokens: reasoning } }),
    ...(cached > 0 ? { prompt_cache_hit_tokens: cached } : {}),
  }
}

function baseChunk(id, model, delta, finish) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish ?? null }],
  }
}

/**
 * 单块消费：返回要发出去的 `delta`（或 `undefined` = 该块不产生帧）。
 *
 * ⚠ `reasoning-delta` 映射到 **`reasoning_content`**（DeepSeek 系私有名，
 * 也是 Cline/qoder 等客户端读的那个）；不映射 `reasoning` —— 那是另一家
 * （Cline 的 `{"delta":{"reasoning":…}}`）的写法，两边同时发会让部分客户端重复渲染。
 */
function consumeChunk(state, chunk) {
  switch (chunk?.type) {
    case 'text-delta':
      state.content += typeof chunk.text === 'string' ? chunk.text : ''
      return { delta: { content: chunk.text ?? '' } }
    case 'reasoning-delta':
      state.reasoning += typeof chunk.text === 'string' ? chunk.text : ''
      return { delta: { reasoning_content: chunk.text ?? '' } }
    case 'tool-call-delta': {
      let tool = state.tools.get(chunk.index)
      if (tool === undefined) {
        tool = { id: String(chunk.id ?? ''), arguments: '' }
        state.tools.set(chunk.index, tool)
      }
      /** ⚠ 只接受**非空**覆盖：后续分片带空串会清空已解析的工具名。 */
      if (typeof chunk.id === 'string' && chunk.id.length > 0) tool.id = chunk.id
      if (typeof chunk.name === 'string' && chunk.name.length > 0) tool.name = chunk.name
      const argsDelta = typeof chunk.argumentsDelta === 'string' ? chunk.argumentsDelta : ''
      tool.arguments += argsDelta
      return {
        delta: {
          tool_calls: [{
            index: chunk.index,
            id: tool.id,
            type: 'function',
            function: {
              ...(tool.name === undefined ? {} : { name: tool.name }),
              arguments: argsDelta,
            },
          }],
        },
      }
    }
    case 'usage':
      state.usage = chunk.usage
      return undefined
    case 'finish': {
      const reason = chunk.reason ?? { kind: 'stop' }
      if (reason.kind === 'error' || reason.kind === 'aborted') {
        return { error: reason.failure ?? { message: `DSH model request ${reason.kind}` } }
      }
      state.finishReason = finishReason(reason)
      return { delta: {}, finish: state.finishReason }
    }
    case 'block-start':
    case 'block-end':
    default:
      return undefined
  }
}

/**
 * 上游失败 → OpenAI 错误体 + 状态码。
 *
 * ⚠ **门禁 400–599**：上游有时用 `{status: 200}` 表示业务失败（额度用尽），
 * 原样透出会让客户端把失败读成成功。
 */
function normalizeUpstreamFailure(failure) {
  const raw = num(failure?.status)
  const status = raw !== undefined && raw >= 400 && raw <= 599 ? raw : 502
  return {
    status,
    type: typeof failure?.type === 'string' ? failure.type : 'server_error',
    code: typeof failure?.code === 'string' ? failure.code : 'upstream_error',
    message: typeof failure?.message === 'string' && failure.message.length > 0
      ? failure.message
      : 'upstream error',
  }
}

/** 流式：DSH chunk 序列 → OpenAI SSE 行。 */
export async function* toOpenAiSse(chunks, requestId, model) {
  const state = { content: '', reasoning: '', tools: new Map(), usage: undefined, finishReason: undefined }
  for await (const chunk of chunks) {
    const event = consumeChunk(state, chunk)
    if (event === undefined) continue
    if (event.error !== undefined) {
      const normalized = normalizeUpstreamFailure(event.error)
      yield `data: ${JSON.stringify({
        id: requestId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [],
        error: { message: normalized.message, type: normalized.type, code: normalized.code },
      })}\n\n`
      return
    }
    if (event.delta !== undefined) {
      yield `data: ${JSON.stringify(baseChunk(requestId, model, event.delta, event.finish))}\n\n`
    }
  }
  /** 用量作为最后一帧（`stream_options.include_usage` 的通行形态）。 */
  const usage = usageJson(state.usage)
  if (usage !== undefined) {
    yield `data: ${JSON.stringify({
      id: requestId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [],
      usage,
    })}\n\n`
  }
}

/** 非流式：把整条流折叠成一个 `chat.completion`。 */
export async function collectChatCompletion(chunks, requestId, model) {
  const state = { content: '', reasoning: '', tools: new Map(), usage: undefined, finishReason: undefined }
  for await (const chunk of chunks) {
    const event = consumeChunk(state, chunk)
    if (event?.error !== undefined) {
      const normalized = normalizeUpstreamFailure(event.error)
      throw new Error(normalized.message)
    }
  }
  if (state.finishReason === undefined) {
    /** 流没有 finish ⇒ 上游半截断开。报错而不是假装成功（谎报会让半截输出被持久化）。 */
    throw new Error('upstream stream ended before finish')
  }
  const toolCalls = [...state.tools.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, tool]) => ({
      id: tool.id,
      type: 'function',
      function: { name: tool.name ?? '', arguments: tool.arguments },
    }))
  const message = {
    role: 'assistant',
    content: state.content.length > 0 ? state.content : null,
    ...(state.reasoning.length === 0 ? {} : { reasoning_content: state.reasoning }),
    ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
  }
  const usage = usageJson(state.usage)
  return {
    id: requestId,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: state.finishReason }],
    ...(usage === undefined ? {} : { usage }),
  }
}
