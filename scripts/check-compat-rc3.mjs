// 用宿主自带的 evaluatePluginCompatibility 校验本插件 manifest（rc.2 / rc.3 / 0.3.0）。
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const host = pathToFileURL(process.cwd() + '/.tmp-dsh-extract-full/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js').href
const m = await import(host)
const pkg = JSON.parse(readFileSync(process.cwd() + '/package.json', 'utf8'))
for (const rv of ['0.2.1-rc.2', '0.2.1-rc.3', '0.3.0']) {
  const issue = m.evaluatePluginCompatibility(pkg, {}, rv)
  console.log(rv, '=>', issue === undefined ? 'COMPATIBLE' : JSON.stringify(issue.requirements))
}
