# Changelog

本文件记录**每次修复背后的宿主契约**。只看 diff 看不出「为什么不能改回去」，
所以把约束与症状一起写下来。

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
