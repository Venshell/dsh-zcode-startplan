// 用宿主自带的 evaluatePluginCompatibility 校验本插件 manifest（覆盖 0.2.x 整条发布线）。
// 覆盖 alpha / rc / 正式版与下一个元组的预发布版，正是 peer 区间最容易漏掉的那几档。
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const host = pathToFileURL(process.cwd() + '/.tmp-dsh-extract-full/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js').href
const m = await import(host)
const pkg = JSON.parse(readFileSync(process.cwd() + '/package.json', 'utf8'))
for (const rv of [
  '0.2.1-rc.2',
  '0.2.1-rc.3',
  '0.2.1-rc.4',
  '0.2.1',
  '0.2.2-alpha.2',
  '0.2.2',
  '0.1.7-rc.2',
  '0.3.0',
]) {
  const issue = m.evaluatePluginCompatibility(pkg, {}, rv)
  console.log(rv, '=>', issue === undefined ? 'COMPATIBLE' : JSON.stringify(issue.requirements))
}
