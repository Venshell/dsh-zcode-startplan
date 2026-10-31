# DSH 宿主契约

这一节的每一条都会让插件「看起来加载了、其实不工作」。**改动本插件前先读完。**
README 只留清单，本文记录症状、诊断过程与逐字依据。

## `ctx` 是沙箱 façade：用到的服务必须 `inject` 声明

宿主的 `ctx` **只挂 `inject` 声明过的服务**。实测（一次性诊断插件）：

```js
Object.keys(ctx)            → ['fiber']      ← 只有 fiber
ctx.llm                     → object        ← 我 inject 了它，可用
ctx.tools                   → 抛错 "cannot get property "tools" without inject"
```

**漏声明的症状**：插件在插件列表里可见、Config 状态是 `schema`（那只是 manifest 元数据，
不需要执行模块），但**工具与模型全都没有**；宿主只往 stderr 打一条 warning，
打包态下 stderr 被丢弃 —— 所以什么都看不到。

⇒ 本插件 `inject = ['llm', 'tools', 'timer']`（三个硬依赖，一个都不多）；
`webServer` 走**可选注入**（见下文「账号面板路由」——写进硬 inject 会在
headless profile 挂起整个 fiber，0.4.4 的教训）。

## 宿主对适配器有**三处不带可选调用保护**的直接调用

| 方法 | 何时被调用 | 漏掉的后果 |
|---|---|---|
| `providerRetryPolicy(provider)` | `registerAdapter` 时（`prepareRoutes`） | `adapter.providerRetryPolicy is not a function` → **路由不注册** |
| `prepareCall(provider, model, signal)` | 选模型后 | `registration.adapter.prepareCall is not a function` → **选模型即报错** |
| `resolveModel(provider, model)` | 校验模型时 | 同上 |

基类 `LlmAdapter` 提供了 `prepareCall` 的默认实现，但本插件**没有 extends 基类**
（避免与宿主版本耦合），所以三个都要自己补。

## chunk 形状必须匹配 `BlockAssembler`

宿主 `dsh-llm/lib/index.js` 的 `BlockAssembler` 逐字如下：

```js
case "block-start":     partials.set(index, { blockType: chunk.blockType, text: "", toolCallArguments: "" })
case "text-delta":
case "reasoning-delta": partial.text += chunk.text
case "tool-call-delta": toolCallId = chunk.id; toolCallName = chunk.name; toolCallArguments += chunk.argumentsDelta
case "block-end":       partial.block = chunk.block
```

即：

- `block-start` 用 **`blockType`（字符串）**，**不是** `block`（对象）
- `block-end` **必须带完整 `block`**（`assemble()` 直接返回它）
- `tool-call-delta` 的字段名是 `id` / `name` / **`argumentsDelta`**
- `finish` 的 kind 必须包在 **`reason` 对象**里：
  `{ type: 'finish', reason: { kind: 'stop' } | { kind: 'error', failure } | … }`
  （`FinishReasonMap`，rc.3 的 `.d.ts` 钉死）。宿主读 `chunk.reason`，
  kind 放顶层时**不炸但静默出错** —— 流内错误被吞成「正常结束」。

形状不对的症状：宿主 `chunk.block.type` 解引用 `undefined` →
`Cannot read properties of undefined (reading 'type')`。
**只有思考型模型（先出 reasoning 块）才会立刻暴露** —— 非思考模型晚一步才炸。

⇒ `tests/assembler-contract.test.mjs` **逐字复刻**宿主 assembler 做契约级测试。

## 模型元数据校验

- 每个 reasoning effort 必须**同时有非空 `id` 与非空 `name`**，且 `id` 不重复
  → 否则 `INVALID_MODEL_REASONING`（"invalid or duplicate reasoning effort metadata"）
- `defaultEffort` 必须是已声明过的 effort 之一
- `listModels` 必须返回**非空**目录，否则宿主要求"catalog membership"的入口
  （模型选择器）看不到这个 provider

## Config 必须是**原生 schemastery** schema

宿主用 `isNativeConfigSchema(config)` 判定：`Symbol.for('schemastery') === true`
+ string `type` + object `meta`。不满足就是 `status: 'unsupported'` →
设置页不可编辑、**provider 进不了模型选择器**。

⚠ **但不要 `import '@deepseek-ai/schemastery'`**：`plugin_manager` 用**软链**安装
（`link:`），插件实际运行在源码目录，那里解析不到 profile 的 `node_modules` ——
顶层静态 import 会 `ERR_MODULE_NOT_FOUND`，**把宿主 host 进程掀翻**
（实测：`Error: dsh desktop host exited with 1`）。

⇒ 本插件**零运行时依赖**，自带一个最小 schemastery 兼容对象
（`index.js` 的 `makeConfigSchema`），并附带 Standard Schema 兼容层。

## 工具输出必须是**无损 JSON**

宿主把 `JSON.parse(text)` 与原值深比较：

- `JSON.stringify(value, null, 2)`（带缩进）→ `value is not lossless JSON`
- 值里有 `undefined` → 该键被 stringify 静默丢弃 → round-trip 后键消失 → 同样被拒

⇒ 紧凑序列化 + 缺省值一律用 `null`（不是 `undefined`）。

## Web UI（Client 半段）的两个硬契约

- `package.json` 必须有 `exports["./client"]` + `files` 白名单含 `client.js` +
  `dsh.client` 段（`platform` / `immediately` / `inject`），缺一样宿主就不把
  Client 半段下发给 Web GUI；client 工厂返回值要 `inject: ['slots']`
- 面板挂 `plugins.bundle.config` 座位：宿主**按包名 key 派发**（`key` 必须与
  安装的包名一字不差），列表页则以 `view === 'summary'` 请求一行简介

## 账号面板路由：`webServer` 只能用**可选注入**

`/api/zcode-start-plan/*` 这些路由要挂到宿主的 `webServer` 服务上，而它是**可选**服务：

```js
// ✅ index.js：服务出现才回调，消失则回调里的 effect 自动撤销
ctx.inject(['webServer'], (webCtx) => assembled.registerManageRoutes(webCtx))
```

| 错误写法 | 症状 |
|---|---|
| `export const inject = [..., 'webServer']` | headless profile 无该服务 → **整个插件 fiber 挂起**，模型全没了 |
| 从 facade 探测 `ctx.webServer` | 宿主只挂**声明过的**服务 → 永远 `undefined` → 路由静默不注册，**面板永远 404** |

⚠ 宿主的 `/api` 是 **prefix 路由**且带认证：路由没注册时，请求会被认证层接走
（浏览器有 cookie 时返回 `not found` 404，无 cookie 时 401 `unauthorized`），
看起来像「端点不对」或「认证问题」。排障先看日志里有没有
`管理路由已注册：12 条（/api/zcode-start-plan/*）`；没有就是没挂上。

## 面板是浏览器 bundle

只能做**结构级**断言（`tests/client-panel.test.mjs`
用最小 `createElement` 桩真渲染组件树）；纯视觉问题（布局、配色）仍需人眼确认。
React hooks 有顺序约束：**所有 hooks 必须在任何早退之前调用** ——
0.5.0 曾把 `useCallback` 放在 `return null` 之后，两次渲染 hook 数不一致 →
React 抛 `Rendered fewer hooks than expected` → 整个面板白屏。
