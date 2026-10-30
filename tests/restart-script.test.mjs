/**
 * `scripts/restart-dsh.ps1` 的**安全契约**测试。
 *
 * ## 背景（0.6.6）
 *
 * 旧版脚本做「杀宿主 → 等退出 → 拉起」，并叠加了计划任务、隐藏窗口、
 * 临时 .cmd、`-ExecutionPolicy Bypass` —— 这组特征与恶意软件高度重合，
 * **被火绒等 AV 拦截是正确行为**（用户实际遇到报毒）。新版只输出
 * 「用户可手动执行的重启命令」，不再有任何高危动作。
 *
 * 这些用例锁住「无害」契约，防止将来有人把杀进程/计划任务加回来：
 * 每一条都对应一个真实的误判特征。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SCRIPT = new URL('../scripts/restart-dsh.ps1', import.meta.url)
const text = () => readFileSync(SCRIPT, 'utf8')
const bytes = () => readFileSync(SCRIPT)

test('restart-dsh.ps1: 文件带 UTF-8 BOM（否则 PowerShell 5.1 按 GBK 解码而解析失败）', () => {
  const b = bytes()
  assert.deepEqual(
    [b[0], b[1], b[2]],
    [0xef, 0xbb, 0xbf],
    '缺 UTF-8 BOM：powershell.exe (5.1) 会把中文注释按 GBK 解码，导致整份脚本解析失败',
  )
})

test('restart-dsh.ps1: 不结束任何进程（安全契约：杀进程是 AV 判毒的首要特征）', () => {
  const t = text()
  assert.doesNotMatch(t, /Stop-Process/, '不许 Stop-Process')
  assert.doesNotMatch(t, /taskkill/i, '不许 taskkill')
  assert.doesNotMatch(t, /\.Kill\(\)/, '不许 Process.Kill()')
})

test('restart-dsh.ps1: 不建计划任务、不隐藏窗口、不混淆（安全契约：持久化特征）', () => {
  const t = text()
  assert.doesNotMatch(t, /schtasks/i, '计划任务是 AV 最敏感的持久化特征')
  assert.doesNotMatch(t, /Register-ScheduledTask/i, '同上')
  assert.doesNotMatch(t, /-EncodedCommand/i, '编码命令是典型混淆手法')
  assert.doesNotMatch(t, /-WindowStyle\s+Hidden/i, '隐藏窗口是典型恶意特征')
})

test('restart-dsh.ps1: 只输出指引，不执行重启（普通重启不依赖调试模式）', () => {
  const t = text()
  assert.match(t, /--remote-debugging-port=/, '要给出带端口的启动命令')
  /** 普通重启 = 不带端口的命令也要能生成（DebugPort <= 0 分支）。 */
  assert.match(t, /\$DebugPort\s+-gt\s+0/, 'DebugPort <= 0 = 普通重启指引')
  assert.match(t, /手动/, '明确告知由用户手动执行')
})
