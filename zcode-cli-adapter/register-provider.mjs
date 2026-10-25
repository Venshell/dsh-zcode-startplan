#!/usr/bin/env node
/**
 * 把「本端点」登记成 ZCode CLI 的自定义供应商。
 *
 * ## 做什么
 *
 * ZCode CLI 的模型供应商表在 `~/.zcode/v2/config.json` 的 `provider` 字段
 * （schema 见官方 bundle：`kind: anthropic|openai|openai-compatible` +
 * `options.apiKey/baseURL` + `models`，passthrough）。本脚本原子写入一条：
 *
 * ```jsonc
 * {
 *   "provider": {
 *     "custom:dsh-zcode-startplan": {
 *       "kind": "anthropic",
 *       "name": "ZCode Start Plan (dsh adapter)",
 *       "options": { "apiKey": "<token>", "baseURL": "http://127.0.0.1:17899" },
 *       "enabled": true,
 *       "source": "custom",
 *       "models": { "GLM-5.3": {}, "GLM-5.3-Flash": {} }
 *     }
 *   }
 * }
 * ```
 *
 * 会话里选模型时用 `custom:dsh-zcode-startplan/GLM-5.3-Flash`（TUI `/model` 或
 * `-p` 前先 `/model`），或把 `defaultModelSelection` 指过去（--default）。
 *
 * ## 安全边界
 *
 * - **只动 `provider` 表**：读原文件 → 内存合并 → 同目录临时文件 → rename 原子替换；
 *   失败时原文件原地保留，绝不写出半截 JSON。
 * - token 是本地端点的访问令牌（`endpoint-token.txt`），不是上游凭据 —— zcode_jwt
 *   永远不出本进程，也不会被写进 CLI 配置。
 * - 幂等：重复执行只更新同 key 条目；`--remove` 删除并退出。
 *
 * ## 前置
 *
 * 端点在跑：`node zcode-cli-adapter/server.mjs`（先跑它，用 `--status` 拿端口/token）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, copyFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { resolveDataDir } from '../lib/pool.js'
import { resolveEndpointToken, resolvePort } from '../lib/local-endpoint.js'

const args = process.argv.slice(2)
const log = (message) => process.stdout.write(`${message}\n`)
const warn = (message) => process.stderr.write(`${message}\n`)

function option(name, fallback) {
  const exact = args.indexOf(`--${name}`)
  if (exact !== -1 && args[exact + 1] !== undefined) return args[exact + 1]
  const prefixed = args.find((arg) => arg.startsWith(`--${name}=`))
  if (prefixed !== undefined) return prefixed.slice(name.length + 3)
  return fallback
}

const PROVIDER_KEY = option('key', 'custom:dsh-zcode-startplan')
const PROVIDER_NAME = 'ZCode Start Plan (dsh adapter)'

/** 端口与 token 的唯一事实来源：server.mjs 落盘的文件（与 DSH 插件共用 dataDir 约定）。 */
function resolveEndpointFacts(dataDir) {
  const portFile = join(dataDir, 'cli-endpoint-port.txt')
  let port = resolvePort(option('port', 17_899))
  if (existsSync(portFile)) {
    const saved = Number(readFileSync(portFile, 'utf8').trim())
    if (Number.isFinite(saved) && saved > 0) port = saved
  }
  const token = resolveEndpointToken(dataDir, process.env)
  return { port, token, baseUrl: `http://127.0.0.1:${port}` }
}

async function main() {
  const dataDir = option('data-dir', process.env['ZCODE_START_PLAN_DATA_DIR'] ?? resolveDataDir(process.env))
  const home = process.env['USERPROFILE'] ?? process.env['HOME']
  if (typeof home !== 'string' || home.length === 0) {
    warn('✗ 拿不到用户主目录（USERPROFILE/HOME 都为空）。')
    process.exitCode = 1
    return
  }
  const configFile = join(home, '.zcode', 'v2', 'config.json')

  if (args[0] === '--remove') {
    if (!existsSync(configFile)) {
      warn(`✗ 找不到 ${configFile}，没什么可删的。`)
      process.exitCode = 1
      return
    }
    const raw = readFileSync(configFile, 'utf8')
    const config = JSON.parse(raw)
    if (config?.provider?.[PROVIDER_KEY] === undefined) {
      log(`配置里本来就没有 ${PROVIDER_KEY}，无需删除。`)
      return
    }
    delete config.provider[PROVIDER_KEY]
    writeAtomically(configFile, raw, config)
    log(`已从 ${configFile} 移除供应商 ${PROVIDER_KEY}。`)
    return
  }

  if (!existsSync(configFile)) {
    warn(`✗ 找不到 ${configFile} —— ZCode CLI 还没跑过一次（首次启动会生成它）。`)
    process.exitCode = 1
    return
  }
  const raw = readFileSync(configFile, 'utf8')
  let config
  try {
    config = JSON.parse(raw)
  } catch (error) {
    warn(`✗ ${configFile} 不是合法 JSON（${error instanceof Error ? error.message : String(error)}），不动它。`)
    process.exitCode = 1
    return
  }

  const { port, token, baseUrl } = resolveEndpointFacts(dataDir)
  const models = option('models', 'GLM-5.3,GLM-5.3-Flash')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0)

  config.provider = config.provider ?? {}
  const existing = config.provider[PROVIDER_KEY]
  config.provider[PROVIDER_KEY] = {
    ...(existing ?? {}),
    kind: 'anthropic',
    name: PROVIDER_NAME,
    options: {
      ...(existing?.options ?? {}),
      apiKey: token,
      baseURL: baseUrl,
    },
    enabled: true,
    source: 'custom',
    models: Object.fromEntries(models.map((id) => [id, {}])),
  }

  writeAtomically(configFile, raw, config)

  log('✓ 已登记 ZCode CLI 自定义供应商')
  log(`  配置：   ${configFile}`)
  log(`  供应商： ${PROVIDER_KEY}（kind=anthropic → /v1/messages）`)
  log(`  baseURL：${baseUrl}（端口 ${port}）`)
  log(`  模型：   ${models.join(', ')}`)
  log('')
  log('  会话里选用：/model custom:dsh-zcode-startplan/GLM-5.3-Flash')
  log('  或（--default 已写）重启 CLI 后默认走它。')
  if (args[0] === '--default') {
    log('')
    log('  ⚠ --default 尚未实现自动改写 defaultModelSelection；请重启 CLI 后在 /model 里选一次，')
    log('    CLI 会把选择持久化到 provider_config.json。')
  }
  log('')
  log('  ⚠ 端点必须在线：node zcode-cli-adapter/server.mjs（端口与 token 都已持久化，配一次长期有效）。')
}

/** 原子写：同目录临时文件 + rename（失败时原文件原地保留）。 */
function writeAtomically(configFile, originalRaw, nextConfig) {
  const dir = dirname(configFile)
  mkdirSync(dir, { recursive: true })
  const backup = `${configFile}.bak`
  copyFileSync(configFile, backup)
  const tmp = join(dir, `.config.json.${process.pid}.tmp`)
  writeFileSync(tmp, `${JSON.stringify(nextConfig, null, 2)}\n`, { mode: 0o600 })
  try {
    JSON.parse(readFileSync(tmp, 'utf8'))
  } catch (error) {
    try {
      writeFileSync(tmp, '')
    } catch {
      // 尽力清理。
    }
    throw error
  }
  renameSync(tmp, configFile)
  log(`（已留备份：${backup}）`)
}

await main()
