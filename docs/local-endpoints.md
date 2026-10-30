# 本地端点（OpenAI / Anthropic）

两个**并列**的本地出口，可同时开启，都走同一个 `planClient.call()` ——
账号池、换号、captcha、限流全部复用，不另起一套。仅监听 `127.0.0.1`；
跨机器访问自备隧道（SSH 端口转发），本插件不做局域网暴露。

## OpenAI 兼容端点（0.9.0）

`lib/openai-gateway.js`：`GET /v1/models`、`POST /v1/chat/completions`
（SSE + 非流式）、`GET /health`（免 key）。

```yaml
openaiGateway: { enabled: true, port: 17900 }
```

apiKey：`~/.dsh/zcode-start-plan/openai-api-key`（43 位 base64url，首启自动生成），
或环境变量 `DSH_OPENAI_GATEWAY_API_KEY`（优先）。

## Anthropic 端点（pi-ai 回落路线）

`lib/local-endpoint.js`：`POST /v1/messages` 字节级透传上游 SSE。仅当想复用 DSH 自带
`llm-pi-ai` 适配器时开启：

```yaml
- id: zcode-start-plan-pi
  config:
    provider: zcode-start-plan-pi
    endpoint: { enabled: true, port: 17899 }
- id: llm-pi-ai
  config:
    providers:
      zcode-start-plan-pi:
        api: anthropic-messages
        baseURL: http://127.0.0.1:17899
        apiKeyEnv: ZCODE_START_PLAN_LOCAL_TOKEN
```

⚠ token 持久化在 `<dataDir>\endpoint-token.txt`：**端口与 token 都不能每次变**
（profile 里配好的 `baseURL`/`apiKeyEnv` 会随重启失效）。

## OpenAI 协议陷阱（全部来自参考实现 `deepseek-harness-codearts` 的真机流量）

| 坑 | 症状 | 对策 |
|---|---|---|
| `typeof x === 'string'` vs `!== undefined` | 真实 SSE 里 `content` 与 `reasoning_content` **另一侧恒为 null** ⇒ `.length` 在 null 上崩，首帧就炸 | 一律 `typeof` 判断 |
| 孤儿 `tool` 消息 | 上游 400，而坏历史**每轮原样重放** ⇒ 会话永久报废 | 发请求前剔除配对已坏的结果 |
| 同 id 既有好调用又有坏调用 | 只看 dropped 会删掉好调用的回执 ⇒ 留下孤儿 tool-call，上游照样 400 | 剔除条件 `dropped && !kept`（预扫与主转换**共用同一份判据**） |
| 分片带空 `function.name` | 清空已解析的工具名 → `unknown tool ""` | 只接受非空覆盖 |
| 空 assistant（调用被剔光） | 变 wire 上的**空开头发言** ⇒ 上游 `model_param_invalid` | 整条剔除；**正文非空的保留**（那是用户真看到的内容） |
| 上游 `{status:200}` 表业务失败 | 「额度用尽」被客户端读成**成功** | 状态码门禁 400–599 |
| 流缺 `finish` | 半截输出被当完整结果持久化 | 报错 `ended before finish`，不假装成功 |
| `tool_choice: required` / 指名函数 | DSH 侧表达不出来 | 直接 400，不静默降级（客户端会误以为约束生效） |

映射口径：

- `reasoning-delta` → **`reasoning_content`**（DeepSeek 系私有名，Cline/qoder 读它）；
  不同时发 `reasoning`（Cline 的写法）——两边同时发会让部分客户端重复渲染
- finish reason：`stop`→`stop`、`tool-calls`→`tool_calls`、`max-tokens`→`length`、
  `aborted`/`error`→`error`
- usage：`inputTokens`（已含缓存）→ `prompt_tokens`；`cached_tokens` 是其**子集**；
  官方明细字段必须给（标准客户端只认官方形态），`prompt_cache_hit_tokens`
  作为私有兼容字段保留（真有缓存命中才发）

## apiKey 安全策略

- **文件内容异常时报错而不是静默换 key**：静默换会让所有已配置客户端同时 401，
  用户只看到 "unauthorized"，无从判断是自己粘错了哪一位还是服务端变了。
  形态判据（定长 43 位 `[A-Za-z0-9_-]`）让「损坏」与「用户自己换过」可机械区分
- `/health` 不校验 key：探活工具不该持凭据
- 日志与错误里**永不打印** apiKey（它会被贴进配置文件和 bug 报告）

## 已踩过的实现 bug

`plan-client` 返回的 `result.decoder` 是 `{ read(): Promise<{done, value?}> }`，
**不是异步生成器**。误当生成器 `for await` 消费会报
`result.decoder.read is not a function`，被 catch 兜住后只发一帧 error chunk ——
表现为「流式回答只有一个 reasoning 帧就断了」。
`tests/openai-gateway.test.mjs` 用**真实 decoder 形状**驱动整条 HTTP 路径防回归。
