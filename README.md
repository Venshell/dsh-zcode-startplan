# dsh-zcode-startplan

让 **DSH（DeepSeek Harness）** 用上 **ZCode 的免费 plan**（`zcode.z.ai` 赠送额度）。

- **多账号池**：自动选号（默认**快过期先用**）、账号级限流标记、余额与到期时间可视化
- **每账号一个模型栏位**：固定吃该账号额度；另有「统一选号」自动换号栏
- **双渠道登录**：`bigmodel`（智谱）/ `zai`（Z.AI），面板内直接发起设备授权
- **面板内领取赠送额度**：自动探测活动（marketing/touch）、一键领取、可选自动领取
- **本地 OpenAI 兼容端点**：Codex / Cline 等客户端直接用账号池额度
- 零运行时依赖

[![npm](https://img.shields.io/npm/v/dsh-zcode-startplan)](https://www.npmjs.com/package/dsh-zcode-startplan)
[![license](https://img.shields.io/npm/l/dsh-zcode-startplan)](./LICENSE)

## 安装

**插件页（最简单）**：DSH Web UI 插件页 → 安装 → 输入 `dsh-zcode-startplan`。

**npm**：`npm install -g dsh-zcode-startplan`，然后在 DSH 会话里
`plugin_manager install_bundle`，target = `$(npm root -g)\dsh-zcode-startplan`。

**源码**：clone 后把目录登记进 profile。`link:` 安装下**重启宿主**才加载新代码。

## 快速上手

1. 面板「添加账号」→ 渠道 `bigmodel` / `zai` → 浏览器授权 → 自动入池
2. 模型选择器选 **「ZCode Start Plan」**（统一选号，快过期先用）或
   **「ZCode Start Plan · <昵称>」**（钉定单账号）
3. 领取赠送额度：面板「赠送额度」区展开即探测活动；领取要 captcha，
   **宿主需带调试端口启动**（面板按钮给出可复制的命令）：

   ```powershell
   & "<DSH 安装路径>\DeepSeek Harness.exe" --remote-debugging-port=9229
   ```

   > 调试端口**日常对话不需要**——captcha 按需触发，只有领取是硬性要求。

CLI：`node bin/cli.mjs login | list | status | probe | claim | captcha`。

会话里说「看一下 zcode start plan 的状态」触发 `zcode_start_plan_status` 工具。

## 配置（`cordis.patch.yml`）

```yaml
- insert:
    - id: zcode-start-plan
      name: dsh-zcode-startplan
      config:
        provider: zcode-start-plan      # DSH 路由名，不能重名
        models: [GLM-5.3, GLM-5.3-Flash]
        accountProviders: true          # 每账号一个模型栏位
        selectionOrder: expiry          # expiry（快过期先用）| manual（置顶优先）
        channel: bigmodel               # 登录渠道默认值
        captcha: { mode: cdp, debugPort: 9229, origin: 'https://zcode.z.ai/' }
        openaiGateway: { enabled: false, port: 17900 }
        endpoint: { enabled: false, port: 17899 }
        autoClaim: { enabled: false, intervalMs: 1800000 }
```

## 文档

| 文档 | 内容 |
|---|---|
| [CHANGELOG.md](CHANGELOG.md) | 每个版本修了什么、**每条约束「为什么不能改回去」** |
| [docs/host-contract.md](docs/host-contract.md) | DSH 宿主契约：inject、适配器三处直接调用、`BlockAssembler` chunk 形状、schemastery、无损 JSON、`webServer` 可选注入——每条都会让插件「看起来加载了、其实不工作」 |
| [docs/upstream-protocol.md](docs/upstream-protocol.md) | 上游协议硬约束：3012 准入（身份块）、错误码语义、200 包业务错误、活动发现与版本门控、18 个转发头对齐、领取纪律 |
| [docs/local-endpoints.md](docs/local-endpoints.md) | 本地 OpenAI / Anthropic 端点：配置、鉴权、OpenAI 协议陷阱（null 分片、孤儿 tool 配对） |
| [docs/channels.md](docs/channels.md) | 双通道架构：免费 / coding-plan，换 key 三步、3012 风控与自动切换（分支 `feature/coding-plan-channel`） |

## 参考项目支持

| 项目 | 采纳了什么 |
|---|---|
| [bonus-plan-4-open-zcode](https://gitee.com/iJetLi/bonus-plan-4-open-zcode) | 协议事实的原始出处：端点、错误码语义、captcha 时序、身份块是 3012 判据 |
| [zai-org/ZCode](https://github.com/zai-org/ZCode) | **官方身份块文本**（Apache-2.0，`identity.ts` 逐字） |
| [deepseek-harness-codearts](https://gitee.com/iJetLi/deepseek-harness-codearts) | **官方端点与风控对策**：版本门控、双来源活动发现、coding-plan 通道（biz API 换 key）、18 个转发头对齐官方抓包、OpenAI 网关的协议陷阱清单 |

## 许可

GPL-3.0-or-later，见 [LICENSE](LICENSE)。上游服务条款与账号策略以服务提供方为准。
