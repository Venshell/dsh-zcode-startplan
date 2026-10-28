# zcode-cli-adapter —— 把 ZCode CLI 接到本项目的免费 plan 通道

让**开源 ZCode CLI**（本机 `~/.zcode/bin/zcode.cmd`，v0.17.0）通过本项目已实现的
协议层（身份块 / 日期块 / 按需 captcha / 多账号池 / 切号），使用
`zcode.z.ai/api/v1/zcode-plan/anthropic` 的赠送免费 plan。

原理与参考项目 [bonus-plan-4-open-zcode](https://gitee.com/iJetLi/bonus-plan-4-open-zcode)
一致（本地 Anthropic 端点 + ZCode 自定义供应商），但**零新协议代码**——全部复用
仓库现有的 `lib/`（`local-endpoint.js` 的 `/v1/messages` + `plan-client.js` 的编排），
本目录只是三个独立的 Node 脚本：

```
ZCode CLI（自定义供应商，kind: anthropic）
   │  baseURL = http://127.0.0.1:<port> · apiKey = <持久化 token>
   ▼
server.mjs（本目录，独立进程，无需 DSH 在跑）
   ├─ /v1/messages ─► ZcodePlanClient：选号 → 身份块/日期块 → 按需 captcha
   │                  → 直发上游 → 3009 忙标记+退避 / 1005·1113·零内容切号 → SSE 透传
   ├─ /v1/models、/health
   └─ captcha ──────► 宿主 Electron 的离屏 iframe（CDP 9229，按需才产出）
   ▼
zcode.z.ai/api/v1/zcode-plan/anthropic
```

## 快速开始

```powershell
cd <本仓库根目录>

# ① 准备账号（二选一）
node bin\cli.mjs login                                  # 设备授权登录（推荐）
node zcode-cli-adapter\import-zcode-credential.mjs      # 或导入 ZCode CLI 已登录的 JWT

# ② 启动端点（前台；Ctrl+C 停）
node zcode-cli-adapter\server.mjs

# ③ 登记 ZCode CLI 自定义供应商（写 ~/.zcode/v2/config.json，幂等）
node zcode-cli-adapter\register-provider.mjs

# ④ 重启 ZCode CLI，会话里选模型：
#    /model custom:dsh-zcode-startplan/GLM-5.3-Flash
```

## 三个脚本

| 脚本 | 作用 | 要点 |
|---|---|---|
| `server.mjs` | 独立 Anthropic 端点（`/v1/messages`、`/v1/models`、`/health`） | 端口默认 17899、token 持久化（`endpoint-token.txt`）、端口被占自动回退随机并落盘 `cli-endpoint-port.txt`；`--status` 只读查看 |
| `register-provider.mjs` | 把端点登记成 CLI 自定义供应商 | 只动 `provider` 表、原子写（`.bak` 备份 + rename）、幂等；`--remove` 删除；`--port`/`--models`/`--key` 可覆盖 |
| `import-zcode-credential.mjs` | 从 ZCode CLI 登录态导入账号 | 依序找 `--jwt-file` → `~/.zcode/v2/credentials.json` → `config.json` 里 provider 的 JWT 形 apiKey；`pool.add` 按 user_id 去重；device_mid 现场生成 |

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `ZCODE_START_PLAN_DATA_DIR` | `~/.dsh/zcode-start-plan` | 账号库与 token 位置。**默认与 DSH 插件共用同一份账号池**（SQLite WAL，多进程安全） |
| `ZCODE_START_PLAN_TOKEN` | （读文件） | 固定端点 token（优先于落盘文件） |
| `ZCODE_START_PLAN_CDP_PORT` | `9229` | captcha 用的宿主调试端口 |

参数：`server.mjs --port <p> --cdp-port <p> --data-dir <dir> --models A,B`。

## 与 DSH 插件的关系

- **账号池共享**：两边读同一个 `accounts.db`（默认），面板/CLI 登录的账号两边都能用；
  想隔离就给 `server.mjs` 指不同的 `--data-dir`。
- **端口冲突**：DSH 插件的本地端点（`endpoint.enabled: true` 时）与 `server.mjs`
  默认都用 17899 —— **同一时间只开一个**，或用 `--port` 错开。被占时 `server.mjs`
  会自动回退随机端口（日志与 `--status` 如实显示），此时需重跑
  `register-provider.mjs` 更新 baseURL。
- **token 是两套**：DSH 端点的 token 与 `server.mjs` 的 token 各自独立（都落
  dataDir；CLI 侧环境变量 `ZCODE_START_PLAN_TOKEN` 可固定）。CLI 配置里写的
  apiKey 是**本地端点访问令牌**，不是上游凭据 —— zcode_jwt 永不进 CLI 配置。

## 硬约束（继承自根 README，不要“优化”）

- `system` 必须以官方身份块开头、首轮 user 消息带 `<system-reminder>` 日期块，
  否则 `3012`（**有账号冷却惩罚**）—— `plan-client.js` 已逐字复刻，别动。
- captcha「要了才取」：先不带，被 `3007` 拒才产出（需要宿主 Electron 开着调试端口）。
- `3012` 绝不重试；`3009` 打 60s 忙标记 + 退避重试，穷尽后换号（忙标记让并行请求绕开忙账号）；`1005`/`1113`/零内容 → 标号换号。
- 同一账号别在 ZCode CLI 原生通道与本端点**同时**用 —— 双倍消耗同一份额度。

## 已验证（2026-10-25 冒烟）

- `--status`：正确显示数据目录/账号数/token；
- `/health` 200、`/v1/models` 返回目录、无 token 401、空池 500 + Anthropic 形错误；
- 真实账号端到端：非流式 200（完整回答 + usage）、流式 SSE 事件序列完整
  （`message_start → content_block_* → message_delta → message_stop`）；
- 看门狗不误杀端点（t=18s 仍存活）；`register-provider` 合并写入无损 + 幂等；
- 仓库测试套件 92/92 通过（含 `local-endpoint.js` 非流式修复的回归）。
