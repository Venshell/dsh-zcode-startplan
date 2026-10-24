# Changelog

本文件记录**每次修复背后的宿主契约**。只看 diff 看不出「为什么不能改回去」，
所以把约束与症状一起写下来。

## 2026-10-24 — 工具调用参数保真

- 历史回放中，DSH 保存的工具参数是原始 JSON 字符串；发给 Anthropic Messages 上游前必须转成 `tool_use.input` 对象。
- 流式 `tool_use` 的 `content_block_start.input` 可以直接携带完整参数；没有后续 JSON 增量时必须保留它，有增量时以增量为准。
- 定向回归测试覆盖上述两种形态。长会话中的实际效果仍需在 DSH 运行时验收。

## 0.2.0 — 账号池管理面板

在 Web UI 的官方插件详情页提供账号池的可视化管理：账号列表（渠道/状态/限流/最近错误）、
余额条、**使用中账号选择**、删除，以及面板内双渠道登录（bigmodel / z.ai）。

### Host 侧（`lib/manage-routes.js`，经 `lib/assemble.js` ④ 接线）

- 照抄 `@linxin666/dsh-client-ui-plugin-manager` 的实证宿主契约：
  `inject: ['webServer']` + `ctx.webServer.register({ kind: 'exact', path, handler })`；
- loopback 栅栏（socket 地址 + Host 头都校验）。**不用** `node:net.isLoopbackAddress`——
  Node 22 没有该导出，静态 import 加载即崩；用 `isIP` 本地实现；
- **安全边界：任何响应不含凭据**（zcode_jwt / device_mid 不出网关），
  仅暴露脱敏视图（id / 昵称 / 渠道 / user_id 尾 6 位 / 限流标记 / 最近错误）；
- 端点：`/summary`（全量+逐账号余额）、`/balance?id=`（单账号）、
  `/set-enabled`、`/remove`、`/reset-limits`、`/reorder`、`/rename`、`/use`、
  `/login/start`、`/login/poll`（均 POST JSON，`/balance` 除外）；
- `/use` = 把账号置顶 —— 池子的既有约定是**手动顺序即选号优先级**（`pick()` 取第一个
  启用且未限流的账号），置顶即「下次请求用它」，复用 `/reorder` 的集合校验；
- 登录流：两段式设备授权（与 CLI 同一对底层函数），**`flowSecret` 只留在 Host 内存**
  （每流 10 分钟 TTL、Map 上限 8 条）；授权 URL 只接受 https；ready 时凭据组装
  与 `beginZcodeLogin` 逐字段一致，凭据不出网关；
- `AccountPool.patchAccount(id, {nickname})`：白名单只放行 `nickname`
  （`lib/pool.js`），凭据不可经此路改。

### Client 侧（`client.js`）

- `window.__ModuleLoader__.load({ id, factory })` + `require('react')`（宿主模块表）；
- 挂官方插件详情页的 `plugins.detail.section` 座位，subject 不指向本插件时返回 null
  （hooks 全部先于早退调用，顺序约束不破）；
- 样式只用宿主主题 token（`--dsw-alias-*`），组件局部 `<style>` 注入、卸载即移除；
- 头部只有一个「刷新」：`/summary` 已带每账号余额，缺失项自动逐个补拉；
- 账号卡片只有两个按钮：**使用**（置顶，使用中显示「使用中」并禁用 + 卡片描边）
  与**删除**（二次确认）；
- 「添加账号」：渠道下拉（智谱国内 bigmodel.cn / Z.AI 国际 z.ai）→ 发起登录 →
  面板内渲染授权链接（可复制，不用 `window.open` 免弹窗拦截）→ 自动轮询入池。

### 安装契约（这次「面板不渲染」的两个根因，防止重蹈）

- `package.json` 必须有 `exports["./client"]` + `files` 白名单含 `client.js` +
  `dsh.client` 段（`platform` / `immediately` / `inject: ['@deepseek-ai/dsh-client-ui-renderer']`）
  —— 缺一样宿主就不把 Client 半段下发给 Web GUI；
- client 工厂返回值要 `inject: ['slots']`，否则 `ctx.slots` 不存在；
- 本插件的安装目录（`~/.dsh/plugins/<name>`）是**实体拷贝**而非 `link:`——
  改完源码必须 robocopy 同步过去，否则宿主看到的永远是旧代码。

### 测试

80 个用例全过（含 webServer 假 ctx 的端到端接线）；
`scripts/smoke-install.mjs` 对安装位置 26 项检查 PASS；
面板渲染与操作已在真实 Web UI 验收。

## 0.1.0 — 首次可用

### 协议层（移植自 bonus-plan-4-open-zcode）

- 官方身份块（cliPrefix + stable 段）逐字复刻 —— 缺它上游返回 `3012`（**有账号冷却惩罚**）
- 首轮 user 消息插入 `<system-reminder>` 日期块（幂等）
- tools 缓存断点只打在**最后一个** tool 上（Anthropic 单请求最多 4 个断点）
- captcha「要了才取」：先不带 → 被 `3007` 拒才产出 → 2 分钟内记住 → 成功后清记忆
- 错误表：`3009` 退避重试不换号 / `3007` 换新 captcha / `3012` **绝不重试** /
  `1005`·`1113` 标号换号 / `401`·`1002` 不重试
- 上游把业务错误塞在 **HTTP 200** 里（`{"code":1005,…}`）—— 必须先识别再判定内容
- 非流式 JSON 与 SSE **分流**判定内容（用 SSE 特征串扫 JSON 会误判为空 → 误伤账号）
- 设备授权流：`oauth/cli/init` + `poll/{id}`；`expires_at` 是**秒级**需归一
- 两条登录渠道：`bigmodel`（国内 `bigmodel.cn`）/ `zai`（国际 `z.ai`），协议相同
- 领取前补 `app_launch` + `app_daily_active`（不补则 `preview` 恒为空）

### DSH 宿主契约（每一处都是「加载了却不工作」的根因）

| 契约 | 症状 |
|---|---|
| `inject` 必须写全用到的服务（`llm` / `tools` / `timer`） | 插件在列表里可见、Config 是 `schema`，但工具与模型全都没有；宿主只往 stderr 打 warning，打包态被丢弃 |
| 适配器必须实现 `providerRetryPolicy` | `adapter.providerRetryPolicy is not a function` → 路由不注册 |
| 适配器必须实现 `prepareCall` | `registration.adapter.prepareCall is not a function` → **选模型即报错** |
| `block-start` 用 `blockType`（字符串）而非 `block`（对象） | 宿主组装时 `blockType` 为 undefined |
| `block-end` 必须带完整 `block` | `Cannot read properties of undefined (reading 'type')`（**只有思考型模型立刻暴露**） |
| `tool-call-delta` 字段名是 `id` / `name` / `argumentsDelta` | 工具参数拼不上 |
| reasoning effort 必须**同时有非空 `id` 与 `name`**、`id` 不重复 | `INVALID_MODEL_REASONING` |
| Config 必须是**原生 schemastery**（`Symbol.for('schemastery')` + `type` + `meta`） | `status: 'unsupported'` → 设置页不可编辑、provider 进不了模型选择器 |
| **不要** `import '@deepseek-ai/schemastery'` | `link:` 安装下源码目录解析不到 → `ERR_MODULE_NOT_FOUND` → **宿主 host 进程崩溃**（`dsh desktop host exited with 1`） |
| 工具输出必须**无损 JSON**（紧凑序列化 + 缺省值用 `null`） | `value is not lossless JSON` → 整个工具结果被拒 |
| `apply` 必须返回 cleanup，资源用 `ctx.effect` 注册 | 禁用插件后 SQLite 句柄与端口泄漏 |

### 其他修复

- `resolveConfig` 曾把非法的 `models` 悄悄替换成默认值 → 非法配置被静默接受
- `Config.channel` 的白名单曾查错表（`cn` vs `bigmodel`）→ 合法值被拒
- 国际站轮询响应缺 `bigmodel.access_token` 曾导致登录失败 → `access_token` 降级为可选
- `expires_at` 当毫秒用 → 刚点登录就"授权超时"
- `flushStdio()` 用 `stream.write('', cb)` 在非 TTY 下**永不回调** → 顶层 await 悬空
- CLI 的 `login` 需要人工授权（长时间等待），必须取消 15 秒看门狗

### 测试

76 个用例：上游错误分类、身份块/日期块/工具断点、SSE 解码、**宿主 `BlockAssembler`
契约级复刻**、流翻译、切号策略、账号池、渠道归一、Config 校验、端到端接线。
`scripts/smoke-install.mjs` 另对**已安装**的插件跑 26 项真实接线检查。
