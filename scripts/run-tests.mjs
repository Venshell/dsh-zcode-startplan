/**
 * 在**单进程内**跑完全部测试文件。
 *
 * 为什么不用 `node --test tests/`：那会让 runner 为每个文件 `spawn` 子进程，
 * 而沙箱/受限环境下 `spawn` 返回 `EPERM`（`node:test` 的 runner 无法降级）。
 * 本脚本用 `run()`（同进程，in-process）跑同一批文件，结果与文件数无关。
 *
 * ```powershell
 * node scripts/run-tests.mjs
 * ```
 */

import { readdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { run } from 'node:test'

/**
 * ⚠ 先注册宿主依赖解析钩子：源码目录不在 profile 里，
 * 裸包 `@deepseek-ai/schemastery` 只有从安装位置才能解析到。
 * 钩子只对「解析失败」的 `@deepseek-ai/*` 生效，不改变其余解析。
 */
await import('../tests/support/resolve-profile-deps.mjs')

const here = dirname(fileURLToPath(import.meta.url))
const testsDir = join(here, '..', 'tests')

const files = readdirSync(testsDir)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => join(testsDir, name))

if (files.length === 0) {
  process.stderr.write('没有找到 tests/*.test.mjs\n')
  process.exit(1)
}

let failures = 0
let total = 0

const stream = run({
  files,
  concurrency: 1,
  isolation: 'none',
})

for await (const event of stream) {
  if (event.type === 'test:fail') {
    failures += 1
    total += 1
    process.stderr.write(`✗ ${event.data.name}\n`)
    const error = event.data.details?.error
    if (error !== undefined) process.stderr.write(`${indent(error.stack ?? String(error))}\n`)
  } else if (event.type === 'test:pass') {
    total += 1
    if (event.data.nesting === 0) process.stdout.write(`· ${event.data.name}\n`)
  }
}

process.stdout.write(`\n${total - failures}/${total} 通过${failures === 0 ? '' : `（${failures} 失败）`}\n`)
if (failures > 0) process.exitCode = 1

function indent(text) {
  return String(text)
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n')
}
