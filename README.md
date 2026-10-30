# dsh-zcode-startplan

让 **DSH（DeepSeek Harness）** 用上 **ZCode 的免费 plan**（`zcode.z.ai` 赠送额度）。

- **多账号池**：自动选号（默认**快过期先用**）、账号级限流标记、余额与到期时间可视化
- **每账号一个模型栏位**：模型选择器里一栏一账号，固定吃该账号额度；另有「统一选号」自动换号栏
- **双渠道登录**：`bigmodel`（智谱）/ `zai`（Z.AI），面板内直接发起设备授权
- **面板内领取赠送额度**：自动探测活动（marketing/touch）、一键领取、可选自动领取
- **双通道推理**：免费通道（`zcode_jwt`）优先；撞 `3012` 风控自动切 **coding-plan 通道**（`api.z.ai` + biz API 换 key）—— 这正是官方客户端走的链路
- **本地 OpenAI 兼容端点**：任意 OpenAI 客户端（Codex / Cline）直接用账号池额度
- 零运行时依赖

[![npm](https://img.shields.io/npm/v/dsh-zcode-startplan)](https://www.npmjs.com/package/dsh-zcode-startplan)
[![license](https://img.shields.io/npm/l/dsh-zcode-startplan)](./LICENSE)

```
DSH agent-loop → ctx.llm.stream({ provider: 'zcode-start-plan', … })
   ▼
本插件适配器：选号 → 通道选择 → captcha（按需）→ 组 body（官方身份块）→ 发车闸门
   ▼
免费通道  zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages（zcode_jwt）
官方通道  api.z.ai/api/anthropic/v1/messages（coding_plan_key，3012 时自动切换）
```

## 安装

**方式一（最简单）**：DSH Web UI 插件页 → 安装插件 → 输入 `dsh-zcode-startplan`。

**方式二（npm）**：

```powershell
npm install -g dsh-zcode-startplan
# 在 DSH 会话里 plugin_manager install_bundle，target = "$(npm root -g)\dsh-zcode-startplan"
```

**方式三（源码）**：clone 后把目录登记进 profile（`link:` 安装，改源码重启即生效）。

> ⚠ `link:` 安装下**重启宿主**才会加载新代码（热重载不重新 import 模块）。

## 登录账号

面板「添加账号」→ 渠道选 `bigmodel` 或 `zai` → 浏览器授权 → 自动入池。

CLI 等价：

```powershell
node bin/cli.mjs login [--channel zai]
node bin/cli.mjs list / status / import <jwt.txt>
```

账号库在 `~/.dsh/zcode-start-plan/accounts.db`（SQLite）。登录时同时保存
`zai_access_token` / `bigmodel_access_token`（coding-plan 通道换 key 的原料）。

## 使用

模型选择器里：

- **「ZCode Start Plan」统一栏位**：自动选号（默认快过期先用）
- **「ZCode Start Plan · <昵称>」钉定栏位**：固定消耗该账号，绝不换号

会话里说「看一下 zcode start plan 的状态」触发 `zcode_start_plan_status` 工具。

### 领取赠送额度

面板「赠送额度」区展开即自动探测活动（`GET /marketing/touch`，零 captcha）。
领取要 captcha（每个 plan 一个，一次性）——**需要宿主带调试端口启动**：

```powershell
& "D:\software\dsh\DeepSeek Harness.exe" --remote-debugging-port=9229
```

> 调试端口**日常对话不需要**——captcha 在推理链路里按需触发，只有领取是硬性要求。
> 面板按钮会给出可复制的启动命令（插件不替你重启，原因见 CHANGELOG 0.6.6）。

「自动领取」拨盘（默认关）：开启后定时探测，发现新活动自动领取；
`0`/`1003`/`1005` 记入已领集合，绝不重复烧 captcha。

### 通道与风控

| 通道 | 端点 | 凭据 | 何时用 |
|---|---|---|---|
| 免费（默认） | `zcode.z.ai/.../zcode-plan/anthropic` | `zcode_jwt` | 一切正常时；赠送额度只在这条通道 |
| **coding-plan** | `api.z.ai/api/anthropic` | `coding_plan_key`（biz API 三步换出） | 免费通道撞 `3012` 风控时**自动切换**；有 `access_token` 的账号启动时预换 key |

`3012`（unusual activity）有账号冷却惩罚（30 分钟 → 24 小时 → 停用），**永不重试**。
`3009`（并发限流）打忙标记让并行请求绕开；`1005`/`1113`/零内容换号。

### 本地 OpenAI 兼容端点

```yaml
# cordis.patch.yml
openaiGateway: { enabled: true, port: 17900 }
```

客户端填 `baseURL = http://127.0.0.1:17900/v1`，apiKey 在
`~/.dsh/zcode-start-plan/openai-api-key`（或环境变量 `DSH_OPENAI_GATEWAY_API_KEY`）。
仅监听 loopback。另有 Anthropic 格式端点（`endpoint.enabled`）与 pi-ai 回落路线，见 CHANGELOG。

## 配置（`cordis.patch.yml`）

```yaml
- insert:
    - id: zcode-start-plan
      name: dsh-zcode-startplan
      config:
        provider: zcode-start-plan      # DSH 路由名，不能与其它适配器重名
        models: [GLM-5.3, GLM-5.3-Flash]
        accountProviders: true          # 每账号一个模型栏位
        selectionOrder: expiry          # expiry（快过期先用）| manual（置顶优先）
        channel: bigmodel               # 登录渠道默认值：bigmodel | zai
        captcha: { mode: cdp, debugPort: 9229, origin: 'https://zcode.z.ai/' }
        openaiGateway: { enabled: false, port: 17900 }
        endpoint: { enabled: false, port: 17899 }
        codingPlan: { enabled: true }   # false = 整体停用官方通道
        autoClaim: { enabled: false, intervalMs: 1800000 }
```

## 参考项目支持

本插件的协议事实与实现细节大量来自以下开源项目，**逐条实测后采用**：

| 项目 | 采纳了什么 |
|---|---|
| [bonus-plan-4-open-zcode](https://gitee.com/iJetLi/bonus-plan-4-open-zcode) | 协议事实的原始出处：端点、错误码语义（3007/3009/3012/1005/1113）、captcha 时序、身份块是 3012 判据 |
| [zai-org/ZCode](https://github.com/zai-org/ZCode) | **官方身份块文本**（Apache-2.0，`identity.ts` 逐字），3012 准入的三道闸门之一 |
| [deepseek-harness-codearts](https://gitee.com/iJetLi/deepseek-harness-codearts) | **官方端点与风控对策**（0.8.0–0.9.1）：版本门控（marketing/claim 抬 ≥3.16.3）、双来源活动发现（preview + marketing）、grant_units 求和、confirm 回执门控、**coding-plan 通道**（biz API 换 key、`api.z.ai` 端点、免费优先、3012 不重试）、18 个转发头逐字对齐官方抓包、OpenAI 网关的协议陷阱清单（null/分片/孤儿 tool 配对） |
| [MYCF711/dsh-free-glm](https://github.com/MYCF711/dsh-free-glm) | 无代码往来（同源兄弟项目，独立验证出同一身份块结论） |

感谢这些项目的作者把实测结论写进公开代码——本仓库的 CHANGELOG 里每条
「实测」背后都有对应的验证记录。

## 上游协议硬约束（不要"优化"）

| 现象 | 处理 |
|---|---|
| `system` 不以官方身份块开头 / 缺日期块 | `3012`（有冷却惩罚）→ `lib/anthropic-body.js` 逐字复刻 |
| captcha 每次都产出 / 复用 param | 先不带，被 `3007` 拒才产出；每轮重试重新 mint |
| `3009` 当额度用尽 | 打 60s 忙标记 + 退避，穷尽换号；不当成限流落库 |
| `3012` 重试 | 冷却升级 → **绝不重试**；免费腿撞了自动切 coding-plan |
| **200 里包裹业务错误** | `lib/sse.js` 先识别 `{code,msg}` 再按错误表处置 |
| 200 但零内容 | 先读首帧判定，零内容即标号换号 |
| `expires_at` 秒/毫秒混用 | `toEpochMs()` 按数量级归一 |
| marketing/claim 用旧版本号 | `1004 no permission` / 投放恒空 → 抬 ≥3.16.3 |
| 领取前不补活跃上报 | preview 恒空 → 永远「没得领」 |

## DSH 宿主契约（踩过最深的坑）

每一条都会让插件「看起来加载了、其实不工作」。**改代码前先读完。**

- **`ctx` 是沙箱 façade**：服务必须 `inject` 声明才存在。漏声明的症状是插件可见但模型/工具全无，stderr 只有一条 warning（打包态直接丢弃）
- **适配器三处无保护直接调用**：`providerRetryPolicy` / `prepareCall` / `resolveModel` 缺一个就路由不注册或选模型即报错
- **chunk 形状必须匹配 `BlockAssembler`**：`block-start` 用 `blockType`、`block-end` 必须带完整 `block`、`tool-call-delta` 字段是 `id`/`name`/`argumentsDelta`、finish 的 kind 包在 `reason` 对象里（放顶层不炸但**静默吞错误**）
- **Config 必须是原生 schemastery schema**：但**不要** import schemastery 包（`link:` 安装下会 `ERR_MODULE_NOT_FOUND` 掀翻宿主）——自带最小兼容对象
- **工具输出必须无损 JSON**：紧凑序列化、缺省用 `null` 不用 `undefined`
- **`webServer` 只能可选注入**：`export const inject = [..., 'webServer']` 会让 headless profile 整个 fiber 挂起
- **Client 半段**：`package.json` 要有 `exports["./client"]` + `dsh.client` 段；面板挂 `plugins.bundle.config` 座位，按包名 key 派发

## 文件地图

| 文件 | 作用 |
|---|---|
| `index.js` | Cordis 入口：Config 契约、inject 声明、apply/cleanup |
| `client.js` | Web UI 面板（账号池管理、领取、自动领取拨盘） |
| `lib/adapter.js` | llm 适配器（路由、模型目录、流式入口） |
| `lib/plan-client.js` | 一次调用的编排：选号 / **通道选择** / captcha / 重试 / 切号 |
| `lib/coding-plan.js` | coding-plan 通道：biz API 换 key、缓存补种 |
| `lib/anthropic-body.js` | 官方身份块、日期块、tools 断点 |
| `lib/upstream.js` / `lib/upstream-api.js` | 请求头（18 头对齐官方）、登录/余额/领取/活动发现 |
| `lib/pool.js` | SQLite 账号库 + 账号池（expiry 选号） |
| `lib/openai-gateway.js` / `lib/local-endpoint.js` | 本地 OpenAI / Anthropic 端点 |
| `lib/captcha/*` | 离屏 iframe captcha 产出器（CDP） |
| `bin/cli.mjs` | login / list / status / probe / claim / captcha |

## 开发

```powershell
node scripts/run-tests.mjs      # 全量用例，单进程跑
node scripts/smoke-install.mjs  # 对已安装插件跑真实接线（26 项）
node bin/cli.mjs help
```

详细变更与每条约束的「为什么不能改回去」：[CHANGELOG.md](CHANGELOG.md)。

## 许可

GPL-3.0-or-later，见 [LICENSE](LICENSE)。上游服务条款与账号策略以服务提供方为准。

身份块文本来自 [zai-org/ZCode](https://github.com/zai-org/ZCode)（Apache-2.0，保留版权声明）；
其余参考项目见上方「参考项目支持」表。
