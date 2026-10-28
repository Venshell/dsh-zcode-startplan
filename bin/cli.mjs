#!/usr/bin/env node
/**
 * `zcode-start-plan` 命令行：在没有 DSH 的情况下完成「登录 / 看状态 / 领取 / 探活」。
 *
 * 这些操作**不需要** captcha 载体（除 claim 外）：登录是纯 HTTP 设备授权流，
 * 余额与模型目录是 GET。故 CLI 可以在 Harness 没启动时独立使用。
 *
 * ```powershell
 * node bin/cli.mjs login                     # 设备授权：打印链接 → 浏览器授权 → 自动入池
 * node bin/cli.mjs import "<PATH_TO_ZCODE_JWT>"   # 从文件读 JWT（已有 ZCode 登录时）
 * node bin/cli.mjs list                      # 账号列表（不含凭据）
 * node bin/cli.mjs status                    # 账号 + 余额 + 限流标记
 * node bin/cli.mjs probe --model GLM-5.3-Flash    # 真发一条最小请求，验证全链路
 * node bin/cli.mjs claim                     # 领取当日免费额度（需要 captcha 载体）
 * node bin/cli.mjs captcha                   # 单独产出一次 captcha（诊断用）
 * node bin/cli.mjs disable 1 / enable 1 / remove 1
 * ```
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { AccountPool, SqliteStore, resolveDbFile, resolveDataDir } from '../lib/pool.js'
import { beginZcodeLogin, fetchBalance, fetchCaptchaConfig, fetchClaimablePlans, fetchModels, claimPlan, reportActivation, resolveLoginChannel, LOGIN_CHANNELS } from '../lib/upstream-api.js'
import { CaptchaMinter } from '../lib/captcha/minter.js'
import { ZcodePlanClient } from '../lib/plan-client.js'
import { generateDeviceMid } from '../lib/upstream.js'

const args = process.argv.slice(2)
const command = args[0] ?? 'help'

/** `--flag value` / `--flag=value` 解析。 */
function option(name, fallback) {
  const exact = args.indexOf(`--${name}`)
  if (exact !== -1 && args[exact + 1] !== undefined) return args[exact + 1]
  const prefixed = args.find((arg) => arg.startsWith(`--${name}=`))
  if (prefixed !== undefined) return prefixed.slice(name.length + 3)
  return fallback
}

const log = (message) => process.stdout.write(`${message}\n`)
const warn = (message) => process.stderr.write(`${message}\n`)

/**
 * 退出看门狗（必须在任何命令执行前就位）。
 *
 * ⚠ **只**兜「异常路径上句柄没释放导致进程永不退出」，默认 15 秒。
 * 需要长时间等待的命令（`login` 等人工授权）必须先调 `clearExitWatchdog()` ——
 * 否则看门狗会在授权完成前杀掉进程，表现为
 * `Detected unsettled top-level await` + 退出码 13。
 */
const EXIT_WATCHDOG_MS = 15_000
let exitWatchdog = setTimeout(() => {
  process.exit(process.exitCode ?? 0)
}, EXIT_WATCHDOG_MS)
/** 不要因为看门狗让进程多活 15 秒：它只是兜底，不持有存活权。 */
exitWatchdog.unref()

/** 取消看门狗（长任务用）。 */
function clearExitWatchdog() {
  clearTimeout(exitWatchdog)
  exitWatchdog = undefined
}

/** 打开账号库 + 账号池。 */
async function openPool() {
  const store = await new SqliteStore(resolveDbFile(process.env))
  return { store, pool: new AccountPool({ store, log: warn }) }
}

function maskJwt(jwt) {
  if (typeof jwt !== 'string' || jwt.length < 12) return '***'
  return `${jwt.slice(0, 6)}…${jwt.slice(-4)}（${jwt.length} 字符）`
}

function printAccounts(pool) {
  const entries = pool.list({ withCredentials: true })
  if (entries.length === 0) {
    log('账号池为空。先运行：node bin/cli.mjs login')
    return entries
  }
  entries.forEach((entry, index) => {
    const limits = Object.keys(entry.model_rate_limits ?? {})
    /** 渠道：凭据里记的 login_channel 优先；老凭据没有则显示「未标注」。 */
    const channelId = entry.credential?.login_channel
    const channelLabel = channelId !== undefined && LOGIN_CHANNELS[channelId] !== undefined
      ? LOGIN_CHANNELS[channelId].label
      : '未标注'
    log(
      `[${index + 1}] ${entry.enabled ? '●' : '○'} ${entry.nickname}  id=${entry.id.slice(0, 8)}  ` +
      `渠道=${channelLabel}  ` +
      `jwt=${maskJwt(entry.credential?.zcode_jwt)}  ` +
      `device=${entry.credential?.device_mid?.slice(0, 8) ?? '?'}  ` +
      `${limits.length > 0 ? `限流:${limits.join(',')}` : ''}` +
      `${entry.last_error !== undefined ? `  最近错误:${entry.last_error}` : ''}`,
    )
  })
  return entries
}

async function cmdLogin() {
  const { store, pool } = await openPool()
  /**
   * 登录渠道：`--channel cn|intl`（也认 `bigmodel`/`zai`/`国内`/`国际`）。
   *
   * 两条渠道**协议完全一致**，只是 `provider` 与授权站点不同：
   * 国内 = bigmodel.cn，国际 = chat.z.ai。账号属于哪边就用哪边登录。
   */
  const channel = resolveLoginChannel(option('channel', option('provider', undefined)))
  /**
   * ⚠ 登录必须**取消看门狗**：这个命令的语义就是「一直等到用户在浏览器里点完授权」
   * （默认 10 分钟），而看门狗是给「异常路径挂死句柄」用的。不取消的话，
   * 15 秒后被强制 exit → 顶层 await 悬空 → 打印 unsettled 警告，且授权永远等不到。
   */
  clearExitWatchdog()
  const deadline = Date.now() + 10 * 60_000
  const keepalive = setInterval(() => {
    const left = Math.max(0, Math.round((deadline - Date.now()) / 1000))
    process.stderr.write(`\r等待授权中… 剩余 ${left}s（Ctrl+C 取消）  `)
  }, 5_000)
  try {
    log(`正在向 ZCode 申请设备授权（${channel.label}）…`)
    const { loginUrl, result } = await beginZcodeLogin({ channel: channel.provider })
    log('')
    log(`请在浏览器里打开下面这个链接完成授权（用拥有赠送免费 plan 的【${channel.site}】账号）：`)
    log('')
    log(`  ${loginUrl}`)
    log('')
    log('若链接已过期：重跑本命令，或加 --channel intl 切换到国际站。')
    const credential = await result
    process.stderr.write('\n')
    const { entry, created } = pool.add(credential, option('name', undefined))
    log(`${created ? '已添加' : '已更新'}账号：${entry.nickname}（id=${entry.id.slice(0, 8)}，渠道=${channel.label}）`)
    log(`数据目录：${resolveDataDir(process.env)}`)
  } catch (error) {
    process.stderr.write('\n')
    warn(`✗ 登录失败：${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  } finally {
    clearInterval(keepalive)
    store.close()
  }
}

async function cmdImport() {
  const jwtFile = args[1]
  if (jwtFile === undefined) {
    warn('用法：node bin/cli.mjs import <含 JWT 的文件路径>')
    process.exitCode = 1
    return
  }
  const raw = readFileSync(resolve(jwtFile), 'utf8').trim()
  let jwt = raw
  /** 容忍把整段 JSON 存进文件的情况（官方客户端的凭据结构）。 */
  try {
    const parsed = JSON.parse(raw)
    jwt = parsed.zcode_jwt ?? parsed.token ?? parsed.data?.token ?? raw
  } catch {
    // 纯文本就是 JWT。
  }
  if (typeof jwt !== 'string' || jwt.length < 32) {
    warn('文件里没找到像样的 JWT（期望 ≥32 字符的字符串）。')
    process.exitCode = 1
    return
  }
  const { store, pool } = await openPool()
  try {
    const { entry, created } = pool.add(
      { zcode_jwt: jwt, device_mid: generateDeviceMid(), account_label: option('name', '导入账号'), source: 'ide' },
      option('name', undefined),
    )
    log(`${created ? '已添加' : '已更新'}账号：${entry.nickname}`)
    log('⚠ 导入的账号没有 user_id，无法按账号去重；重复导入会新增条目。')
  } finally {
    store.close()
  }
}

async function cmdList() {
  const { store, pool } = await openPool()
  try {
    printAccounts(pool)
  } finally {
    store.close()
  }
}

async function cmdStatus() {
  const { store, pool } = await openPool()
  try {
    const entries = printAccounts(pool)
    log('')
    for (const entry of entries) {
      try {
        const balance = await fetchBalance(entry.credential)
        if (balance === undefined) {
          log(`· ${entry.nickname}：余额查询失败（凭据可能已过期，重新 login 这个账号）`)
        } else if (balance.enterprise === true) {
          log(`· ${entry.nickname}：企业版（不下发用量数字）`)
        } else {
          log(
            `· ${entry.nickname}：剩余 ${balance.remaining}/${balance.total} ` +
            `${balance.planName !== undefined ? `（${balance.planName}）` : ''}`,
          )
        }
      } catch (error) {
        log(`· ${entry.nickname}：余额查询异常 ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const first = entries[0]
    if (first !== undefined) {
      const models = await fetchModels(first.credential)
      log('')
      log(`上游模型目录${models === undefined ? '（不可达，用兜底表）' : ''}：${(models ?? []).map((model) => model.id).join(', ') || '（空）'}`)
      const config = await fetchCaptchaConfig(first.credential)
      log(`服务端 captcha 配置：${config === undefined ? '（不可达，用兜底值）' : JSON.stringify(config)}`)
    }
    log('')
    log(`数据目录：${resolveDataDir(process.env)}`)
    log(`账号库：${resolveDbFile(process.env)}`)
  } finally {
    store.close()
  }
}

async function cmdProbe() {
  const model = option('model', 'GLM-5.3-Flash')
  const { store, pool } = await openPool()
  const minter = new CaptchaMinter({ debugPort: Number(option('port', '9229')), log: warn })
  try {
    if (pool.list().length === 0) {
      warn('账号池为空。先运行 login。')
      process.exitCode = 1
      return
    }
    const client = new ZcodePlanClient({ pool, minter, log: warn })
    const started = Date.now()
    const result = await client.call({
      options: {
        model,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping（只回复 pong）' }] }],
      },
      maxTokens: 64,
      onRetry: (info) => warn(`重试（${info.reason}）：${info.message}`),
    })
    let text = ''
    for (const event of result.head) {
      const data = event.data
      if (data?.type === 'content_block_delta' && data.delta?.type === 'text_delta') text += data.delta.text
    }
    if (result.head.decoder !== undefined) {
      for (;;) {
        const next = await result.head.decoder.read()
        if (next.done === true) break
        const data = next.value.data
        if (data?.type === 'content_block_delta' && data.delta?.type === 'text_delta') text += data.delta.text
      }
    }
    log(`✓ 全链路通过（账号 ${result.accountId.slice(0, 8)}，${Date.now() - started}ms）`)
    log(`  回复：${text.trim().slice(0, 200) || '（流里没有文本）'}`)
  } catch (error) {
    warn(`✗ 失败（${error?.code ?? 'ERR'}）：${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  } finally {
    minter.dispose()
    store.close()
  }
}

async function cmdCaptcha() {
  const minter = new CaptchaMinter({ debugPort: Number(option('port', '9229')), log: warn })
  try {
    const probe = await minter.probe()
    log(`调试端口：${probe.ok ? '可达' : `不可达（${probe.reason}）`}`)
    if (!probe.ok) {
      process.exitCode = 1
      return
    }
    const { store, pool } = await openPool()
    try {
      const first = pool.list({ withCredentials: true })[0]
      const config = first === undefined ? undefined : await fetchCaptchaConfig(first.credential)
      const started = Date.now()
      const outcome = await minter.mint(config ?? { region: 'cn', prefix: 'no8xfe', sceneId: '11xygtvd' })
      log(`✓ captcha 产出成功（${Date.now() - started}ms，param 长度 ${outcome.param.length}，交互式=${outcome.interactive}）`)
    } finally {
      store.close()
    }
  } catch (error) {
    warn(`✗ ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  } finally {
    minter.dispose()
  }
}

async function cmdClaim() {
  const { store, pool } = await openPool()
  const minter = new CaptchaMinter({ debugPort: Number(option('port', '9229')), log: warn })
  try {
    const entries = pool.list({ withCredentials: true })
    if (entries.length === 0) {
      warn('账号池为空。先运行 login。')
      process.exitCode = 1
      return
    }
    const client = new ZcodePlanClient({ pool, minter, log: warn })
    for (const entry of entries) {
      if (!entry.enabled) continue
      log(`· ${entry.nickname}`)
      await reportActivation(entry.credential)
      const plans = await fetchClaimablePlans(entry.credential)
      if (plans.length === 0) {
        log('  当前没有探测到可领取的活动（官方营销投放可能为空，稍后再试）')
        continue
      }
      for (const plan of plans) {
        /** ⚠ captcha 一次性：每个 plan 必须重新产出。 */
        const captcha = await client.mintCaptcha()
        const outcome = await claimPlan(entry.credential, plan.planId, captcha)
        log(
          `  ${outcome.ok ? '✓' : '✗'} ${plan.name ?? plan.planId}` +
          `${outcome.alreadyClaimed === true ? '（已领过）' : ''}` +
          `${outcome.ok ? '' : ` ${outcome.code ?? outcome.httpStatus ?? ''} ${outcome.message ?? ''}`}`,
        )
      }
      const balance = await fetchBalance(entry.credential)
      if (balance !== undefined && balance.enterprise !== true) {
        log(`  当前剩余：${balance.remaining}/${balance.total}`)
      }
    }
  } catch (error) {
    warn(`✗ ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  } finally {
    minter.dispose()
    store.close()
  }
}

async function cmdAccountAction(action) {
  const reference = args[1]
  if (reference === undefined) {
    warn(`用法：node bin/cli.mjs ${action} <序号|id|昵称片段>`)
    process.exitCode = 1
    return
  }
  const { store, pool } = await openPool()
  try {
    const entry = pool.resolve(reference)
    if (entry === undefined) {
      warn(`找不到账号：${reference}（先运行 list 看序号）`)
      process.exitCode = 1
      return
    }
    if (action === 'disable') pool.setEnabled(entry.id, false)
    else if (action === 'enable') pool.setEnabled(entry.id, true)
    else if (action === 'remove') pool.remove(entry.id)
    else if (action === 'reset') pool.clearModelRateLimits(entry.id)
    log(`已对「${entry.nickname}」执行 ${action}`)
  } finally {
    store.close()
  }
}

function cmdHelp() {
  log(`zcode-start-plan — ZCode 赠送免费 plan 的 DSH 接入

用法（在插件目录下运行）：
  node bin/cli.mjs login [--name 备注] [--channel cn|intl]
                                              设备授权登录并把账号入池
                                                --channel cn   = 智谱国内站 bigmodel.cn（默认）
                                                --channel intl = Z.AI 国际站  z.ai
  node bin/cli.mjs import <文件> [--name 备注] 从含 JWT 的文件导入账号
  node bin/cli.mjs list                       账号列表（脱敏，含来源渠道）
  node bin/cli.mjs status                     账号 + 余额 + 上游模型目录 + captcha 配置
  node bin/cli.mjs probe [--model M]          真发一条最小请求，验证全链路
  node bin/cli.mjs claim                      领取当日额度（需要 captcha 载体）
  node bin/cli.mjs captcha [--port 9229]      单独产出一次 captcha（诊断）
  node bin/cli.mjs enable|disable|remove|reset <序号|id|昵称>

登录渠道（两条渠道协议相同，选择你的账号所属站点）：
  cn   / bigmodel / 国内   智谱  https://bigmodel.cn   （默认）
  intl / zai      / 国际   Z.AI  https://chat.z.ai

环境变量：
  ZCODE_START_PLAN_DATA_DIR   数据目录（默认 ~/.dsh/zcode-start-plan）
  ZCODE_START_PLAN_CDP_PORT   宿主 CDP 端口（默认 9229）

数据文件：
  ${resolveDataDir(process.env)}
    accounts.db  账号库（SQLite，600 权限；含 ZCode JWT）
`)
}

const handlers = {
  login: cmdLogin,
  import: cmdImport,
  list: cmdList,
  status: cmdStatus,
  probe: cmdProbe,
  captcha: cmdCaptcha,
  claim: cmdClaim,
  enable: () => cmdAccountAction('enable'),
  disable: () => cmdAccountAction('disable'),
  remove: () => cmdAccountAction('remove'),
  reset: () => cmdAccountAction('reset'),
  help: cmdHelp,
}

const handler = handlers[command]
if (handler === undefined) {
  warn(`未知命令：${command}`)
  cmdHelp()
  process.exitCode = 1
} else {
  /**
   * ⚠ 只在真的拿到 Promise 时才 `await`：`help` 这类同步处理函数返回 `undefined`，
   * `await undefined` 会让模块顶层 await 悬空，Node 会打印
   * “Detected unsettled top-level await”。同时捕获异常，统一落到 exitCode。
   */
  try {
    const outcome = handler()
    if (outcome !== undefined && typeof outcome.then === 'function') await outcome
  } catch (error) {
    warn(`✗ ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

/**
 * 收尾策略：**不 await、不 process.exit()**。
 *
 * ## 为什么两条都不能用
 *
 * 1. `await` 一个「等 stdio 写空」的 promise —— `stream.write('', cb)` 在 stdout 不是
 *    TTY 时（管道 / 重定向，也就是父进程捕获输出的常见情形）**不会回调**：Node 对空
 *    chunk 直接 return true，根本不排进写入队列。于是 await 永久挂起 → 模块顶层 await
 *    悬空 → 打印 "Detected unsettled top-level await"。
 * 2. `process.exit()` —— 它**立即**退出，而管道写入是异步的，会把还没 flush 的输出
 *    （尤其是 `login` 打印的授权链接）截掉。
 *
 * ## 采用的写法
 *
 * 什么也不做：`process.exitCode` 已经设好，事件循环会在所有句柄（SQLite / fetch /
 * 定时器）释放后**自然退出**，退出码由 exitCode 决定，stdout 也会在退出前正常排空。
 *
 * 只兜一个病态：真挂了不释放的句柄时进程永不退出。看门狗定义在文件顶部（见
 * `EXIT_WATCHDOG_MS`）；需要长时间等待的命令（`login`）会先取消它。
 */

