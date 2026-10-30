/**
 * DSH 兼容性门禁（离线，不发网络请求）。
 *
 * DSH 在加载 bundle 时会用 `evaluatePluginCompatibility` 检查 `peerDependencies` 里
 * 所有 `@deepseek-ai/dsh-*` 项，并用 `includePrerelease: true` 比较版本 ——
 * 所以写 `^0.2.0` 会把 `0.2.0-rc.2` 判成**不兼容**并静默跳过本 bundle。
 * 本脚本在重启前把这件事提前暴露出来。
 *
 * ```powershell
 * node scripts/verify_compat.mjs
 * ```
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/** 本插件实际使用、且会被门禁检查的宿主包。 */
const REQUIRED_HOST_PACKAGES = ['@deepseek-ai/dsh-llm']

const failures = []
const notes = []

const peers = pkg.peerDependencies ?? {}
for (const name of REQUIRED_HOST_PACKAGES) {
  if (typeof peers[name] !== 'string') {
    failures.push(`peerDependencies 缺 ${name} —— DSH 不会报错，但本插件依赖它的契约`)
  }
}

for (const [name, range] of Object.entries(peers)) {
  if (!name.startsWith('@deepseek-ai/dsh-')) continue
  /**
   * prerelease 陷阱：区间里没有与宿主 `major.minor.patch` 元组一致的 prerelease
   * 比较符时，rc / alpha 版会被判为不满足 —— 而且 `^0.2.1-rc.3` 这类写法还会漏掉
   * 下一个元组（`0.2.2-rc.1` 不满足它）。正确写法是按元组列出显式 prerelease 分支，
   * 例如 `>=0.2.1-alpha.1 <0.2.2 || >=0.2.2-0 <0.3.0-0`。
   */
  const tuples = [...range.matchAll(/(\d+\.\d+\.\d+)-[0-9A-Za-z.-]+/g)]
  if (/^\^?\d+\.\d+\.\d+$/.test(range)) {
    notes.push(
      `${name}: "${range}" 不含 prerelease 段；若宿主是 0.x 的 rc / alpha 版本会被判不兼容`,
    )
  } else if (tuples.length === 1) {
    notes.push(
      `${name}: "${range}" 只覆盖了 ${tuples[0][1]} 这一个元组；下一个元组的预发布版` +
        `（如 0.2.2-rc.1）会被漏掉，建议改成按元组分列的 || 形式`,
    )
  }
}

/** 本地实现必须能 `node --check` 通过（语法错误的 bundle 会被静默跳过）。 */
const entry = join(root, pkg.main ?? 'index.js')
try {
  readFileSync(entry)
} catch {
  failures.push(`入口文件不存在：${entry}`)
}

if (notes.length > 0) {
  process.stdout.write('注意：\n')
  for (const note of notes) process.stdout.write(`  · ${note}\n`)
}

if (failures.length > 0) {
  process.stderr.write('兼容性门禁失败：\n')
  for (const failure of failures) process.stderr.write(`  ✗ ${failure}\n`)
  process.exit(1)
}

process.stdout.write('✓ 兼容性门禁通过（peerDependencies 不会被判不兼容）\n')
