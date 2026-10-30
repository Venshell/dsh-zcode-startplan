/**
 * 本地 OpenAI 兼容端点（`lib/openai-gateway.js`）的纯函数契约。
 *
 * 覆盖的都是**参考实现用真机流量换来的坑**，每一条都对应一个真实故障：
 *
 * | 用例 | 对应故障 |
 * |---|---|
 * | `null` 的 content/reasoning 不崩 | 真实 SSE 里两者永远一侧为 null ⇒ 首帧 `Cannot read properties of null` |
 * | 空 `function.name` 不覆盖已有名字 | 后续分片带空串 → `unknown tool ""` |
 * | 孤儿 tool 结果被剔除 | 坏历史每轮原样重放 ⇒ 会话永久 400 |
 * | 同 id 有可用调用时结果**保留** | 只看 dropped 会把好调用的回执误删 ⇒ 孤儿 tool-call |
 * | 空 assistant 整条剔除 | 变 wire 上的开头发言 ⇒ 上游 `model_param_invalid` |
 * | `{status:200}` 的门禁 | 业务失败被读成成功 |
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  collectChatCompletion,
  contentToText,
  toGenerateOptions,
  toOpenAiSse,
} from '../lib/openai-gateway.js'

/** 把异步生成器收成数组。 */
async function drain(iter) {
  const out = []
  for await (const item of iter) out.push(item)
  return out
}

/** SSE 行 → 解析后的 JSON 对象数组（跳过 [DONE]）。 */
function parseSse(lines) {
  return lines
    .map((line) => line.replace(/^data: /, '').replace(/\n\n$/, ''))
    .filter((payload) => payload !== '[DONE]')
    .map((payload) => JSON.parse(payload))
}

// ── 请求侧 ─────────────────────────────────────────────────────────────────

test('toGenerateOptions: system/user/assistant 基本映射', () => {
  const options = toGenerateOptions({
    model: 'GLM-5.3',
    messages: [
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好呀' },
      { role: 'user', content: '继续' },
    ],
    max_tokens: 1024,
    temperature: 0.3,
  })
  assert.equal(options.maxTokens, 1024)
  assert.equal(options.temperature, 0.3)
  assert.deepEqual(options.messages[0], { role: 'system', content: [{ type: 'text', text: '你是助手' }] })
  assert.deepEqual(options.messages[1], { role: 'user', content: [{ type: 'text', text: '你好' }] })
  assert.deepEqual(options.messages[2], { role: 'assistant', content: [{ type: 'text', text: '你好呀' }] })
})

test('toGenerateOptions: 空 messages / 非法 tool_choice 被拒', () => {
  assert.throws(() => toGenerateOptions({ messages: [] }), /non-empty/)
  assert.throws(() => toGenerateOptions({}), /non-empty/)
  assert.throws(
    () => toGenerateOptions({ messages: [{ role: 'user', content: 'x' }], tool_choice: 'required' }),
    /only tool_choice auto and none/,
  )
})

test('toGenerateOptions: tool_choice none 与 tools 同时出现被拒（DSH 表达不出）', () => {
  assert.throws(
    () => toGenerateOptions({
      messages: [{ role: 'user', content: 'x' }],
      tool_choice: 'none',
      tools: [{ type: 'function', function: { name: 'read', parameters: {} } }],
    }),
    /cannot be represented/,
  )
})

test('toGenerateOptions: 工具定义转 ToolSchema；非 function 类型跳过', () => {
  const options = toGenerateOptions({
    messages: [{ role: 'user', content: 'x' }],
    tools: [
      { type: 'function', function: { name: 'read', description: '读文件', parameters: { type: 'object' } } },
      { type: 'web_search' },
    ],
  })
  assert.deepEqual(options.tools, [{ name: 'read', description: '读文件', parameters: { type: 'object' } }])
})

test('toGenerateOptions: assistant.tool_calls 与 tool 结果配对成 DSH 块', () => {
  const options = toGenerateOptions({
    messages: [
      { role: 'user', content: '看下文件' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"p":"a.txt"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '文件内容' },
    ],
  })
  assert.deepEqual(options.messages[1], {
    role: 'assistant',
    content: [{ type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"p":"a.txt"}' }],
  })
  assert.deepEqual(options.messages[2], {
    role: 'user',
    content: [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: '文件内容' }] }],
  })
})

/**
 * ⚠ 真实故障（参考实现 issue IKLRIK）：历史里 `function.name: ""` 的调用会被客户端
 * **每轮原样重放**。网关若回 400，整条会话永久不可用（用户没法自愈）。
 * 正确做法：剔除坏调用 + 剔除它的孤儿结果，会话自愈。
 */
test('toGenerateOptions: 名字为空的 tool_call 被剔除，其孤儿结果一并剔除', () => {
  const options = toGenerateOptions({
    messages: [
      { role: 'user', content: 'x' },
      { role: 'assistant', content: '我来调用', tool_calls: [{ id: 'bad', type: 'function', function: { name: '', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'bad', content: 'No such tool' },
      { role: 'user', content: 'y' },
    ],
  })
  /** assistant 正文保留（那是用户真看到的内容），坏调用没了。 */
  assert.deepEqual(options.messages[1], { role: 'assistant', content: [{ type: 'text', text: '我来调用' }] })
  /** 孤儿结果整条剔除。 */
  /** user(0) / assistant(1) / user(3) —— 孤儿 tool 与坏调用都没了。 */
  assert.equal(options.messages.length, 3, 'user + assistant(正文保留) + user')
  assert.ok(!options.messages.some((m) => JSON.stringify(m).includes('"bad"')))
})

/**
 * ⚠ 同一 id 上既有坏调用又有好调用时，结果必须**保留** —— 否则好调用变孤儿，
 * 上游照样 400（参考实现对抗审计实测打穿的第一版修法）。
 */
test('toGenerateOptions: 同 id 存在可用调用时，该 id 的工具结果必须保留', () => {
  const options = toGenerateOptions({
    messages: [
      { role: 'user', content: 'x' },
      {
        role: 'assistant',
        content: '两批',
        tool_calls: [
          { id: 'dup', type: 'function', function: { name: '', arguments: '{}' } },
          { id: 'dup', type: 'function', function: { name: 'read', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'dup', content: '结果' },
    ],
  })
  assert.ok(
    options.messages.some((m) => JSON.stringify(m).includes('"tool-result"')),
    '该 id 上还有可用调用 ⇒ 结果必须留下',
  )
})

test('toGenerateOptions: 正文为空的 assistant 且调用被剔光 ⇒ 整条剔除', () => {
  const options = toGenerateOptions({
    messages: [
      { role: 'user', content: 'x' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'bad', type: 'function', function: { name: '  ', arguments: '{}' } }] },
    ],
  })
  assert.equal(options.messages.length, 1, '空 assistant 会造成 wire 上的空开头发言')
})

test('toGenerateOptions: tool 消息缺 tool_call_id 报错（真形状错误不该被吞）', () => {
  assert.throws(
    () => toGenerateOptions({ messages: [{ role: 'user', content: 'x' }, { role: 'tool', content: 'y' }] }),
    /require tool_call_id/,
  )
})

test('toGenerateOptions: user 多模态图片转 image 块', () => {
  const options = toGenerateOptions({
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: '看图' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
      ],
    }],
  })
  assert.deepEqual(options.messages[0].content, [
    { type: 'text', text: '看图' },
    { type: 'image', url: 'data:image/png;base64,AAA' },
  ])
})

test('contentToText: 字符串直通，块数组只拼 text', () => {
  assert.equal(contentToText('hi'), 'hi')
  assert.equal(contentToText([{ type: 'text', text: 'a' }, { type: 'image_url', image_url: {} }]), 'a')
  assert.equal(contentToText(null), '')
  assert.equal(contentToText(undefined), '')
})

// ── 响应侧 ─────────────────────────────────────────────────────────────────

test('toOpenAiSse: text-delta → content 帧；finish 带 finish_reason', async () => {
  const chunks = [
    { type: 'text-delta', index: 0, text: '你' },
    { type: 'text-delta', index: 0, text: '好' },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const frames = parseSse(await drain(toOpenAiSse(chunks, 'chatcmpl-x', 'GLM-5.3')))
  assert.equal(frames[0].object, 'chat.completion.chunk')
  assert.deepEqual(frames[0].choices[0].delta, { content: '你' })
  assert.deepEqual(frames[1].choices[0].delta, { content: '好' })
  /** finish 帧在 usage 帧**之前**发出（usage 是独立的收尾帧，choices 为空）。 */
  const finishFrame = frames.find((f) => f.choices?.[0]?.finish_reason === 'stop')
  assert.ok(finishFrame, '必须有 finish_reason=stop 的帧')
  /** 用量作为独立一帧（choices 为空）。 */
  const usageFrame = frames.find((f) => f.usage !== undefined)
  assert.equal(usageFrame.usage.prompt_tokens, 10)
  assert.equal(usageFrame.usage.completion_tokens, 2)
  assert.equal(usageFrame.usage.total_tokens, 12)
})

test('toOpenAiSse: reasoning-delta → reasoning_content（不是 reasoning）', async () => {
  const frames = parseSse(await drain(toOpenAiSse(
    [{ type: 'reasoning-delta', index: 0, text: '想想' }, { type: 'finish', reason: { kind: 'stop' } }],
    'id', 'm',
  )))
  assert.deepEqual(frames[0].choices[0].delta, { reasoning_content: '想想' })
  assert.equal(frames[0].choices[0].delta.reasoning, undefined, '两边同时发会让部分客户端重复渲染')
})

test('toOpenAiSse: 工具分片带空 name 不清空已解析的名字', async () => {
  const frames = parseSse(await drain(toOpenAiSse([
    { type: 'tool-call-delta', index: 0, id: 'c1', name: 'read', argumentsDelta: '{"p"' },
    /** 后续分片 name 为空串 —— 真实上游会这样。 */
    { type: 'tool-call-delta', index: 0, id: 'c1', name: '', argumentsDelta: ':1}' },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ], 'id', 'm')))
  assert.equal(frames[0].choices[0].delta.tool_calls[0].function.name, 'read')
  assert.equal(frames[1].choices[0].delta.tool_calls[0].function.name, 'read', '空串不得覆盖')
  assert.equal(frames.at(-1).choices[0].finish_reason, 'tool_calls')
})

test('toOpenAiSse: 上游错误帧 + 不抛异常', async () => {
  const frames = parseSse(await drain(toOpenAiSse(
    [{ type: 'finish', reason: { kind: 'error', failure: { message: '额度用尽', code: 'QUOTA', status: 429 } } }],
    'id', 'm',
  )))
  assert.equal(frames.length, 1)
  assert.equal(frames[0].choices.length, 0)
  assert.equal(frames[0].error.message, '额度用尽')
})

test('collectChatCompletion: 折叠成 chat.completion（content + tool_calls + usage）', async () => {
  const payload = await collectChatCompletion([
    { type: 'text-delta', index: 0, text: '答' },
    { type: 'tool-call-delta', index: 1, id: 'c1', name: 'read', argumentsDelta: '{"p":1}' },
    { type: 'usage', usage: { inputTokens: 5, outputTokens: 3, cachedInputTokens: 2 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ], 'chatcmpl-y', 'GLM-5.3')
  assert.equal(payload.object, 'chat.completion')
  assert.equal(payload.choices[0].message.content, '答')
  assert.equal(payload.choices[0].finish_reason, 'tool_calls')
  assert.deepEqual(payload.choices[0].message.tool_calls, [
    { id: 'c1', type: 'function', function: { name: 'read', arguments: '{"p":1}' } },
  ])
  assert.equal(payload.usage.prompt_tokens_details.cached_tokens, 2)
  assert.equal(payload.usage.prompt_cache_hit_tokens, 2)
})

test('collectChatCompletion: 无正文时 content=null（不是空串）', async () => {
  const payload = await collectChatCompletion(
    [{ type: 'finish', reason: { kind: 'stop' } }],
    'id', 'm',
  )
  assert.equal(payload.choices[0].message.content, null)
})

/**
 * ⚠ 流没有 finish ⇒ 上游半截断开。**必须报错**：谎报成功会让客户端把半截输出
 * 当完整结果持久化（参考实现踩过的同一个坑）。
 */
test('collectChatCompletion: 流缺 finish 时报错（不假装成功）', async () => {
  await assert.rejects(
    () => collectChatCompletion([{ type: 'text-delta', index: 0, text: '半截' }], 'id', 'm'),
    /ended before finish/,
  )
})


/**
 * ⚠ 真实 bug（实现期踩到）：`result.decoder` 是
 * `{ read(): Promise<{done, value?}> }`（plan-client.js 的返回类型注释），
 * **不是**异步生成器。误当生成器 `for await` 消费会报
 * `result.decoder.read is not a function` —— 被 catch 兜住后只发一帧 error
 * chunk，表现为「流式回答只有一个 reasoning 帧就断了」。
 *
 * 本用例用**真实 decoder 形状**驱动整条 HTTP 路径。
 */
test('HTTP: 流式走真实 decoder 形状（read() 而非 for await），帧完整', async () => {
  const { startOpenAiGateway } = await import('../lib/openai-gateway.js')
  /** 分发 key 形态（网关 0.9.5 起只认它）。 */
  const key = `zsp-${(await import('node:crypto')).randomBytes(16).toString('base64url')}`
  const all = [
    { type: 'reasoning-delta', index: 0, text: '思考' },
    { type: 'text-delta', index: 0, text: '回答' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  /** 按 plan-client **真实形状**造 decoder：read() 逐个吐，末次 done。 */
  let cursor = 1
  const decoder = {
    async read() {
      if (cursor >= all.length) return { done: true }
      return { done: false, value: all[cursor++] }
    },
    async cancel() {},
  }
  const gateway = await startOpenAiGateway({
    port: 0,
    models: async () => [],
    log: () => {},
    planClient: { call: async () => ({ head: all.slice(0, 1), decoder }) },
    /** 0.9.5 起鉴权只认分发 key：让本测试的随机 key 有效。 */
    findDistributionKey: (presented) => (presented === key ? { token: key, enabled: true, usage: {} } : undefined),
  })
  try {
    const response = await fetch(`${gateway.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    })
    const raw = await response.text()
    assert.doesNotMatch(raw, /is not a function/, 'decoder 必须是 read() 形状')
    const frames = raw.split('\n\n').filter((chunk) => chunk.startsWith('data: ') && !chunk.includes('[DONE]'))
      .map((chunk) => JSON.parse(chunk.slice('data: '.length)))
    const deltas = frames.map((frame) => frame.choices?.[0]?.delta).filter(Boolean)
    assert.ok(deltas.some((delta) => delta.reasoning_content === '思考'), 'reasoning 帧')
    assert.ok(deltas.some((delta) => delta.content === '回答'), 'content 帧必须真的发出来')
    assert.ok(frames.some((frame) => frame.choices?.[0]?.finish_reason === 'stop'), 'finish 帧')
  } finally {
    await gateway.close()
  }
})
