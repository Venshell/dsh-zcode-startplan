/**
 * tok/s 基准：复用插件自身的完整调用链（账号池 → plan-client → 上游 SSE），
 * 跑真实流式请求，用上游 usage.output_tokens / 流式生成时长计算 tok/s。
 *
 * ⚠ 凭据安全：脚本把真实账号库**复制**到工作区临时目录后使用（避免沙箱写 Home），
 * 运行结束（含失败）一律删除副本，凭据不落任何第二份。
 *
 * 用法：node scripts/bench-toks.mjs [运行次数，默认 2]
 */

import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { SqliteStore, AccountPool } from '../lib/pool.js'
import { ZcodePlanClient } from '../lib/plan-client.js'

const srcDir = join(homedir(), '.dsh', 'zcode-start-plan')
const tmpDir = join(process.cwd(), '.bench-tmp')

/** 上游事件扫描：抽取 usage 与文本增量。 */
function scanEvent(ev, acc) {
  const d = ev?.data
  if (d === null || typeof d !== 'object') return
  if (d.type === 'message_start') {
    const u = d.message?.usage
    if (u !== undefined && u !== null) {
      acc.inTokens = u.input_tokens ?? acc.inTokens
      acc.cacheReadTokens = u.cache_read_input_tokens ?? acc.cacheReadTokens
      acc.cacheWriteTokens = u.cache_creation_input_tokens ?? acc.cacheWriteTokens
    }
  } else if (d.type === 'message_delta') {
    if (typeof d.usage?.output_tokens === 'number') acc.outTokens = d.usage.output_tokens
  } else if (d.type === 'content_block_delta') {
    if (d.delta?.type === 'text_delta') acc.textChars += (d.delta.text ?? '').length
    if (d.delta?.type === 'thinking_delta') acc.thinkChars += (d.delta.thinking ?? '').length
  } else if (d.type === 'error') {
    acc.streamError = JSON.stringify(d).slice(0, 300)
  }
}

async function runOnce(client, pool, model, runIndex) {
  const acc = { inTokens: 0, outTokens: 0, textChars: 0, thinkChars: 0, cacheReadTokens: 0, cacheWriteTokens: 0, streamError: undefined }
  const prompt = '请从 1 数到 300，每行输出一个数字，不要输出任何其他文字。'
  const t0 = Date.now()
  const res = await client.call({
    options: {
      model,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      tools: [],
    },
    model: { id: model, name: model, supportsImage: false },
    maxTokens: 2048,
  })
  const tFirst = Date.now() // readContentHead 返回 = 首个内容帧已到达
  for (const ev of res.head) scanEvent(ev, acc)
  if (res.decoder !== undefined) {
    for (;;) {
      const next = await res.decoder.read()
      if (next.done === true) break
      scanEvent(next.value, acc)
    }
  }
  const tEnd = Date.now()
  const nick = pool.list().find((entry) => entry.id === res.accountId)?.nickname ?? res.accountId
  const genSec = (tEnd - tFirst) / 1000
  return {
    run: runIndex,
    model,
    account: nick,
    ttftMs: tFirst - t0,
    genMs: tEnd - tFirst,
    inTokens: acc.inTokens,
    outTokens: acc.outTokens,
    cacheReadTokens: acc.cacheReadTokens,
    cacheWriteTokens: acc.cacheWriteTokens,
    textChars: acc.textChars,
    thinkChars: acc.thinkChars,
    tokPerSec: genSec > 0 ? Math.round((acc.outTokens / genSec) * 10) / 10 : 0,
    streamError: acc.streamError ?? null,
  }
}

const runs = Number(process.argv[2] ?? '2')
const plan = [
  { model: 'GLM-5.3-Flash', times: runs },
  { model: 'GLM-5.3', times: 1 },
]

mkdirSync(tmpDir, { recursive: true })
try {
  for (const f of ['accounts.db', 'accounts.db-wal', 'accounts.db-shm']) {
    const src = join(srcDir, f)
    if (existsSync(src)) copyFileSync(src, join(tmpDir, f))
  }
  const store = await new SqliteStore(join(tmpDir, 'accounts.db'))
  try {
    const pool = new AccountPool({ store, log: () => {} })
  pool.sweepExpired()
  const accounts = pool.list()
  console.log(`账号池：${accounts.length} 个（启用 ${accounts.filter((e) => e.enabled).length} 个）：${accounts.map((e) => e.nickname).join(' / ')}`)
  if (accounts.length === 0) throw new Error('账号池为空：无法基准（真实账号库读取失败或为空）')

  const logs = []
  const client = new ZcodePlanClient({
    pool,
    minter: { mint: async () => { throw new Error('bench 模式不产出 captcha') } },
    log: (m) => logs.push(m),
  })

  const results = []
  let index = 1
  for (const item of plan) {
    for (let i = 0; i < item.times; i += 1) {
      const r = await runOnce(client, pool, item.model, index)
      results.push(r)
      console.log(JSON.stringify(r))
      index += 1
    }
  }

  console.log('--- 关键日志 ---')
  for (const line of logs.filter((m) => m.includes('命中') || m.includes('零内容') || m.includes('上游') || m.includes('重试'))) {
    console.log(line)
  }
  console.log('--- 汇总 ---')
  for (const model of [...new Set(results.map((r) => r.model))]) {
    const rs = results.filter((r) => r.model === model)
    const avg = Math.round((rs.reduce((s, r) => s + r.tokPerSec, 0) / rs.length) * 10) / 10
    const avgTtft = Math.round(rs.reduce((s, r) => s + r.ttftMs, 0) / rs.length)
    console.log(`${model}: 平均 ${avg} tok/s（流式生成段），平均首帧 ${avgTtft}ms，共 ${rs.length} 次`)
  }
} finally {
  // ⚠ Windows：SQLite WAL 句柄不关，rmSync 会 EPERM。
  try { store?.close() } catch { /* 已关闭 */ }
  try { rmSync(tmpDir, { recursive: true, force: true }) } catch (error) {
    console.warn(`[bench] 临时目录清理失败（可手动删除 ${tmpDir}）：${error instanceof Error ? error.message : String(error)}`)
  }
}
