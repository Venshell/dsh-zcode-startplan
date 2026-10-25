// 端到端：真实账号 + 真实图片 → zcode-plan 上游，验证带图请求被接受（HTTP 200 + 内容）。
// 用最小 1x1 PNG（官方 Anthropic 文档格式），走插件的 buildUpstreamBody 完整链路。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { buildUpstreamBody } from 'file:///C:/Users/Vens_/.dsh/plugins/dsh-zcode-startplan/lib/anthropic-body.js'
import { buildZcodeHeaders, ZCODE_PLAN_MESSAGES_URL } from 'file:///C:/Users/Vens_/.dsh/plugins/dsh-zcode-startplan/lib/upstream.js'
import { readContentHead } from 'file:///C:/Users/Vens_/.dsh/plugins/dsh-zcode-startplan/lib/sse.js'

const dataDir = 'C:/Users/Vens_/.dsh/zcode-start-plan'
const db = new DatabaseSync(join(dataDir, 'accounts.db'), { readOnly: true })
const rows = db.prepare('SELECT id, nickname, enabled, credential FROM accounts').all()
db.close()
const wanted = process.argv[2]
const account = wanted !== undefined ? rows.find((row) => row.nickname === wanted && row.enabled === 1) : rows.find((row) => row.enabled === 1)
if (account === undefined) { console.error('no enabled account'); process.exit(1) }
const credential = JSON.parse(account.credential)
console.log('account:', account.nickname)

/** 1x1 红色 PNG（Anthropic 官方示例图）。 */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const imageBytes = Buffer.from(PNG_BASE64, 'base64')
const ref = { attachmentId: 'sha256:e2e-test0000000001', mediaType: 'image/png', width: 1, height: 1, bytes: imageBytes.byteLength }

const body = buildUpstreamBody({
  options: {
    model: 'GLM-5.3-Flash',
    maxTokens: 256,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What color is this image? Answer with one word.' },
          { type: 'image', attachment: ref },
        ],
      },
    ],
  },
  cwd: 'C:/w',
  provider: 'zcode-start-plan',
  supportsImages: true,
  resolvedImages: new Map([[ref.attachmentId, { data: imageBytes, ref }]]),
})

const wire = body.messages[0].content.find((block) => block.type === 'image')
console.log('wire image block:', wire === undefined ? 'MISSING' : `base64 ${wire.source.media_type} len=${wire.source.data.length}`)

const headers = buildZcodeHeaders(credential, { authorization: `Bearer ${credential.zcode_jwt}` })
const response = await fetch(ZCODE_PLAN_MESSAGES_URL, { method: 'POST', headers, body: JSON.stringify(body) })
console.log('HTTP', response.status)
const head = await readContentHead(response.body, { contentType: response.headers.get('content-type') ?? undefined })
if (head.upstreamError !== undefined) {
  console.log('UPSTREAM ERROR:', head.upstreamError.text.slice(0, 300))
  process.exit(1)
}
console.log('hasContent:', head.hasContent)
let text = ''
const kinds = new Map()
const collect = (event) => {
  const data = event?.data ?? event
  const type = data?.type ?? event?.event ?? 'unknown'
  kinds.set(type, (kinds.get(type) ?? 0) + 1)
  if (data?.type === 'content_block_delta') {
    if (data.delta?.type === 'text_delta') text += data.delta.text
    if (data.delta?.type === 'thinking_delta') text += data.delta.thinking ?? ''
  }
}
for (const event of head.head) collect(event)
if (head.decoder !== undefined) {
  for (;;) {
    const next = await head.decoder.read()
    if (next.done === true) break
    collect(next.value)
  }
}
console.log('event kinds:', [...kinds.entries()].map(([type, count]) => `${type}×${count}`).join(', '))
console.log('answer:', text.trim().slice(0, 300))
