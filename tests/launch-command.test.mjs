/**
 * 「开调试端口」指引文案的契约测试。
 *
 * ## 背景（2026-11-02 报障）
 *
 * 面板 tooltip / status 工具 / 领取失败三处共用 `CaptchaMinter.probe()` 的
 * reason 串，而它原文只写了「请以 --remote-debugging-port 启动 DSH 桌面端」：
 * 没给可复制的一行、没提「必须先退出旧实例」（单实例锁会让参数静默失效）、
 * 也没提 PowerShell 的 `&` 前缀（漏了必报「意外的标记 remote-debugging-port」）。
 *
 * 这些用例锁住三件事：
 * 1. 命令必须是**绝对路径**（插件 cwd 是工作区，相对路径必错）；
 * 2. 命令必须带 `&` 调用运算符（否则 PowerShell 只把它当字符串输出）；
 * 3. 探不到安装位置时返回**占位符**，绝不猜一个会误跑的路径。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { isAbsolute, win32 } from 'node:path'

import { CaptchaMinter, launchCommand } from '../lib/captcha/minter.js'

test('launchCommand: 命中的安装路径必须是绝对路径（插件 cwd 在工作区，相对路径必错）', () => {
  const command = launchCommand(9229)
  const match = /^& "(.+)" --remote-debugging-port=9229$/.exec(command)
  assert.ok(match, `命令形状不对：${command}`)
  const exe = match[1]
  const absolute = isAbsolute(exe) || (process.platform === 'win32' && win32.isAbsolute(exe))
  assert.ok(absolute, `安装路径必须是绝对路径，实际：${exe}`)
  assert.match(exe, /DeepSeek Harness\.exe$/, '必须以宿主 exe 结尾')
})

test('launchCommand: 前缀 & 必须在（漏了 PowerShell 会报「意外的标记 remote-debugging-port」）', () => {
  const command = launchCommand(9229, () => false)
  assert.ok(command.startsWith('& "'), `必须以 & 开头，实际：${command}`)
  assert.match(command, /--remote-debugging-port=9229$/, '端口要跟着参数走，不能是硬编码 9229')
  assert.match(launchCommand(9333, () => false), /--remote-debugging-port=9333$/, '端口要透传')
})

test('launchCommand: 探不到安装位置时给占位符，不猜路径', () => {
  const command = launchCommand(9229, () => false)
  assert.match(command, /<DSH 安装路径>/, '探不到就给占位符，让用户补全')
})

test('launchCommand: exists 抛错也不炸（权限/盘点失败按「未命中」处理）', () => {
  const command = launchCommand(9229, () => {
    throw new Error('EACCES')
  })
  assert.match(command, /<DSH 安装路径>/, '探测失败退化为占位符，不能抛')
})

test('probe 原因串：连不上端口时必须自带可复制的启动命令与「先退出旧实例」', async () => {
  const minter = new CaptchaMinter({
    debugPort: 19999,
    fetchImpl: async () => {
      throw new Error('fetch failed')
    },
  })
  const outcome = await minter.probe()
  assert.equal(outcome.ok, false)
  const reason = outcome.reason
  assert.match(reason, /127\.0\.0\.1:19999/, '要指明探测的是哪个端口')
  assert.match(reason, /--remote-debugging-port=19999/, '要给出带正确端口的可复制命令')
  assert.match(reason, /& "/, 'PowerShell 调用运算符不能省')
  assert.match(reason, /退出/, '必须提示先退出旧实例（单实例锁会吞掉参数）')
  assert.match(reason, /manual/, '要给出不走 CDP 的出口')
  assert.doesNotMatch(reason, /fetch failed/, '不把底层异常原文抛给用户')
})
