/**
 * 冒烟：对**已安装**的插件跑一次真实接线（不联网、不建账号）。
 *
 * 为什么需要它：`apply()` 的正确性依赖几个只有「真装进 profile」才暴露的细节 ——
 * `package.json` 的 `dsh.bundle.patch` 声明、`Config` 契约形状、`inject: ['llm']`
 * 的晚到服务、以及 `dispose` 是否被正确挂上。这些在单元测试里是假的 ctx，在这里是真的。
 *
 * ```powershell
 * node scripts/smoke-install.mjs
 * node scripts/smoke-install.mjs "C:\path\to\dsh-zcode-startplan"   # 指定安装位置
 * ```
 *
 * 退出码：0 = 全部通过；1 = 有失败项。
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const entryRoot =
  process.argv[2] ??
  join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-zcode-startplan')

const checks = []
const ok = (name, pass, detail = '') => checks.push({ name, pass: Boolean(pass), detail })

let mod
try {
  mod = await import(pathToFileURL(join(entryRoot, 'index.js')).href)
} catch (error) {
  console.error(`✗ 无法 import ${entryRoot}/index.js：${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

const pkg = JSON.parse(await readFile(join(entryRoot, 'package.json'), 'utf8'))

ok('导出 name', mod.name === 'zcode-start-plan', String(mod.name))
/**
 * ⚠ 宿主 ctx 是**沙箱 façade**：只挂 `inject` 声明过的服务。
 * 这条断言把「用到哪些服务就声明哪些」钉住 —— 漏一个，
 * `apply` 里一碰就抛 `cannot get property "X" without inject`，
 * 插件静默失效（工具与模型全都没有）。
 */
const inject = Array.isArray(mod.inject) ? mod.inject : []
for (const required of ['llm', 'tools', 'timer']) {
  ok(`inject 声明 ${required}`, inject.includes(required), JSON.stringify(inject))
}
/**
 * ⚠ 这一条是「插件进不进模型选择器」的生死线：DSH 用 `isNativeConfigSchema`
 * （`Symbol.for('schemastery') === true` + string `type` + object `meta`）判定，
 * 不符合就得到 `status: 'unsupported'`，provider 不会出现在模型列表里。
 */
const configMeta = Reflect.get(mod.Config ?? {}, 'meta')
const native = Reflect.get(mod.Config ?? {}, Symbol.for('schemastery')) === true
  && typeof Reflect.get(mod.Config ?? {}, 'type') === 'string'
  && typeof configMeta === 'object'
  && configMeta !== null
ok('Config 是 schemastery 原生 schema（否则进不了模型列表）', native)
ok('导出 apply', typeof mod.apply === 'function')
ok('dsh.bundle.patch 已声明', pkg.dsh?.bundle?.patch === './cordis.patch.yml', String(pkg.dsh?.bundle?.patch))
ok('peerDependencies 含 dsh-llm', typeof pkg.peerDependencies?.['@deepseek-ai/dsh-llm'] === 'string')
/**
 * 官方标准：Host-only bundle **零运行时依赖**。插件用自制的 schemastery 兼容
 * schema，所以这里断言**不**声明 schemastery 依赖 —— 声明了反而会在
 * `link:` 安装时解析失败、把宿主 host 进程掀翻。
 */
ok('peerDependencies 不含 schemastery（零运行时依赖）', pkg.peerDependencies?.['@deepseek-ai/schemastery'] === undefined)

const defaults = mod.Config({ captcha: { debugPort: 9229 } })
ok('Config 补齐默认值', defaults.provider === 'zcode-start-plan' && defaults.captcha.debugPort === 9229)
let rejected = false
try {
  mod.Config({ captcha: { mode: 'browser' } })
} catch {
  rejected = true
}
ok('Config 拒绝非法 captcha.mode', rejected)

/**
 * 仿宿主沙箱 ctx：**只提供 `inject` 声明过的三个服务**，
 * 不提供 `emit` / `on` / `inject` / `setInterval` —— 沙箱里没有它们
 * （提供了反而掩盖真实缺陷）。
 */
const registered = []
const tools = []
const disposers = []
const intervals = []
const ctx = {
  logger: {
    info: (message) => process.stdout.write(`  [info] ${message}\n`),
    warn: (message) => process.stdout.write(`  [warn] ${message}\n`),
  },
  llm: {
    registerAdapter: (providers, adapter) => {
      registered.push({ providers, adapter })
      return () => {}
    },
    emitAdaptersUpdated() {},
  },
  tools: { register: (tool) => { tools.push(tool); return () => {} } },
  timer: { interval: (_cb, delay) => { intervals.push(delay); return () => {} } },
  effect(fn) {
    const disposer = fn()
    if (typeof disposer === 'function') disposers.push(disposer)
    return disposer
  },
}

const dataDir = join(process.env.TEMP ?? '/tmp', `zsp-smoke-${Date.now()}`)
const cleanup = mod.apply(ctx, { dataDir })

for (let i = 0; i < 300 && registered.length === 0; i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

ok('apply 返回 cleanup（官方标准）', typeof cleanup === 'function', typeof cleanup)
ok('registerAdapter 被调用一次', registered.length === 1, String(registered.length))
ok('路由名正确', JSON.stringify(registered[0]?.providers) === '["zcode-start-plan"]')
ok(
  'adapter 具备 stream / listModels / resolveModel',
  typeof registered[0]?.adapter?.stream === 'function' &&
    typeof registered[0]?.adapter?.listModels === 'function' &&
    typeof registered[0]?.adapter?.resolveModel === 'function',
)
ok(
  '注册了状态工具 zcode_start_plan_status',
  tools.length === 1 && tools[0].name === 'zcode_start_plan_status',
  JSON.stringify(tools.map((tool) => tool.name)),
)

if (tools[0] !== undefined) {
  const status = await tools[0].execute()
  ok('status.provider 正确', status.provider === 'zcode-start-plan')
  ok('status 不泄露凭据', !JSON.stringify(status).includes('zcode_jwt'))
  ok('status.captcha.reachable 是布尔值', typeof status.captcha.reachable === 'boolean')
  /** 诊断字段：模型没进选择器时，先看这两个。 */
  ok('status.adapterRegistered 为真', status.adapterRegistered === true, String(status.error ?? ''))
  process.stdout.write(
    `  [status] models=${JSON.stringify(status.models)} accounts=${status.accountCount} ` +
    `captcha=${status.captcha.reachable}${status.captcha.reason ? ` (${status.captcha.reason})` : ''}\n`,
  )
}

/**
 * ⚠ 模型元数据契约：`dsh-llm` 的 `normalizeModelInfo` 要求每个 reasoning effort
 * **同时有非空 id 与非空 name**，且 id 不重复 —— 缺任一条就抛
 * `INVALID_MODEL_REASONING`（"invalid or duplicate reasoning effort metadata"），
 * 该模型在宿主里直接不可用。
 */
if (registered[0]?.adapter !== undefined) {
  const listed = await registered[0].adapter.listModels('zcode-start-plan')
  ok('listModels 返回非空目录', listed.length > 0, String(listed.length))
  let effortsValid = true
  let detail = ''
  for (const model of listed) {
    for (const effort of model.reasoning?.efforts ?? []) {
      if (typeof effort.id !== 'string' || effort.id.length === 0
        || typeof effort.name !== 'string' || effort.name.length === 0) {
        effortsValid = false
        detail = `${model.id} → ${JSON.stringify(effort)}`
      }
    }
  }
  ok('reasoning efforts 均有非空 id 与 name', effortsValid, detail)
  ok('adapter 实现 providerRetryPolicy', typeof registered[0].adapter.providerRetryPolicy === 'function')
  /**
   * ⚠ 宿主选模型后**直接**调用 `adapter.prepareCall(provider, model, signal)`；
   * 漏掉它表现为 `registration.adapter.prepareCall is not a function`（选模型即报错）。
   */
  ok('adapter 实现 prepareCall', typeof registered[0].adapter.prepareCall === 'function')
  const prepared = await registered[0].adapter.prepareCall('zcode-start-plan', 'GLM-5.3-Flash')
  ok(
    'prepareCall 返回 model 与 stream 入口',
    prepared?.model?.id === 'GLM-5.3-Flash' && typeof prepared.stream === 'function',
    JSON.stringify(prepared?.model?.id),
  )
}

/** 收尾只走 `apply` 返回的 cleanup（它负责释放 SQLite / 端点 / captcha）。 */
try {
  await cleanup()
  ok('cleanup 不抛错', true)
} catch (error) {
  ok('cleanup 不抛错', false, error instanceof Error ? error.message : String(error))
}
for (const dispose of disposers) {
  try {
    dispose()
  } catch {
    // 收尾不应抛错；下面的检查项只关心「本脚本没有崩」。
  }
}

let failed = 0
for (const check of checks) {
  process.stdout.write(`${check.pass ? '  ok  ' : '  FAIL'}  ${check.name}${check.pass ? '' : `  → ${check.detail}`}\n`)
  if (!check.pass) failed += 1
}
process.stdout.write(
  failed === 0
    ? `\nSMOKE PASS（${checks.length} 项，安装位置：${entryRoot}）\n`
    : `\nSMOKE FAIL（${failed}/${checks.length} 失败，安装位置：${entryRoot}）\n`,
)
process.exit(failed === 0 ? 0 : 1)
