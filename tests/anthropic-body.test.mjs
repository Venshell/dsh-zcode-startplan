import test from 'node:test'
import assert from 'node:assert/strict'

import {
  OFFICIAL_CLI_PREFIX,
  OFFICIAL_STABLE_SECTIONS,
  buildUpstreamBody,
  buildZcodeSystemBlocks,
  convertContent,
  convertTools,
  imageBlockFromAttachment,
  imageOccurrences,
  resolveImages,
  withContextPrefix,
} from '../lib/anthropic-body.js'

const userMessage = (text) => ({ role: 'user', content: [{ type: 'text', text }] })

test('身份块必须打头（3012 的准入判据）', () => {
  const blocks = buildZcodeSystemBlocks('CALLER SYSTEM', { cwd: 'C:/w' })
  assert.equal(blocks[0].text, OFFICIAL_CLI_PREFIX)
  assert.equal(blocks[1].text, OFFICIAL_STABLE_SECTIONS.join('\n\n'))
  assert.match(blocks[2].text, /# Environment/)
  /** 调用方内容追加在最后 —— 前置会顶掉官方前缀结构。 */
  assert.equal(blocks[blocks.length - 1].text, 'CALLER SYSTEM')
})

test('只在最后一块打 cache_control（单请求最多 4 个断点）', () => {
  const blocks = buildZcodeSystemBlocks('x', { cwd: '.' })
  const withCache = blocks.filter((block) => block.cache_control !== undefined)
  assert.equal(withCache.length, 1)
  assert.equal(blocks[blocks.length - 1].cache_control.type, 'ephemeral')
})

test('首轮 user 消息插入日期块，且幂等', () => {
  const once = withContextPrefix([userMessage('hi')], new Date(2026, 9, 23))
  const first = once[0].content[0]
  assert.match(first.text, /^<system-reminder>/)
  assert.match(first.text, /Today's date is 2026-10-23\./)
  assert.equal(once[0].content[1].text, 'hi')

  const twice = withContextPrefix(once, new Date(2026, 9, 24))
  assert.equal(twice[0].content.length, 2, '已带日期块的消息不得重复插入')
})

test('日期块只进第一条 user 消息（纯文本 content 会被转成块数组）', () => {
  const messages = withContextPrefix(
    [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ],
    new Date(2026, 9, 23),
  )
  assert.ok(Array.isArray(messages[0].content))
  assert.match(messages[0].content[0].text, /system-reminder/)
  assert.equal(messages[1].content, 'world')
})

test('convertTools: 只在最后一个 tool 打断点，并剥掉 $schema / additionalProperties', () => {
  const tools = convertTools([
    { name: 'a', description: 'A', parameters: { type: 'object', properties: {}, $schema: 'x', additionalProperties: false } },
    { name: 'b', parameters: { type: 'object', properties: {} } },
    { name: 'no-schema' },
  ])
  assert.equal(tools.length, 2, '缺 parameters 的工具被跳过')
  assert.equal(tools[0].cache_control, undefined)
  assert.deepEqual(tools[1].cache_control, { type: 'ephemeral' })
  assert.equal(tools[0].input_schema.$schema, undefined)
  assert.equal(tools[0].input_schema.additionalProperties, undefined)
})

test('buildUpstreamBody: DSH 工具调用/结果翻成 Anthropic 块', () => {
  const body = buildUpstreamBody({
    options: {
      model: 'GLM-5.3-Flash',
      system: [{ type: 'text', text: 'SYS' }],
      maxTokens: 1000,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'list files' }] },
        {
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'call_1', name: 'pwsh', arguments: { cmd: 'ls' } }],
        },
        { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call_1', output: 'a.txt' }] },
      ],
      tools: [{ name: 'pwsh', parameters: { type: 'object', properties: {} } }],
      temperature: 0.2,
    },
    cwd: 'C:/w',
    maxTokens: 1000,
  })

  assert.equal(body.model, 'GLM-5.3-Flash')
  assert.equal(body.stream, true)
  assert.equal(body.max_tokens, 1000)
  assert.equal(body.temperature, 0.2)
  assert.equal(body.messages[0].role, 'user')
  assert.match(body.messages[0].content[0].text, /system-reminder/)

  const assistant = body.messages[1]
  const toolUse = assistant.content.find((block) => block.type === 'tool_use')
  assert.equal(toolUse.id, 'call_1')
  assert.equal(toolUse.name, 'pwsh')
  assert.deepEqual(toolUse.input, { cmd: 'ls' })

  const toolResult = body.messages[2].content.find((block) => block.type === 'tool_result')
  assert.equal(toolResult.tool_use_id, 'call_1')
  assert.equal(toolResult.content, 'a.txt')

  assert.equal(body.tools[0].cache_control.type, 'ephemeral')
})

test('buildUpstreamBody: 回放宿主保存的 JSON 字符串工具参数时，tool_use.input 必须是对象', () => {
  const body = buildUpstreamBody({
    options: {
      model: 'GLM-5.3-Flash',
      messages: [
        userMessage('运行命令'),
        { role: 'assistant', content: [{
          type: 'tool-call', id: 'call_pwsh', name: 'pwsh',
          arguments: '{"description":"列出文件","command":"Get-ChildItem","options":{"cwd":"C:/w"}}',
        }] },
      ],
    },
    now: new Date(2026, 9, 24),
  })
  assert.deepEqual(body.messages[1].content[0].input, {
    description: '列出文件', command: 'Get-ChildItem', options: { cwd: 'C:/w' },
  })
})

test('buildUpstreamBody: 不向历史回放思考块', () => {
  const body = buildUpstreamBody({
    options: {
      model: 'GLM-5.3',
      messages: [
        userMessage('hi'),
        { role: 'assistant', content: [{ type: 'reasoning', text: 'thinking…' }, { type: 'text', text: 'ok' }] },
      ],
    },
  })
  const assistant = body.messages[1]
  assert.deepEqual(assistant.content.map((block) => block.type), ['text'])
})

test('buildUpstreamBody: 不支持图片的模型收到占位文本', () => {
  const body = buildUpstreamBody({
    options: {
      model: 'GLM-5.3',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'see' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
          ],
        },
      ],
    },
    supportsImages: false,
  })
  const blocks = body.messages[0].content
  assert.equal(blocks.some((block) => block.type === 'image'), false)
  assert.match(blocks.map((block) => block.text).join('|'), /image omitted/)
})

// ---------------------------------------------------------------------------
// 图片输入：宿主 ImageBlock（持久引用）→ 附件服务字节 → Anthropic base64 块。
// 宿主契约：`dsh-llm` 的 ImageBlock 是 `{ type:'image', attachment: ref }`，
// ref = `{ attachmentId:'sha256:<hex>', mediaType, width, height, bytes, name? }`
// （attachment-local 实测）。此前 convertContent 只认 base64 形态，
// 引用块被静默丢弃 —— 用户发图但上游什么都没收到。
// ---------------------------------------------------------------------------

const PNG_REF = {
  attachmentId: 'sha256:abcd1234ef567890',
  mediaType: 'image/png',
  width: 64,
  height: 32,
  bytes: 100,
}

const FAKE_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])

test('imageOccurrences: 识别宿主持久引用与内联 base64 两种形态', () => {
  const blocks = [
    { type: 'text', text: 'see' },
    { type: 'image', attachment: PNG_REF },
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QQ==' } },
    { type: 'file', attachment: { attachmentId: 'sha256:file' } },
  ]
  const found = imageOccurrences(blocks)
  assert.equal(found.length, 2)
  assert.equal(found[0].attachmentId, PNG_REF.attachmentId)
  assert.deepEqual(found[0].ref, PNG_REF)
  assert.equal(found[1].attachmentId, 'inline:2')
  assert.equal(found[1].inline.mediaType, 'image/jpeg')
})

test('imageBlockFromAttachment: 字节编码为 Anthropic base64 块', () => {
  const block = imageBlockFromAttachment(PNG_REF, FAKE_BYTES)
  assert.equal(block.type, 'image')
  assert.equal(block.source.type, 'base64')
  assert.equal(block.source.media_type, 'image/png')
  assert.equal(Buffer.from(block.source.data, 'base64').compare(Buffer.from(FAKE_BYTES)), 0)
})

test('convertContent: 持久引用 + 已解析字节 → base64 image 块', () => {
  const blocks = convertContent(
    [
      { type: 'text', text: 'look' },
      { type: 'image', attachment: PNG_REF },
    ],
    { resolvedImages: new Map([[PNG_REF.attachmentId, { data: FAKE_BYTES, ref: PNG_REF }]]) },
  )
  assert.equal(blocks[0].type, 'text')
  assert.equal(blocks[1].type, 'image')
  assert.equal(blocks[1].source.type, 'base64')
  assert.equal(blocks[1].source.media_type, 'image/png')
})

test('convertContent: 引用解析失败 → 占位文本（不再静默丢弃）', () => {
  const blocks = convertContent([{ type: 'image', attachment: PNG_REF }], { resolvedImages: new Map() })
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'text')
  assert.match(blocks[0].text, /image omitted/)
})

test('resolveImages: 经附件服务 readImageRequest 解析引用字节', async () => {
  const calls = []
  const attachments = {
    async readImageRequest(ref, target, signal) {
      calls.push({ ref, target, signal })
      return { attachment: ref, data: FAKE_BYTES, mediaType: 'image/png', width: 64, height: 32, bytes: 8 }
    },
  }
  const resolved = await resolveImages(
    [
      {
        role: 'user',
        content: [{ type: 'text', text: 'hi' }, { type: 'image', attachment: PNG_REF }],
      },
    ],
    { resolveAttachments: () => attachments },
  )
  assert.equal(calls.length, 1)
  assert.equal(calls[0].ref.attachmentId, PNG_REF.attachmentId)
  assert.equal(calls[0].target.width, 64)
  assert.equal(calls[0].target.height, 32)
  assert.equal(resolved.get(PNG_REF.attachmentId).data, FAKE_BYTES)
})

test('resolveImages: 附件服务缺席 → 空 Map（图片降级占位）', async () => {
  const resolved = await resolveImages([{ role: 'user', content: [{ type: 'image', attachment: PNG_REF }] }], {})
  assert.equal(resolved.size, 0)
})

test('resolveImages: 单张解析失败不影响其余图片', async () => {
  const badRef = { ...PNG_REF, attachmentId: 'sha256:badbadbadbadbad' }
  const attachments = {
    async readImageRequest(ref) {
      if (ref.attachmentId === badRef.attachmentId) throw new Error('boom')
      return { attachment: ref, data: FAKE_BYTES }
    },
  }
  const resolved = await resolveImages(
    [
      {
        role: 'user',
        content: [{ type: 'image', attachment: PNG_REF }, { type: 'image', attachment: badRef }],
      },
    ],
    { resolveAttachments: () => attachments },
  )
  assert.equal(resolved.size, 1)
  assert.ok(resolved.has(PNG_REF.attachmentId))
  assert.ok(!resolved.has(badRef.attachmentId))
})

test('buildUpstreamBody: 宿主引用图片端到端进入上游请求体', () => {
  const body = buildUpstreamBody({
    options: {
      model: 'GLM-5.3-Flash',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '这张图里有什么？' },
            { type: 'image', attachment: PNG_REF },
          ],
        },
      ],
    },
    supportsImages: true,
    resolvedImages: new Map([[PNG_REF.attachmentId, { data: FAKE_BYTES, ref: PNG_REF }]]),
  })
  const content = body.messages[0].content
  assert.deepEqual(
    content.map((block) => block.type),
    ['text', 'text', 'image'],
    '图片必须以 image 块进入上游请求（此前被静默丢弃）；首位是日期块',
  )
  assert.equal(content[2].source.type, 'base64')
  assert.equal(content[2].source.media_type, 'image/png')
})
