/**
 * 请求体组装：把 DSH 的 `GenerateOptions`（provider-neutral 词汇）翻成
 * zcode-plan 端点要求的 Anthropic Messages 形态。
 *
 * ## 三道准入闸门（缺一即 3012 / 3007，且 3012 有账号冷却惩罚）
 *
 * 1. **官方身份块**：`system` 必须以官方身份块结构**开头**（cliPrefix + stable 段），
 *    否则 `3012 unusual activity`。实测矩阵：无 system → 3012；只有 cliPrefix → 3012；
 *    cliPrefix + stable → 200。判据是「身份块是否存在」，与 HTTP 头 / 运行时无关。
 *    调用方（DSH）的 system 内容**追加在最后**，不得前置。
 * 2. **首轮日期块**：第一条 user 消息的 content **数组**最前面插一个
 *    `<system-reminder>` 日期块（纯文本 content 会被转成块数组）。幂等：已以此开头则跳过。
 * 3. **tools 缓存断点**：只在**最后一个** tool 上打 `cache_control` —— Anthropic 缓存是
 *    前缀式的，一个断点即覆盖 system + 全部 tools；单请求最多 4 个断点。
 */

/**
 * 第一块：CLI 身份前缀（官方以此开头，42 字符）。
 * ⚠ 不要"优化"这段文本：上游的准入检查看的是前缀结构。
 */
export const OFFICIAL_CLI_PREFIX = 'You are ZCode, an interactive coding agent'

/**
 * 第二块：stable 段（多段用 `\n\n` 连接）。
 *
 * ⚠ 只发**准入必需**的部分。官方完整身份块还含 ~5KB 的 dynamic 段
 * （`# Communicating with the user` / `# Context management`），那是给壳内
 * coding agent 的行为指令，与准入无关，且会被放在 system 开头**压过**调用方的
 * prompt（表现为「啰嗦、慢」）—— 所以这里刻意不发。
 */
export const OFFICIAL_STABLE_SECTIONS = Object.freeze([
  '\nYou are an interactive ZCode agent that helps users with software engineering tasks.\n\nIMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes. Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases.\n\n# Harness\n- Text you output outside of tool use is displayed to the user as Github-flavored markdown in a terminal.\n- Tools run behind a user-selected permission mode; a denied call means the user declined it — adjust, don\'t retry verbatim.\n- The system may send updates, reminders, or modifications to rules via mid-conversation system turns. These are system-controlled, unlike function results. Hooks may intercept tool calls; treat hook output as user feedback.\n- Prefer the dedicated file/search tools over shell commands when one fits. Independent tool calls can run in parallel in one response.\n- Reference code as `file_path:line_number` — it\'s clickable.',
  '# ZCode Desktop Context\n\n### Files & URLs\n- Return local web URLs as Markdown links (e.g., [label](http://127.0.0.1:8080)).\n- File should be an absolute path or include the workspace folder segment so it can be resolved relative to the workspace.\n- Unless otherwise specified, return local file references as Markdown links (e.g., [name.md](/absolute/path/to/name.md)).\n\n### Inline Code Comments\n- Use the ::code-comment{...} directive when you need to attach feedback directly to specific code lines.\n- Emit one directive per inline comment; emit none when there are no actionable inline comments.\n- Required attributes: title (short label), body (one-paragraph explanation), file (path to the file).\n- Optional attributes: start, end (1-based line numbers), priority (0-3).\n- file should be an absolute path or include the workspace folder segment so it can be resolved relative to the workspace.\n- Keep line ranges tight; end defaults to start.\n- Example: ::code-comment{title="[P2] Off-by-one" body="Loop iterates past the end when length is 0." file="/path/to/foo.ts" start=10 end=11 priority=2}',
  '# Working style\n\nWhen you have enough information to act, act. Do not re-derive facts already established in the conversation, re-litigate a decision the user has already made, or narrate options you will not pursue. If you are weighing a choice, give a recommendation, not an exhaustive survey. Prefer reading the actual file or running the actual command over reasoning about what it probably contains. When a signal pattern-matches to a known failure, check that the evidence actually supports that specific diagnosis before acting on it.',
])

/** `<system-reminder>` 日期块的固定文案（官方逐字）。 */
const CONTEXT_PREFIX_INTRO = "As you answer the user's questions, you can use the following context:"

/** 结尾段（⚠ 前有 **6 个空格**缩进，官方逐字如此）。 */
const CONTEXT_PREFIX_OUTRO =
  '      IMPORTANT: this context may or may not be relevant to your tasks. ' +
  'You should not respond to this context unless it is highly relevant to your task.'

/** 本地时区的 ISO 日期（官方用本地日期，**不是** UTC）。 */
export function formatLocalIsoDate(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 构造 `<system-reminder>` 上下文块（整块是**一个** text 块）。 */
export function buildContextPrefixBlock(now = new Date()) {
  const body = [
    CONTEXT_PREFIX_INTRO,
    `# currentDate\nToday's date is ${formatLocalIsoDate(now)}.`,
    '',
    CONTEXT_PREFIX_OUTRO,
  ].join('\n')
  return { type: 'text', text: `<system-reminder>${body}</system-reminder>` }
}

/** 判断一条消息的 content 是否已经以日期块开头（幂等判据）。 */
function startsWithSystemReminder(content) {
  if (typeof content === 'string') return content.startsWith('<system-reminder>')
  if (Array.isArray(content)) {
    const first = content[0]
    return typeof first?.text === 'string' && first.text.startsWith('<system-reminder>')
  }
  return false
}

/**
 * 给**首轮 user 消息**的 content 数组最前面插入日期块。
 *
 * 规则（官方行为）：只处理第一条消息且必须是 user；幂等；纯文本 content 转块数组。
 */
export function withContextPrefix(messages, now = new Date()) {
  const out = messages.map((message) => ({ ...message }))
  const first = out[0]
  if (first === undefined || first.role !== 'user') return out
  if (startsWithSystemReminder(first.content)) return out

  const prefix = buildContextPrefixBlock(now)
  if (Array.isArray(first.content)) first.content = [prefix, ...first.content]
  else if (typeof first.content === 'string') first.content = [prefix, { type: 'text', text: first.content }]
  else first.content = [prefix]
  return out
}

/** # Environment 段。 */
export function buildEnvironmentSection(options) {
  const cwd = typeof options.cwd === 'string' && options.cwd.trim().length > 0 ? options.cwd : '.'
  const provider = options.provider ?? 'zcode'
  const model = options.model ?? 'glm-5.3-flash'
  const platform = options.platform ?? process.platform
  return [
    '# Environment',
    'You have been invoked in the following environment:',
    ` - Primary working directory: ${cwd}`,
    ` - Platform: ${platform}`,
    ` - Shell: ${platform === 'win32' ? 'powershell' : 'bash'}`,
    ` - You are powered by the model named ${provider}/${model}.`,
  ].join('\n')
}

/**
 * 构造官方形态的 system 块数组。
 *
 * 结构（逐字复刻官方，**不要优化**）：
 *   block[0] = cliPrefix ← 准入必需
 *   block[1] = stable    ← 准入必需
 *   block[2] = # Environment
 *   block[3..] = 调用方 system（追加在最后）
 *
 * ⚠ 只在**最后一块**打 cache_control（前缀式缓存，一个断点覆盖面最大）。
 */
export function buildZcodeSystemBlocks(callerSystem, options = {}) {
  const stable = OFFICIAL_STABLE_SECTIONS.join('\n\n')
  const blocks = [
    { type: 'text', text: OFFICIAL_CLI_PREFIX },
    { type: 'text', text: stable },
    { type: 'text', text: buildEnvironmentSection(options) },
  ]
  if (typeof callerSystem === 'string' && callerSystem.trim().length > 0) {
    blocks.push({ type: 'text', text: callerSystem })
  }
  const last = blocks[blocks.length - 1]
  if (last !== undefined) last.cache_control = { type: 'ephemeral' }
  return blocks
}

/** 把任意形态的 system 归一成块数组（Anthropic 允许字符串或块数组）。 */
export function normalizeSystem(system) {
  if (typeof system === 'string') {
    return system.trim().length > 0 ? [{ type: 'text', text: system }] : []
  }
  if (!Array.isArray(system)) return []
  const blocks = []
  for (const item of system) {
    if (typeof item !== 'object' || item === null) continue
    if (item.type !== 'text' || typeof item.text !== 'string') continue
    const block = { type: 'text', text: item.text }
    if (item.cache_control?.type === 'ephemeral') block.cache_control = { type: 'ephemeral' }
    blocks.push(block)
  }
  return blocks
}

/** 给工具表的**最后一个**工具打缓存断点。 */
export function withToolCacheBreakpoint(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return []
  return tools.map((tool, index) =>
    index === tools.length - 1 ? { ...tool, cache_control: { type: 'ephemeral' } } : { ...tool },
  )
}

/**
 * DSH 工具定义 → Anthropic 工具声明。
 *
 * @param {readonly any[]} tools DSH 的 ToolDefinition 列表
 * @returns {Array<any>}
 */
export function convertTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return []
  const out = []
  for (const tool of tools) {
    if (typeof tool?.name !== 'string' || typeof tool?.parameters !== 'object' || tool.parameters === null) continue
    const schema = { ...tool.parameters }
    /** Anthropic 要求顶层 type=object；DSH 的 schema 本来就满足，缺失时补上。 */
    if (schema.type === undefined) schema.type = 'object'
    /** Anthropic 不接受 `$schema` 之类的键。 */
    delete schema['$schema']
    delete schema['additionalProperties']
    out.push({
      name: tool.name,
      ...(typeof tool.description === 'string' && tool.description.length > 0 ? { description: tool.description } : {}),
      input_schema: schema,
    })
  }
  return withToolCacheBreakpoint(out)
}

/** DSH 保存的是原始 JSON 字符串；Anthropic tool_use.input 要求对象。 */
function parseToolArguments(raw) {
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) return raw
  if (typeof raw !== 'string' || raw.length === 0) return {}
  try {
    const value = JSON.parse(raw)
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

/** 单值取第一个字符串字段（工具表列出的键按序尝试）。 */
function pickString(value, ...keys) {
  if (typeof value !== 'object' || value === null) return undefined
  for (const key of keys) {
    const item = value[key]
    if (typeof item === 'string' && item.length > 0) return item
  }
  return undefined
}

/**
 * 把 DSH 的 `ImageAttachmentRef`（宿主 `ImageBlock.attachment`，持久引用）转成
 * Anthropic 的 base64 image 块。
 *
 * ## 宿主契约（rc.3 实测，这是「图片被静默丢弃」的根因）
 *
 * DSH 传给适配器的 image 块是 `{ type: 'image', attachment: ImageAttachmentRef }`
 * （`dsh-llm/lib/types` 的 `ImageBlock`），**不是** base64。引用形态（实测
 * `attachment-local` 后端）：
 *
 * ```
 * { attachmentId: 'sha256:<hex>', mediaType: 'image/png', width, height, bytes, name? }
 * ```
 *
 * 字节要经附件服务 `readImageRequest(ref, target)` 解析（见 `resolveImages`）；
 * 这里只做**已解析字节 → wire 块**的纯转换。
 *
 * @param {any} ref DSH 的 ImageAttachmentRef
 * @param {Uint8Array} data 请求图片字节
 * @returns {Record<string, unknown>} Anthropic base64 image 块
 */
export function imageBlockFromAttachment(ref, data) {
  const base64 =
    typeof Buffer !== 'undefined' && typeof Buffer.from === 'function'
      ? Buffer.from(data).toString('base64')
      : bytesToBase64(data)
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: typeof ref?.mediaType === 'string' ? ref.mediaType : 'image/png',
      data: base64,
    },
  }
}

/** 纯 JS base64（无 Node Buffer 的环境兜底）。 */
function bytesToBase64(bytes) {
  const table = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let out = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const remaining = bytes.length - index
    const b0 = bytes[index]
    const b1 = remaining > 1 ? bytes[index + 1] : 0
    const b2 = remaining > 2 ? bytes[index + 2] : 0
    out += table[b0 >> 2]
    out += table[((b0 & 0x03) << 4) | (b1 >> 4)]
    out += remaining > 1 ? table[((b1 & 0x0f) << 2) | (b2 >> 6)] : '='
    out += remaining > 2 ? table[b2 & 0x3f] : '='
  }
  return out
}

/**
 * 遍历一条消息 content 里的图片引用（宿主 `ImageBlock` 形态优先，兼容内联 base64）。
 *
 * @param {readonly any[]} blocks
 * @returns {Array<{ index: number, attachmentId: string, ref: any, inline?: { mediaType: string, data: string } }>}
 */
export function imageOccurrences(blocks) {
  if (!Array.isArray(blocks)) return []
  const found = []
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    if (block === null || typeof block !== 'object' || block.type !== 'image') continue
    /** 宿主流派：持久引用（attachment + attachmentId）。 */
    const attachmentId = pickString(block.attachment, 'attachmentId', 'attachment_id', 'id')
    if (typeof attachmentId === 'string' && attachmentId.length > 0) {
      found.push({ index, attachmentId, ref: block.attachment })
      continue
    }
    /** 防御：内联 base64（旧测试/其他宿主形态）原样携带，不需要解析。 */
    if (block.source?.type === 'base64' && typeof block.source.data === 'string') {
      found.push({
        index,
        attachmentId: `inline:${index}`,
        ref: null,
        inline: { mediaType: block.source.media_type ?? 'image/png', data: block.source.data },
      })
    }
  }
  return found
}

/**
 * DSH content blocks → Anthropic content blocks。
 *
 * 支持 text / image / tool-call / tool-result；
 * 其余块（file 等）在 DSH 侧已被投影成文本或占位，这里保守丢弃并记一条提示。
 *
 * ## 图片的两种形态
 *
 * 1. **宿主流派（实际形态）**：`{ type: 'image', attachment: ImageAttachmentRef }`
 *    —— 持久引用。字节由调用方先经 `resolveImages()` 从附件服务解析好，
 *    以 `resolvedImages: Map<attachmentId, {data, ref}>` 传入；查不到的引用
 *    以占位文本替换（不再静默丢弃——那会让用户以为发了图，模型却什么都看不到）。
 * 2. **内联形态（防御性兼容）**：`{ type: 'image', source: { type: 'base64'|'url', … } }`
 *    —— 旧测试与其他宿主形态，原样转换。
 *
 * @param {readonly any[]} blocks
 * @param {{ supportsImages?: boolean, resolvedImages?: Map<string, { data: Uint8Array, ref: any }> }} [options]
 * @returns {Array<any>}
 */
export function convertContent(blocks, options = {}) {
  if (typeof blocks === 'string') return [{ type: 'text', text: blocks }]
  if (!Array.isArray(blocks)) return []
  const out = []
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string' && block.text.length > 0) out.push({ type: 'text', text: block.text })
        break
      case 'image': {
        if (options.supportsImages === false) {
          out.push({ type: 'text', text: '[image omitted: this model does not accept image input]' })
          break
        }
        /** ① 宿主流派：持久引用 → 已解析字节。 */
        const attachmentId = pickString(block.attachment, 'attachmentId', 'attachment_id', 'id')
        if (typeof attachmentId === 'string' && attachmentId.length > 0) {
          const resolved = options.resolvedImages?.get(attachmentId)
          if (resolved !== undefined) {
            out.push(imageBlockFromAttachment(resolved.ref ?? block.attachment, resolved.data))
          } else {
            out.push({
              type: 'text',
              text: `[image omitted: attachment ${attachmentId.slice(0, 15)}… could not be loaded from the attachment store]`,
            })
          }
          break
        }
        /** ② 防御：内联 base64 / url。 */
        const source = block.source
        if (source?.type === 'base64' && typeof source.data === 'string') {
          out.push({
            type: 'image',
            source: { type: 'base64', media_type: source.media_type ?? 'image/png', data: source.data },
          })
        } else if (source?.type === 'url' && typeof source.url === 'string') {
          out.push({ type: 'image', source: { type: 'url', url: source.url } })
        }
        break
      }
      case 'tool-call':
        out.push({
          type: 'tool_use',
          id: block.id ?? `toolu_${Math.random().toString(36).slice(2)}`,
          name: block.name,
          input: parseToolArguments(block.arguments ?? block.args),
        })
        break
      case 'tool-result':
        out.push({
          type: 'tool_result',
          tool_use_id: block.toolCallId ?? block.id,
          content:
            typeof block.output === 'string'
              ? block.output
              : JSON.stringify(block.output ?? block.content ?? ''),
          ...(block.isError === true ? { is_error: true } : {}),
        })
        break
      case 'thinking':
      case 'reasoning':
        /** 不向历史回放思考块：上游不接受无签名的 thinking。 */
        break
      default:
        break
    }
  }
  return out
}

/**
 * 收集一次请求里所有消息的图片引用，并经附件服务解析成请求字节。
 *
 * 这是官方 `dsh-llm-deepseek` 的同款链路：`attachments.readImageRequest(ref, target)`
 * 返回确定性的「请求版本」（`{ data, mediaType, width, height, … }`，超出 target 时
 * 由后端缩放/重编码）。解析失败的引用跳过（`convertContent` 会给出占位文本），
 * 不让一张坏图让整个请求失败。
 *
 * @param {readonly any[]} messages DSH GenerateOptions.messages
 * @param {{ resolveAttachments?: () => any, signal?: AbortSignal }} [deps]
 * @returns {Promise<Map<string, { data: Uint8Array, ref: any }>>} attachmentId → 请求字节
 */
export async function resolveImages(messages, deps = {}) {
  const attachments = deps.resolveAttachments?.()
  if (attachments === undefined || attachments === null) return new Map()
  const refs = new Map()
  for (const message of Array.isArray(messages) ? messages : []) {
    const blocks = Array.isArray(message?.content) ? message.content : []
    for (const occurrence of imageOccurrences(blocks)) {
      if (occurrence.inline !== undefined) continue
      if (!refs.has(occurrence.attachmentId)) refs.set(occurrence.attachmentId, occurrence.ref)
    }
  }
  const resolved = new Map()
  for (const [attachmentId, ref] of refs) {
    try {
      /** 默认保留归一化尺寸（基类 imageRequestTarget 的语义）；不放大也不强制缩。 */
      const target = {
        width: typeof ref.width === 'number' && ref.width > 0 ? ref.width : 1568,
        height: typeof ref.height === 'number' && ref.height > 0 ? ref.height : 1568,
        maxBytes: typeof ref.bytes === 'number' && ref.bytes > 0 ? ref.bytes : 4_194_304,
      }
      const version = await attachments.readImageRequest(ref, target, deps.signal)
      if (version?.data instanceof Uint8Array && version.data.byteLength > 0) {
        resolved.set(attachmentId, { data: version.data, ref: version.attachment ?? ref })
      }
    } catch {
      /** 单张图解析失败只降级为占位文本，不拖垮整条请求。 */
    }
  }
  return resolved
}

/**
 * 把 DSH 的 `GenerateOptions` 组装成上游请求体（**纯函数**）。
 *
 * @param {{
 *   options: any,
 *   cwd?: string,
 *   provider?: string,
 *   now?: Date,
 *   maxTokens?: number,
 *   supportsImages?: boolean,
 *   resolvedImages?: Map<string, { data: Uint8Array, ref: any }>,
 * }} input
 * @returns {Record<string, unknown>}
 */
export function buildUpstreamBody(input) {
  const options = input.options
  const model = options.model
  const callerBlocks = normalizeSystem(options.system)
  const callerText = callerBlocks.map((block) => block.text).join('\n\n')

  const messages = (Array.isArray(options.messages) ? options.messages : [])
    .filter((message) => message?.role !== 'system')
    .map((message) => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: convertContent(message.content, {
        supportsImages: input.supportsImages,
        resolvedImages: input.resolvedImages,
      }),
    }))
    .filter((message) => message.content.length > 0)

  const body = {
    model,
    max_tokens: input.maxTokens ?? 32_768,
    stream: true,
    system: buildZcodeSystemBlocks(callerText.length > 0 ? callerText : undefined, {
      cwd: input.cwd ?? '.',
      provider: input.provider ?? 'zcode',
      model,
    }),
    messages: withContextPrefix(messages, input.now ?? new Date()),
  }

  const tools = convertTools(options.tools)
  if (tools.length > 0) body.tools = tools
  if (typeof options.temperature === 'number') body.temperature = options.temperature
  return body
}
