#!/usr/bin/env node
/**
 * 独立 Anthropic 端点：把本项目的账号池/切号/captcha 全套能力以
 * 「Anthropic Messages 兼容 HTTP 服务」的形态提供给 **ZCode CLI** 用。
 *
 * ## 原理（与 README「回落路线」同源，但不需要 DSH 在跑）
 *
 * ```
 * ZCode CLI（自定义供应商，kind: anthropic）
 *    │  baseURL = http://127.0.0.1:<port> · apiKey = <持久化 token>
 *    ▼
 * 本脚本（复用 lib/local-endpoint.js 的 /v1/messages 实现）
 *    └─ ZcodePlanClient：选号 → 身份块/日期块 → 按需 captcha → 直发上游 → 切号/重试
 *    ▼
 * zcode.z.ai/api/v1/zcode-plan/anthropic
 * ```
 *
 * 端口与 token 都**持久化**（token 落 `<dataDir>\endpoint-token.txt`）：ZCode CLI 里
 * 配好的 baseURL / apiKey 指向它们，变了配置就失效 —— 见 lib/local-endpoint.js 头注。
 *
 * ## 用法
 *
 * ```powershell
 * node zcode-cli-adapter/server.mjs                 # 前台跑（Ctrl+C 停）
 * node zcode-cli-adapter/server.mjs --status        # 看端口/token/账号数（不占端口时也能看）
 * ```
 *
 * 环境变量：`ZCODE_START_PLAN_DATA_DIR`（账号库位置，默认 ~/.dsh/zcode-start-plan，
 * 与 DSH 插件共用同一份账号池）、`ZCODE_START_PLAN_CDP_PORT`（captcha 用的宿主调试端口，默认 9229）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SqliteStore, AccountPool, resolveDbFile, resolveDataDir } from '../lib/pool.js'
import { CaptchaMinter } from '../lib/captcha/minter.js'
import { ZcodePlanClient } from '../lib/plan-client.js'
import { startLocalEndpoint, resolveEndpointToken, resolvePort } from '../lib/local-endpoint.js'
import { fetchCaptchaConfig, fetchModels } from '../lib/upstream-api.js'
import { ZCODE_FALLBACK_MODELS } from '../lib/upstream.js'

const here = fileURLToPath(new URL('.', import.meta.url))
const root = resolve(here, '..')

const args = process.argv.slice(2)
const log = (message) => process.stdout.write(`${message}\n`)
const warn = (message) => process.stderr.write(`${message}\n`)

/** `--flag value` / `--flag=value` 解析（与 bin/cli.mjs 同款）。 */
function option(name, fallback) {
  const exact = args.indexOf(`--${name}`)
  if (exact !== -1 && args[exact + 1] !== undefined) return args[exact + 1]
  const prefixed = args.find((arg) => arg.startsWith(`--${name}=`))
  if (prefixed !== undefined) return prefixed.slice(name.length + 3)
  return fallback
}

/** 数据目录：默认与 DSH 插件共用（同一份账号池），可用环境变量/参数指到别处。 */
const dataDir = option('data-dir', process.env['ZCODE_START_PLAN_DATA_DIR'] ?? resolveDataDir(process.env))
const dbFile = resolveDbFile(process.env, dataDir)
const models = option('models', 'GLM-5.3,GLM-5.3-Flash')
  .split(',')
  .map((id) => id.trim())
  .filter((id) => id.length > 0)

/** `--status`：打印端口/token/账号概况后退出（不监听端口）。 */
if (args[0] === '--status') {
  const token = resolveEndpointToken(dataDir, process.env)
  let accountCount = '?'
  let endpointPort = '?'
  if (existsSync(dbFile)) {
    const store = await new SqliteStore(dbFile)
    try {
      accountCount = String(store.list().length)
    } finally {
      store.close()
    }
  } else {
    accountCount = '0（账号库不存在，先 login 或 import）'
  }
  const portFile = resolve(dataDir, 'cli-endpoint-port.txt')
  if (existsSync(portFile)) endpointPort = readFileSync(portFile, 'utf8').trim()
  log(`数据目录：${dataDir}`)
  log(`账号库：${dbFile}（${accountCount} 个账号）`)
  log(`端点：http://127.0.0.1:${endpointPort}（配置端口 ${resolvePort(option('port', undefined))}）`)
  log(`token：${token.slice(0, 6)}…${token.slice(-4)}（完整值在 ${resolve(dataDir, 'endpoint-token.txt')}）`)
  process.exit(0)
}

/**
 * 退出看门狗：只保护「初始化阶段」异常挂死（账号库打不开 / 端口监听悬空）。
 * ⚠ 端点就绪后必须 `clearInterval` 取消 —— 它已 unref（不阻止事件循环空转），
 * 但回调仍会 fire：15 秒一到就会把活着的端点整个杀掉（冒烟实测踩过）。
 */
const EXIT_WATCHDOG_MS = 15_000
const exitWatchdog = setTimeout(() => {
  process.exit(process.exitCode ?? 0)
}, EXIT_WATCHDOG_MS)
exitWatchdog.unref()

async function main() {
  const store = await new SqliteStore(dbFile)
  if (store.inMemory === true) {
    warn(
      `⚠ 账号库落盘失败，已降级内存库（原因：${store.mkdirError?.message ?? '未知'}）。` +
      '本次运行内可用，重启后账号消失。',
    )
  }
  const pool = new AccountPool({ store, log: warn })
  pool.sweepExpired()

  const minter = new CaptchaMinter({
    debugPort: Number(option('cdp-port', process.env['ZCODE_START_PLAN_CDP_PORT'] ?? 9229)),
    log: warn,
  })
  /** plan 客户端经这个钩子拉服务端 captcha 配置（60s TTL 在客户端内）。 */
  minter.fetchConfig = (credential) => fetchCaptchaConfig(credential)

  const client = new ZcodePlanClient({ pool, minter, log: warn })

  /** 模型目录：拉上游一次，失败回退兜底表（assemble.js 同款逻辑，10 分钟缓存）。 */
  let modelsCache = { at: 0, value: undefined }
  const loadModels = async () => {
    if (modelsCache.value !== undefined && Date.now() - modelsCache.at < 600_000) return modelsCache.value
    const fallback = models.map((id) => {
      const known = ZCODE_FALLBACK_MODELS.find((model) => model.id === id)
      return known ?? { id, name: id, contextWindow: 1_000_000, maxTokens: 32_768, supportsImage: true }
    })
    try {
      const first = pool.list({ withCredentials: true })[0]
      if (first?.credential !== undefined) {
        const remote = await fetchModels(first.credential)
        if (remote !== undefined && remote.length > 0) {
          const known = new Set(models)
          const picked = remote.filter((model) => known.size === 0 || known.has(model.id))
          modelsCache = { at: Date.now(), value: picked.length > 0 ? picked : fallback }
          return modelsCache.value
        }
      }
    } catch (error) {
      warn(`拉取模型目录失败（用兜底表）：${error instanceof Error ? error.message : String(error)}`)
    }
    modelsCache = { at: Date.now(), value: fallback }
    return fallback
  }

  const endpoint = await startLocalEndpoint({
    port: resolvePort(option('port', 17_899)),
    token: resolveEndpointToken(dataDir, process.env),
    planClient: client,
    models: loadModels,
    log,
  })

  /** 端口落盘，供 --status 与 register-provider.mjs 读取（token 由 resolveEndpointToken 自己落）。 */
  try {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(resolve(dataDir, 'cli-endpoint-port.txt'), String(endpoint.port), { mode: 0o600 })
  } catch {
    // 落盘失败不阻塞。
  }

  const entryCount = pool.list().length
  clearTimeout(exitWatchdog)
  log('')
  log('✓ ZCode CLI 适配端点已就绪')
  log(`  地址：  ${endpoint.baseUrl}`)
  log(`  token： ${endpoint.token.slice(0, 6)}…${endpoint.token.slice(-4)}（完整值 ${resolve(dataDir, 'endpoint-token.txt')}）`)
  log(`  账号：  ${entryCount} 个（${dbFile}）`)
  if (entryCount === 0) {
    log('')
    log('  ⚠ 账号池为空。任选其一：')
    log('    node bin/cli.mjs login                                # 设备授权登录（推荐）')
    log(`    node zcode-cli-adapter/import-zcode-credential.mjs    # 导入 ZCode CLI 已登录的凭据`)
  }
  log('')
  log('  下一步（登记 ZCode CLI 自定义供应商）：')
  log('    node zcode-cli-adapter/register-provider.mjs')
  log('')
  log('  Ctrl+C 停止。')

  const shutdown = async () => {
    try {
      await endpoint.close()
    } catch {
      // 已关闭。
    }
    minter.dispose()
    store.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}

await main()
