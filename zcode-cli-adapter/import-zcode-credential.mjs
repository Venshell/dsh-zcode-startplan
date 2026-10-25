#!/usr/bin/env node
/**
 * 把 ZCode CLI 已登录的凭据导入本项目账号池（免重新走设备授权）。
 *
 * ## 凭据从哪来
 *
 * ZCode CLI 的共享登录态在 `~/.zcode/v2/credentials.json`；`builtin:zai-start-plan`
 * 这类 start-plan provider 的 `options.apiKey` 也是同一个 zcode_jwt（见
 * `~/.zcode/v2/config.json`）。本脚本按以下顺序找第一个可用的 JWT：
 *
 * 1. `--jwt-file <路径>`：显式给一个含 JWT 的文件（bin/cli.mjs import 同款解析）；
 * 2. `~/.zcode/v2/credentials.json` 里能翻出的 zcode_jwt；
 * 3. `~/.zcode/v2/config.json` 里 `provider.*.options.apiKey` 形如 JWT 的值。
 *
 * 找到后走 `pool.add()` 入池（与 login 同一条路，user_id 去重）；device_mid 现场
 * 生成 —— 上游按「设备 + JWT」识别，独立 device_mid 与 CLI 的并发请求互不干扰。
 *
 * ⚠ 建议同一账号只在一边用（CLI 原生通道或本端点），避免双倍消耗同一份额度。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { SqliteStore, AccountPool, resolveDbFile, resolveDataDir } from '../lib/pool.js'
import { generateDeviceMid } from '../lib/upstream.js'

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

const JWT_MIN_LENGTH = 32
const looksLikeJwt = (value) => typeof value === 'string' && value.length >= JWT_MIN_LENGTH && value.includes('.')

/** 从一个 JSON 结构里递归翻出所有像 JWT 的字符串（带出处路径，供人工挑选）。 */
function collectJwtCandidates(value, path = '$', out = []) {
  if (typeof value === 'string') {
    if (looksLikeJwt(value)) out.push({ path, jwt: value })
    return out
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectJwtCandidates(item, `${path}[${index}]`, out))
    return out
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) collectJwtCandidates(item, `${path}.${key}`, out)
  }
  return out
}

function readJwtFromFile(file) {
  const raw = readFileSync(resolve(file), 'utf8').trim()
  try {
    const parsed = JSON.parse(raw)
    const candidates = collectJwtCandidates(parsed).filter((item) =>
      /jwt|token|credential|zcode/i.test(item.path),
    )
    if (candidates.length > 0) return candidates[0].jwt
  } catch {
    // 纯文本就是 JWT。
  }
  return looksLikeJwt(raw) ? raw : undefined
}

function findCliCredentials(home) {
  const found = []
  const credentialsFile = join(home, '.zcode', 'v2', 'credentials.json')
  if (existsSync(credentialsFile)) {
    try {
      const parsed = JSON.parse(readFileSync(credentialsFile, 'utf8'))
      for (const item of collectJwtCandidates(parsed, 'credentials.json')) {
        found.push({ ...item, source: credentialsFile })
      }
    } catch (error) {
      warn(`⚠ ${credentialsFile} 解析失败（跳过）：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const configFile = join(home, '.zcode', 'v2', 'config.json')
  if (existsSync(configFile)) {
    try {
      const parsed = JSON.parse(readFileSync(configFile, 'utf8'))
      const providers = parsed?.provider ?? {}
      for (const [providerId, provider] of Object.entries(providers)) {
        const apiKey = provider?.options?.apiKey
        if (!looksLikeJwt(apiKey)) continue
        found.push({ path: `config.json.provider.${providerId}.options.apiKey`, jwt: apiKey, source: configFile })
      }
    } catch (error) {
      warn(`⚠ ${configFile} 解析失败（跳过）：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return found
}

async function main() {
  const dataDir = option('data-dir', process.env['ZCODE_START_PLAN_DATA_DIR'] ?? resolveDataDir(process.env))
  const dbFile = resolveDbFile(process.env, dataDir)
  const home = process.env['USERPROFILE'] ?? process.env['HOME']
  if (typeof home !== 'string' || home.length === 0) {
    warn('✗ 拿不到用户主目录（USERPROFILE/HOME 都为空）。')
    process.exitCode = 1
    return
  }

  const jwtFile = option('jwt-file', undefined)
  let credential
  if (jwtFile !== undefined) {
    const jwt = readJwtFromFile(jwtFile)
    if (jwt === undefined) {
      warn(`✗ 文件里没找到像样的 JWT（期望 ≥${JWT_MIN_LENGTH} 字符且含点号）：${jwtFile}`)
      process.exitCode = 1
      return
    }
    credential = { jwt, origin: `文件 ${jwtFile}` }
  } else {
    const candidates = findCliCredentials(home)
    const deduped = [...new Map(candidates.map((item) => [item.jwt, item])).values()]
    if (deduped.length === 0) {
      warn('✗ 没在 ZCode CLI 数据里找到可用 JWT。两个出路：')
      warn('  ① 先在 ZCode CLI 里完成登录（zcode login 或 TUI /login），再重跑本脚本；')
      warn('  ② 直接设备授权：node bin/cli.mjs login')
      process.exitCode = 1
      return
    }
    if (deduped.length > 1) {
      log('找到多个 JWT 候选：')
      deduped.forEach((item, index) => log(`  [${index + 1}] ${item.path}（${item.jwt.length} 字符）`))
      log('（自动选用第一个；可用 --jwt-file 显式指定）')
    } else {
      log(`找到 JWT：${deduped[0].path}`)
    }
    credential = { jwt: deduped[0].jwt, origin: deduped[0].path }
  }

  const store = await new SqliteStore(dbFile)
  try {
    const pool = new AccountPool({ store, log: warn })
    const { entry, created } = pool.add(
      {
        zcode_jwt: credential.jwt,
        device_mid: generateDeviceMid(),
        account_label: option('name', 'ZCode CLI 导入'),
        source: 'ide',
      },
      option('name', undefined),
    )
    log(`${created ? '已添加' : '已更新'}账号：${entry.nickname}（id=${entry.id.slice(0, 8)}）`)
    log(`来源：${credential.origin}`)
    log(`账号库：${dbFile}`)
    if (!created) log('（按 user_id 去重：这是已有账号，仅凭据被刷新）')
    log('')
    log('下一步：启动端点 node zcode-cli-adapter/server.mjs，然后登记供应商：')
    log('  node zcode-cli-adapter/register-provider.mjs')
  } finally {
    store.close()
  }
}

await main()
