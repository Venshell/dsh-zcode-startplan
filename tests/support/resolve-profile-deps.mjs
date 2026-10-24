/**
 * 让源码目录里的测试也能解析到宿主依赖（`@deepseek-ai/schemastery`）。
 *
 * ## 为什么需要
 *
 * 插件在**安装位置**运行：`~/.dsh/profiles/desktop/node_modules/dsh-zcode-startplan`，
 * 于是 Node 从那里向上查找 `node_modules` 能命中 profile 的依赖。
 * 但在**源码目录**跑测试时，`import '@deepseek-ai/schemastery'` 无处可寻 ——
 * 这不是插件的 bug，而是测试不在真实运行位置。
 *
 * 本文件用 `module.registerHooks`（Node ≥22.15）把裸包说明符重定向到 profile 的
 * `node_modules`。只对**未被正常解析**的 `@deepseek-ai/*` 生效，其余解析完全不变。
 *
 * 用法（由 `scripts/run-tests.mjs` 以 `--import` 预加载）：
 * ```powershell
 * node --import ./tests/support/resolve-profile-deps.mjs scripts/run-tests.mjs
 * ```
 */

import { registerHooks } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const profileModules = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'profiles', 'desktop', 'node_modules')

/** 只接管 `@deepseek-ai/*` 裸说明符（相对路径与 node: 内置模块一律放行）。 */
function isHostBareSpecifier(specifier) {
  return typeof specifier === 'string' && specifier.startsWith('@deepseek-ai/')
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (!isHostBareSpecifier(specifier)) throw error
      /** 兜底：按 profile 的 node_modules 目录 + package.json exports 解析入口。 */
      const dir = join(profileModules, ...specifier.split('/'))
      const manifestPath = join(dir, 'package.json')
      if (!existsSync(manifestPath)) throw error
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      const entry = typeof manifest.exports === 'string'
        ? manifest.exports
        : manifest.exports?.import ?? manifest.exports?.['.']?.import ?? manifest.main ?? 'index.js'
      return { url: pathToFileURL(join(dir, entry)).href, shortCircuit: true }
    }
  },
})

/** 本文件只为副作用（注册钩子）。 */
export {}
