import test from 'node:test'
import assert from 'node:assert/strict'

import { AnthropicStreamTranslator, mapErrorCode, mapStopReason } from '../lib/stream-translator.js'

const ev = (type, payload) => ({ event: type, data: { type, ...payload } })

test('text 块：block-start → text-delta → block-end，最后 usage → finish', () => {
  const translator = new AnthropicStreamTranslator()
  const out = []
  out.push(...translator.push(ev('message_start', { message: { model: 'GLM-5.3-Flash', usage: { input_tokens: 11 } } })))
  out.push(...translator.push(ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })))
  out.push(...translator.push(ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Hi' } })))
  out.push(...translator.push(ev('content_block_stop', { index: 0 })))
  out.push(...translator.push(ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } })))
  out.push(...translator.finish())

  assert.deepEqual(out.map((chunk) => chunk.type), [
    'block-start',
    'text-delta',
    'block-end',
    'usage',
    'finish',
  ])
  assert.equal(out[1].text, 'Hi')
  assert.deepEqual(out[3].usage, { inputTokens: 11, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 })
  /** 官方契约：finish.reason 是对象（FinishReasonMap），宿主 BlockAssembler 读 chunk.reason。 */
  assert.deepEqual(out[4], { type: 'finish', reason: { kind: 'stop' } })
})

test('tool_use：参数以原始 JSON 字符串增量下发，stop_reason=tool_use → tool-calls', () => {
  const translator = new AnthropicStreamTranslator()
  const out = []
  out.push(...translator.push(ev('content_block_start', {
    index: 0,
    content_block: { type: 'tool_use', id: 'toolu_1', name: 'pwsh', input: {} },
  })))
  out.push(...translator.push(ev('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"cmd":' } })))
  out.push(...translator.push(ev('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '"ls"}' } })))
  out.push(...translator.push(ev('message_delta', { delta: { stop_reason: 'tool_use' } })))
  out.push(...translator.finish())

  /** ⚠ 宿主 assembler 读 `blockType`（字符串），不是 `block`（对象）。 */
  assert.equal(out[0].blockType, 'tool-call')
  assert.deepEqual(
    out.filter((chunk) => chunk.type === 'tool-call-delta').map((chunk) => chunk.argumentsDelta),
    ['{"cmd":', '"ls"}'],
  )
  /** 工具名/id 走 tool-call-delta 的 `name` / `id` 字段。 */
  const firstDelta = out.find((chunk) => chunk.type === 'tool-call-delta')
  assert.equal(firstDelta.id, 'toolu_1')
  assert.equal(firstDelta.name, 'pwsh')
  /** block-end 必须带完整 block。 */
  const end = out.find((chunk) => chunk.type === 'block-end')
  assert.deepEqual(end.block, { type: 'tool-call', id: 'toolu_1', name: 'pwsh', arguments: '{"cmd":"ls"}' })
  assert.equal(out[out.length - 1].reason.kind, 'tool-calls')
})

test('tool_use：只有 start 内联 input 时，结束块保留完整工具参数', () => {
  const translator = new AnthropicStreamTranslator()
  translator.push(ev('content_block_start', {
    index: 0,
    content_block: { type: 'tool_use', id: 'toolu_inline', name: 'pwsh',
      input: { description: '列出文件', command: 'Get-ChildItem' } },
  }))
  const out = translator.push(ev('content_block_stop', { index: 0 }))
  assert.deepEqual(JSON.parse(out[0].block.arguments), {
    description: '列出文件', command: 'Get-ChildItem',
  })
})

test('tool_use：同时有内联 input 和 JSON 增量时，以完整增量为准', () => {
  const translator = new AnthropicStreamTranslator()
  translator.push(ev('content_block_start', {
    index: 0,
    content_block: { type: 'tool_use', id: 'toolu_delta', name: 'pwsh',
      input: { description: '旧值', command: 'old' } },
  }))
  translator.push(ev('content_block_delta', {
    index: 0, delta: { type: 'input_json_delta', partial_json: '{"description":"新值",' },
  }))
  translator.push(ev('content_block_delta', {
    index: 0, delta: { type: 'input_json_delta', partial_json: '"command":"new"}' },
  }))
  const out = translator.push(ev('content_block_stop', { index: 0 }))
  assert.deepEqual(JSON.parse(out[0].block.arguments), { description: '新值', command: 'new' })
})

test('thinking → reasoning-delta', () => {
  const translator = new AnthropicStreamTranslator()
  const out = []
  out.push(...translator.push(ev('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } })))
  out.push(...translator.push(ev('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } })))
  assert.equal(out[0].blockType, 'reasoning')
  assert.equal(out[1].type, 'reasoning-delta')
})

test('多块顺序：chunk index 与上游 index 解耦（1,2,3 连续递增）', () => {
  const translator = new AnthropicStreamTranslator()
  const out = []
  out.push(...translator.push(ev('content_block_start', { index: 0, content_block: { type: 'text' } })))
  out.push(...translator.push(ev('content_block_stop', { index: 0 })))
  out.push(...translator.push(ev('content_block_start', { index: 5, content_block: { type: 'text' } })))
  out.push(...translator.push(ev('content_block_stop', { index: 5 })))
  const indices = out.filter((chunk) => chunk.type === 'block-start').map((chunk) => chunk.index)
  assert.deepEqual(indices, [0, 1])
})

test('流内 error 事件 → terminal finish 错误 chunk（带稳定失败码）', () => {
  const translator = new AnthropicStreamTranslator()
  translator.push(ev('error', { error: { type: 'api_error', message: '{"code":3012,"msg":"unusual activity"}' } }))
  const out = translator.finish()
  const finish = out[out.length - 1]
  assert.equal(finish.type, 'finish')
  /** 宿主读 chunk.reason（BlockAssembler: this._finish = chunk.reason）。 */
  assert.deepEqual(finish.reason, { kind: 'error', failure: { code: 'RATE_LIMIT', message: finish.reason.failure.message } })
  assert.equal(finish.reason.failure.code, 'RATE_LIMIT')
  assert.match(finish.reason.failure.message, /3012/)
})

test('finish 之前必定先发 usage（DSH 协议顺序）', () => {
  const translator = new AnthropicStreamTranslator()
  const out = translator.finish()
  assert.deepEqual(out.map((chunk) => chunk.type), ['usage', 'finish'])
})

test('mapStopReason / mapErrorCode', () => {
  /** mapStopReason 返回 FinishReasonMap 形态的 reason 对象。 */
  assert.deepEqual(mapStopReason('max_tokens'), { kind: 'max-tokens' })
  assert.deepEqual(mapStopReason('tool_use'), { kind: 'tool-calls' })
  assert.deepEqual(mapStopReason('end_turn'), { kind: 'stop' })
  assert.deepEqual(mapStopReason('unknown'), { kind: 'stop' })
  assert.equal(mapErrorCode({ message: '{"code":1005}' }), 'QUOTA')
  assert.equal(mapErrorCode({ message: 'token expired' }), 'AUTH')
  assert.equal(mapErrorCode({ type: 'rate_limit_error', message: 'x' }), 'RATE_LIMIT')
  assert.equal(mapErrorCode({ message: 'boom' }), 'PROVIDER_ERROR')
})
