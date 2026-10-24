/**
 * 与宿主 `BlockAssembler` 的**契约级**测试。
 *
 * 宿主 `dsh-llm/lib/index.js` 的 `BlockAssembler` 逐字如下：
 *
 * ```js
 * case "block-start":     partials.set(index, { blockType: chunk.blockType, text: "", toolCallArguments: "" })
 * case "text-delta":
 * case "reasoning-delta": partial.text += chunk.text
 * case "tool-call-delta": toolCallId = chunk.id; toolCallName = chunk.name; toolCallArguments += chunk.argumentsDelta
 * case "block-end":       partial.block = chunk.block
 * ```
 *
 * ⚠ 三处形状必须严格对上，否则宿主侧炸：
 *   - `block-start` 用 **`blockType`（字符串）**，不是 `block`（对象）；
 *   - `block-end` **必须带 `block`**（assemble 直接返回它）；
 *   - `tool-call-delta` 的字段名是 `id` / `name` / **`argumentsDelta`**。
 *
 * 之前我发的是 `{ block: {...} }` / `{ arguments }` —— `blockType` 读到 undefined，
 * 宿主 `partial.block.type` 解引用即抛
 * `Cannot read properties of undefined (reading 'type')`。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { AnthropicStreamTranslator } from '../lib/stream-translator.js'

/** 宿主 `BlockAssembler` 的忠实复刻（用于验证我们的 chunk 形状）。 */
class HostBlockAssembler {
  partials = new Map()
  order = []
  _usage
  _finish

  push(chunk) {
    switch (chunk.type) {
      case 'block-start':
        if (!this.partials.has(chunk.index)) {
          this.order.push(chunk.index)
          this.partials.set(chunk.index, { blockType: chunk.blockType, text: '', toolCallArguments: '' })
        }
        return
      case 'text-delta':
      case 'reasoning-delta': {
        const partial = this.ensure(chunk.index, chunk.type === 'text-delta' ? 'text' : 'reasoning')
        if (partial.block) return
        partial.text += chunk.text
        return
      }
      case 'tool-call-delta': {
        const partial = this.ensure(chunk.index, 'tool-call')
        if (partial.block) return
        partial.toolCallId = chunk.id
        if (chunk.name) partial.toolCallName = chunk.name
        partial.toolCallArguments += chunk.argumentsDelta
        return
      }
      case 'block-end': {
        const partial = this.ensure(chunk.index, chunk.block.type)
        if (partial.block) return
        partial.block = chunk.block
        return
      }
      case 'usage':
        this._usage = chunk.usage
        return
      case 'finish':
        this._finish = chunk.reason
        return
      default:
        throw new Error(`unknown chunk type "${chunk.type}"`)
    }
  }

  ensure(index, blockType) {
    let partial = this.partials.get(index)
    if (!partial) {
      partial = { blockType, text: '', toolCallArguments: '' }
      this.partials.set(index, partial)
      this.order.push(index)
    }
    return partial
  }

  assemble(partial) {
    if (partial.block) return partial.block
    switch (partial.blockType) {
      case 'text':
        return { type: 'text', text: partial.text }
      case 'reasoning':
        return { type: 'reasoning', text: partial.text }
      case 'tool-call':
        return {
          type: 'tool-call',
          id: partial.toolCallId ?? 'call',
          name: partial.toolCallName ?? '',
          arguments: partial.toolCallArguments,
        }
      default:
        throw new Error(`cannot assemble incomplete block of type "${partial.blockType}"`)
    }
  }

  assembled() {
    return this.order.map((index) => this.assemble(this.partials.get(index)))
  }
}

/** 思考型模型的一次完整流（reasoning + text + tool_use）。 */
const thinkingModelStream = () => [
  { data: { type: 'message_start', message: { model: 'GLM-5.3-Flash', usage: { input_tokens: 10 } } } },
  { data: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } },
  { data: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '先想一下' } } },
  { data: { type: 'content_block_stop', index: 0 } },
  { data: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } },
  { data: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '答案' } } },
  { data: { type: 'content_block_stop', index: 1 } },
  { data: { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'pwsh', input: {} } } },
  { data: { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"cmd":' } } },
  { data: { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"ls"}' } } },
  { data: { type: 'content_block_stop', index: 2 } },
  { data: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } } },
]

/** 把一条流跑过 translator + 宿主 assembler，返回两边的产物。 */
const runThrough = (events) => {
  const translator = new AnthropicStreamTranslator()
  const assembler = new HostBlockAssembler()
  const chunks = []
  for (const event of events) {
    for (const chunk of translator.push(event)) {
      chunks.push(chunk)
      assembler.push(chunk)
    }
  }
  for (const chunk of translator.finish()) {
    chunks.push(chunk)
    assembler.push(chunk)
  }
  return { chunks, blocks: assembler.assembled() }
}

test('宿主 assembler 能完整组装思考型模型的三种块（reasoning/text/tool-call）', () => {
  const { chunks, blocks } = runThrough(thinkingModelStream())

  assert.deepEqual(chunks.map((chunk) => chunk.type), [
    'block-start',
    'reasoning-delta',
    'block-end',
    'block-start',
    'text-delta',
    'block-end',
    'block-start',
    'tool-call-delta',
    'tool-call-delta',
    'block-end',
    'usage',
    'finish',
  ])

  assert.deepEqual(blocks, [
    { type: 'reasoning', text: '先想一下' },
    { type: 'text', text: '答案' },
    { type: 'tool-call', id: 'toolu_1', name: 'pwsh', arguments: '{"cmd":"ls"}' },
  ])
})

test('block-start 必须带 blockType 字符串（不是 block 对象）', () => {
  const { chunks } = runThrough(thinkingModelStream())
  for (const chunk of chunks.filter((c) => c.type === 'block-start')) {
    assert.equal(typeof chunk.blockType, 'string', 'blockType 必须是字符串')
    assert.ok(chunk.blockType.length > 0)
    assert.equal(chunk.block, undefined, 'block-start 不该带 block（那是 block-end 的字段）')
  }
})

test('block-end 必须带完整 block 对象', () => {
  const { chunks } = runThrough(thinkingModelStream())
  for (const chunk of chunks.filter((c) => c.type === 'block-end')) {
    assert.equal(typeof chunk.block, 'object')
    assert.notEqual(chunk.block, null)
    assert.ok(['text', 'reasoning', 'tool-call'].includes(chunk.block.type))
  }
})

test('tool-call-delta 的字段名是 id / name / argumentsDelta', () => {
  const { chunks } = runThrough(thinkingModelStream())
  const deltas = chunks.filter((c) => c.type === 'tool-call-delta')
  assert.equal(deltas.length, 2)
  assert.equal(deltas[0].id, 'toolu_1')
  assert.equal(deltas[0].name, 'pwsh')
  assert.equal(deltas[0].argumentsDelta, '{"cmd":')
  assert.equal(deltas[1].argumentsDelta, '"ls"}')
  assert.equal(deltas[0].arguments, undefined, '字段名是 argumentsDelta，不是 arguments')
})

test('流未正常结束时，finish() 也补齐 block-end + block', () => {
  const translator = new AnthropicStreamTranslator()
  const chunks = []
  for (const chunk of translator.push({
    data: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
  })) {
    chunks.push(chunk)
  }
  for (const chunk of translator.push({
    data: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '半截思考' } },
  })) {
    chunks.push(chunk)
  }
  for (const chunk of translator.finish()) chunks.push(chunk)

  const end = chunks.find((c) => c.type === 'block-end')
  assert.notEqual(end, undefined)
  assert.deepEqual(end.block, { type: 'reasoning', text: '半截思考' })
})

test('工具参数是原始 JSON 字符串（宿主不做解析）', () => {
  const { blocks } = runThrough(thinkingModelStream())
  const tool = blocks.find((block) => block.type === 'tool-call')
  assert.equal(typeof tool.arguments, 'string')
  assert.deepEqual(JSON.parse(tool.arguments), { cmd: 'ls' })
})

test('宿主 assembler 接收只有内联 input 的工具调用且参数不丢失', () => {
  const { blocks } = runThrough([
    { data: { type: 'content_block_start', index: 0, content_block: {
      type: 'tool_use', id: 'toolu_inline', name: 'pwsh',
      input: { description: '列出文件', command: 'Get-ChildItem' },
    } } },
    { data: { type: 'content_block_stop', index: 0 } },
  ])
  assert.deepEqual(JSON.parse(blocks[0].arguments), {
    description: '列出文件', command: 'Get-ChildItem',
  })
})
