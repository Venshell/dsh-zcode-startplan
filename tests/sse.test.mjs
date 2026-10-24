import test from 'node:test'
import assert from 'node:assert/strict'

import { isJsonContentType, jsonHasContent, makeSseDecoder, parseSseEvent, readContentHead } from '../lib/sse.js'

const streamOf = (chunks) =>
  new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
      controller.close()
    },
  })

const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

test('parseSseEvent: 多行 data 拼接、注释与 [DONE] 处理', () => {
  assert.deepEqual(parseSseEvent('data: {"a":1}').data, { a: 1 })
  assert.equal(parseSseEvent('data: [DONE]').data, '[DONE]')
  assert.equal(parseSseEvent(': keep-alive'), undefined)
  assert.equal(parseSseEvent('event: ping'), undefined)
  assert.equal(parseSseEvent('data: not-json').unparsed, true)
})

test('content-type 分流：非流式 JSON 不当 SSE 扫', () => {
  assert.equal(isJsonContentType('application/json'), true)
  assert.equal(isJsonContentType('text/event-stream; charset=utf-8'), false)
  assert.equal(isJsonContentType(undefined), false)
})

test('jsonHasContent: 空 content 视为无权益，错误载荷视为有响应', () => {
  assert.equal(jsonHasContent(JSON.stringify({ content: [] })), false)
  assert.equal(jsonHasContent(JSON.stringify({ content: [{ type: 'text', text: '' }] })), false)
  assert.equal(jsonHasContent(JSON.stringify({ content: [{ type: 'text', text: 'hi' }] })), true)
  assert.equal(jsonHasContent(JSON.stringify({ content: [{ type: 'tool_use', id: 'x' }] })), true)
  assert.equal(jsonHasContent(JSON.stringify({ type: 'error', error: { message: 'x' } })), true)
  /** 注意：`usage.server_tool_use` 不应被误判成有内容的工具调用。 */
  assert.equal(jsonHasContent(JSON.stringify({ content: [], usage: { server_tool_use: {} } })), false)
})

test('readContentHead: 零内容 SSE 流判为无权益', async () => {
  const body = streamOf([
    sse('message_start', { type: 'message_start', message: { model: 'GLM-5.3-Flash', usage: { input_tokens: 3 } } }),
    sse('message_stop', { type: 'message_stop' }),
  ])
  const head = await readContentHead(body, { contentType: 'text/event-stream' })
  assert.equal(head.hasContent, false)
  assert.equal(head.head.length, 2)
})

test('readContentHead: 见到首个内容帧即返回，并把解码器交给调用方继续读', async () => {
  const body = streamOf([
    sse('message_start', { type: 'message_start', message: {} }),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Hel' } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } }),
    sse('message_stop', { type: 'message_stop' }),
  ])
  const head = await readContentHead(body, { contentType: 'text/event-stream' })
  assert.equal(head.hasContent, true)
  assert.equal(head.head.length, 2)

  const rest = []
  for (;;) {
    const next = await head.decoder.read()
    if (next.done === true) break
    rest.push(next.value.data.type)
  }
  assert.deepEqual(rest, ['content_block_delta', 'message_stop'])
})

test('makeSseDecoder: 跨 chunk 切分的事件仍能拼回来', async () => {
  const body = streamOf(['event: content_block_delta\ndata: {"type":"content', '_block_delta"}\n\n'])
  const decoder = makeSseDecoder(body)
  const first = await decoder.read()
  assert.equal(first.done, false)
  assert.equal(first.value.data.type, 'content_block_delta')
  const second = await decoder.read()
  assert.equal(second.done, true)
})

test('readContentHead: 非流式 JSON 走结构判定', async () => {
  const body = streamOf([JSON.stringify({ content: [{ type: 'text', text: 'ok' }] })])
  const head = await readContentHead(body, { contentType: 'application/json' })
  assert.equal(head.hasContent, true)
  assert.equal(head.jsonMode, true)
  assert.equal(head.head[0].data.content[0].text, 'ok')
})
