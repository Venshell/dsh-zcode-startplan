# dsh-zcode-startplan

让 **DSH（DeepSeek Harness）** 用上 **ZCode 赠送的免费 plan**
（`account:bigmodel-start-plan` → `https://zcode.z.ai/api/v1/zcode-plan/anthropic`）。

- 多账号池：多账号轮换，面板内一键「使用」切换，账号级限流标记与余额可视化
- **每账号一个模型栏位**（workbuddy 模式）：模型选择器里一栏一个账号
  （`ZCode Start Plan · 主号`），栏内模型固定消耗该账号额度（不自动换号），
  多会话各吃各的；「统一选号」栏位可在面板一键隐藏/恢复
- 双渠道登录：`bigmodel`（智谱开放平台）/ `zai`（Z.AI），插件详情页内直接发起设备授权
- Web UI 管理面板：挂在官方插件详情页的 `plugins.bundle.config` 座位，零依赖手写组件
- 零运行时依赖：协议层移植自 [bonus-plan-4-open-zcode](https://gitee.com/iJetLi/bonus-plan-4-open-zcode)，
  但形态不同——它做的是 ZCode 插件（本地代理），这里直接实现 **`ctx.llm` 适配器**，
  选号、captcha、切号、重试全在 DSH 进程内完成

[![dsh.so risk](https://www.dsh.so/badge/dsh-zcode-startplan.svg)](https://www.dsh.so/artifact/dsh-zcode-startplan/)
[![npm](https://img.shields.io/npm/v/dsh-zcode-startplan)](https://www.npmjs.com/package/dsh-zcode-startplan)
[![license](https://img.shields.io/npm/l/dsh-zcode-startplan)](./LICENSE)
[![release](https://img.shields.io/github/v/release/Venshell/dsh-zcode-startplan)](https://github.com/Venshell/dsh-zcode-startplan/releases)

```
DSH agent-loop
   │ ctx.llm.stream({ provider: 'zcode-start-plan', model: 'GLM-5.3', … })
   ▼
本插件 NativeZcodeStartPlanAdapter
   ├─ 选号：手动顺序，跳过「该模型」当日限流中的账号
   ├─ captcha：默认不带；被 3007 拒了才产出（"要了才取"），2 分钟内记住
   ├─ 组 body：官方身份块 + 日期块 + tools 缓存断点（3012 准入的三道闸门）
   ├─ 发车闸门：全局串行 + GLM-5.3 间隔 350ms
   └─ 读首帧：200 但零内容 → 标记该账号×模型 → 换号重试（客户端零 chunk）
   ▼
zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages（直连）
```

---

## 安装

### 方式一：插件页直接装（最简单）

DSH Web UI 的插件页支持直接按 **npm 包名**安装：打开插件管理页 → 安装/添加插件 →
输入 `dsh-zcode-startplan` → 确认。宿主会自己从 npm 拉取并登记，无需任何命令行。

### 方式二：npm CLI 安装

包发布在 npm：[`dsh-zcode-startplan`](https://www.npmjs.com/package/dsh-zcode-startplan)。

```powershell
# 全局安装后得到 zcode-start-plan 命令（CLI 可独立于 DSH 使用：login / list / status）
npm install -g dsh-zcode-startplan
```

把它装进 DSH profile：在 DSH 会话里调用官方安装器，`target` 传 npm 全局包的
实际目录（`npm root -g` 拼上包名）：

```powershell
$pkgDir = "$(npm root -g)\dsh-zcode-startplan"
# 在 DSH 会话里：plugin_manager install_bundle，target = $pkgDir
```

### 方式三：从源码目录

```powershell
git clone https://github.com/Venshell/dsh-zcode-startplan.git
cd dsh-zcode-startplan

# 1. 放到 plugins 目录
$dst = "$env:USERPROFILE\.dsh\plugins\dsh-zcode-startplan"
robocopy . $dst /E /XD node_modules .git

# 2. 用官方安装器登记 —— 在 DSH 会话里调用 plugin_manager install_bundle，
#    target 传 $dst 的绝对路径
```

装完后 profile 的 `package.json` 会自动出现：

```jsonc
{
  "dependencies": { "dsh-zcode-startplan": "link:C:/Users/<you>/.dsh/plugins/dsh-zcode-startplan" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-zcode-startplan"] } }
}
```

> ⚠ `link:` 安装下**重启宿主**才会加载新的 JS 模块代际（热重载只重建 entry，
> 不重新 import 已缓存的模块）。另外本插件安装目录若为实体拷贝，改完源码记得
> robocopy 同步过去，否则宿主看到的永远是旧代码。

## 登录账号

**方式一（推荐）：Web UI 面板**。重启宿主后打开 DSH 设置 → 插件 →
ZCode Start Plan 详情页，顶部「添加账号」：渠道下拉选 `bigmodel` 或 `zai` →
发起登录 → 浏览器完成授权 → 自动入池。

**方式二：CLI**（无需 DSH 在跑）：

```powershell
cd <插件目录>
node bin/cli.mjs login                    # 默认渠道 bigmodel（智谱 bigmodel.cn）
node bin/cli.mjs login --channel zai      # zai（Z.AI · z.ai）
node bin/cli.mjs list                     # 账号列表（脱敏，含来源渠道）
node bin/cli.mjs status                   # 账号 + 余额 + 上游模型目录 + captcha 配置
```

两条渠道**协议完全相同**（同一个 `/api/v1/oauth/cli/init` 与 `poll/{id}`），
只在 `provider`（`bigmodel` / `zai`）与授权站点上不同。

已有 JWT 时可导入：

```powershell
node bin/cli.mjs import .\zcode-jwt.txt --name <备注>
```

> 账号库在 `%USERPROFILE%\.dsh\zcode-start-plan\accounts.db`（SQLite，600）。
> 目录不可写时降级为**内存库**并在日志里明确告警。

## Web UI 管理面板

插件详情页的「账号池管理」块（`plugins.bundle.config` 座位，按包名 key 派发）：

- **账号列表**：状态点、昵称（点击原位改名）、渠道（`bigmodel` / `zai`）、限流 chips、余额条
- **使用**：把该账号置顶 —— 池子的约定是**手动顺序即选号优先级**，置顶即
  「下一次请求用它」；使用中的账号显示「使用中」并高亮
- **删除**：二次确认后删除
- **显示在模型列表**：每栏最右的开关控制该账号（及「统一选号」栏）是否出现在
  模型选择器里。三颗开关（各账号栏 + 统一选号行）在视觉上对齐同一条竖线
  （卡片栏距卡片边框 26px，统一行补 13px 内边距拉齐）；tooltip 由动态文案改为
  固定 `aria-label`「在模型列表中显示这一栏」，读屏/键盘行为一致
- **刷新**：一个按钮搞定（列表+余额一次并行拉全）
- 安全：面板与宿主之间走同源 fetch + loopback 路由，凭据永不出网关；
  登录授权的 `flowSecret` 只留在宿主内存

## 在 DSH 里使用

1. 模型选择器里每个启用账号都是独立一栏：**「ZCode Start Plan · 主号」→
   GLM-5.3 / GLM-5.3-Flash** —— 栏内模型固定消耗该账号的额度（额度尽明确报错，
   不自动换号），多会话可各选各的账号栏
   - 「ZCode Start Plan」统一栏位按置顶顺序自动选号；不需要时可在插件面板
     「隐藏统一选号栏位」，随时可恢复
2. 会话里说「看一下 zcode start plan 的状态」→ 触发 `zcode_start_plan_status`
   （返回路由、模型、账号数、每账号的限流标记、captcha 可达性、诊断字段
   `adapterRegistered` / `error`）

### captcha 需要宿主 Electron 的调试端口

captcha 是阿里云**网页 SDK**，必须在真实 https origin 里跑。插件通过 CDP 在宿主
renderer 里挂一个**离屏隐藏 iframe**（`opacity:0`、`pointer-events:none`、只增删自己的
元素、用完即移除），不碰界面。

打包态默认**不开**调试端口，需要带参数启动一次：

```powershell
& "D:\software\dsh\DeepSeek Harness.exe" --remote-debugging-port=9229
```

（端口不同就改 `cordis.patch.yml` 的 `captcha.debugPort`，或设
`ZCODE_START_PLAN_CDP_PORT`。）

验证：

```powershell
node bin/cli.mjs captcha     # 打印「调试端口可达 / 不可达」与产出耗时
node bin/cli.mjs probe       # 真发一条最小请求，验证「选号 → captcha → 首帧」全链路
```

## 额度与切号

- 免费额度按**自然日**（UTC+8）结算；用尽的账号标记到当日 24:00 自动恢复
- 触发切号：`1005` / `1113`、HTTP 200 但**零内容**
- 触发重试但**不换号**：`3009`（退避 1500/3000ms）、`3007`（换新 captcha，最多 2 次）
- **不重试**：`3012`（风控，有冷却惩罚）、`401` / `1002`（凭据失效 → 重新登录）

领取每日额度：

```powershell
node bin/cli.mjs claim        # 补活跃上报 → 查可领 → 逐个领取（每个 plan 单独 captcha）
```

`1003`（已领取过）按**幂等成功**处理。

## 配置（`cordis.patch.yml`）

```yaml
- insert:
    - id: zcode-start-plan
      name: dsh-zcode-startplan
      config:
        provider: zcode-start-plan      # DSH 路由名（与其它 llm 适配器不能重名）
        displayName: ZCode Start Plan（赠送免费 plan）
        models: [GLM-5.3, GLM-5.3-Flash]
        accountProviders: true          # false = 不为每个账号注册独立 provider 栏位
        dataDir: ''                     # 空 = ~/.dsh/zcode-start-plan
        modelCacheMs: 600000
        channel: bigmodel               # bigmodel（智谱）或 zai（Z.AI）
        captcha:
          mode: cdp                     # cdp = 宿主 Electron 产出；manual = 人工粘贴
          debugPort: 9229
          origin: https://zcode.z.ai/   # 必须是真实 https
        endpoint:
          enabled: false                # true 才起本地 Anthropic 端点（仅 llm-pi-ai 回落路线）
          port: 17899
        statusTool: true
```

### 回落路线：走 `llm-pi-ai`

想复用 DSH 自带的 pi-ai 适配器时，把 `provider` 改个名并打开本地端点：

```yaml
- id: zcode-start-plan
  name: dsh-zcode-startplan
  config:
    provider: zcode-start-plan-pi
    endpoint: { enabled: true, port: 17899 }

- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      zcode-start-plan-pi:
        displayName: ZCode Start Plan
        api: anthropic-messages
        baseURL: http://127.0.0.1:17899
        apiKeyEnv: ZCODE_START_PLAN_LOCAL_TOKEN
        models:
          - { id: GLM-5.3, name: GLM-5.3 }
```

端点 token 持久化在 `<dataDir>\endpoint-token.txt`，**端口与 token 都不能每次变**
（profile 里配好的 `baseURL` / `apiKeyEnv` 会每次重启失效）。

### 接入 ZCode CLI（无需 DSH 在跑）

[zcode-cli-adapter/](zcode-cli-adapter/) 把同一套账号池/切号/captcha 能力以独立
Anthropic 端点（`server.mjs`）的形态提供给**开源 ZCode CLI**：导入/登录账号 →
起端点 → `register-provider.mjs` 写入 CLI 自定义供应商（`custom:dsh-zcode-startplan`）→
会话里 `/model custom:dsh-zcode-startplan/GLM-5.3-Flash`。详见
[zcode-cli-adapter/README.md](zcode-cli-adapter/README.md)。

## 上游协议硬约束（来自实测，不要"优化"）

| 现象 | 后果 | 本插件的处理 |
|---|---|---|
| `system` 不以**官方身份块**开头 | `3012 unusual activity`，**有账号冷却惩罚**（30 分钟；24h 内第 3 次起 24 小时；5 次停用） | `lib/anthropic-body.js` 逐字复刻 cliPrefix + stable 段，调用方 system 追加在最后 |
| 首轮 user 消息缺 `<system-reminder>` 日期块 | 同上（3012） | 幂等插入到**内容数组**最前面 |
| captcha 每次请求都产出 | 白耗设备信誉与 0.5–7 秒 | 先不带，被 `3007` 拒才产出，成功则清记忆 |
| 同一 captcha param 复用 | 必 `3007` | 每轮重试都重新产出 |
| 把 `3009` 当额度用尽 | 误伤可用账号 | `3009` 退避重试（1500/3000ms）**不换号** |
| `3012` 重试 | 冷却升级到 24 小时 → 停用 | 直接失败，**绝不重试** |
| **200 里包裹业务错误** | 错误码被当成「空响应」丢掉，排查全是误导 | `lib/sse.js` 先识别 `{code,msg}` / `{type:error}` / 裸 `{error}`，再按错误表处置 |
| 200 但零内容直接透传 | 用户看到空回答，账号仍被反复使用 | 先读首帧判定，零内容即标号换号 |
| DSH 的 image 块是**持久引用**（`{type:'image', attachment:ref}`），不是 base64 | 只认内联 base64 会把图片**静默丢弃**（用户发图但上游没收到） | 组 body 前经附件服务 `readImageRequest` 解析成字节再编码（`ctx.get('attachments')` 探测，刻意不进 inject —— inject 是硬依赖，服务缺席会挂起整个插件） |
| 上游模型目录 `capabilities.vision` 决定图片能力 | 宿主对声明不含 `image` 的模型直接拒带图消息 | `GLM-5.3-Flash` 实测 `vision:true` 可传图；`GLM-5.3` 为空，带图请换 Flash |
| 非流式 JSON 用 SSE 特征串判内容 | 正常回答被判空 → **账号被错误标记限流** | 按 content-type 分流，JSON 走结构解析 |
| `expires_at` 当毫秒用 | 刚点登录就"授权超时" | `toEpochMs()` 按数量级归一（秒/毫秒） |
| 非法渠道 provider | 上游返回 500 `code:1000` | 渠道白名单在激活期就拒（`bigmodel` / `zai`） |
| 领取前不补活跃上报 | `preview` 恒为空 → 永远"没得领" | 每次查 preview 前先发 `app_launch` + `app_daily_active` |
| 普通浏览器 / `about:blank` 出 captcha | 二次 mint 必 F001 | 用**真实 https origin** 的离屏 iframe（宿主 Electron） |

## DSH 宿主契约（**本插件踩过最深的坑**）

这一节的每一条都会让插件「看起来加载了、其实不工作」。**改动本插件前先读完。**

### `ctx` 是沙箱 façade：用到的服务必须 `inject` 声明

宿主的 `ctx` **只挂 `inject` 声明过的服务**。实测（一次性诊断插件）：

```
Object.keys(ctx)            → ['fiber']      ← 只有 fiber
ctx.llm                     → object        ← 我 inject 了它，可用
ctx.tools                   → 抛错 "cannot get property "tools" without inject"
```

**漏声明的症状**：插件在插件列表里可见、Config 状态是 `schema`（那只是 manifest 元数据，
不需要执行模块），但**工具与模型全都没有**；宿主只往 stderr 打一条 warning，
打包态下 stderr 被丢弃 —— 所以什么都看不到。

⇒ 本插件 `inject = ['llm', 'tools', 'timer', 'webServer']`，一个都不多。

### 宿主对适配器有**三处不带可选调用保护**的直接调用

| 方法 | 何时被调用 | 漏掉的后果 |
|---|---|---|
| `providerRetryPolicy(provider)` | `registerAdapter` 时（`prepareRoutes`） | `adapter.providerRetryPolicy is not a function` → **路由不注册** |
| `prepareCall(provider, model, signal)` | 选模型后 | `registration.adapter.prepareCall is not a function` → **选模型即报错** |
| `resolveModel(provider, model)` | 校验模型时 | 同上 |

基类 `LlmAdapter` 提供了 `prepareCall` 的默认实现，但本插件**没有 extends 基类**
（避免与宿主版本耦合），所以三个都要自己补。

### chunk 形状必须匹配 `BlockAssembler`

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

### 模型元数据校验

- 每个 reasoning effort 必须**同时有非空 `id` 与非空 `name`**，且 `id` 不重复
  → 否则 `INVALID_MODEL_REASONING`（"invalid or duplicate reasoning effort metadata"）
- `defaultEffort` 必须是已声明过的 effort 之一
- `listModels` 必须返回**非空**目录，否则宿主要求"catalog membership"的入口
  （模型选择器）看不到这个 provider

### Config 必须是**原生 schemastery** schema

宿主用 `isNativeConfigSchema(config)` 判定：`Symbol.for('schemastery') === true`
+ string `type` + object `meta`。不满足就是 `status: 'unsupported'` →
设置页不可编辑、**provider 进不了模型选择器**。

⚠ **但不要 `import '@deepseek-ai/schemastery'`**：`plugin_manager` 用**软链**安装
（`link:`），插件实际运行在源码目录，那里解析不到 profile 的 `node_modules` ——
顶层静态 import 会 `ERR_MODULE_NOT_FOUND`，**把宿主 host 进程掀翻**
（实测：`Error: dsh desktop host exited with 1`）。

⇒ 本插件**零运行时依赖**，自带一个最小 schemastery 兼容对象
（`index.js` 的 `makeConfigSchema`），并附带 Standard Schema 兼容层。

### 工具输出必须是**无损 JSON**

宿主把 `JSON.parse(text)` 与原值深比较：

- `JSON.stringify(value, null, 2)`（带缩进）→ `value is not lossless JSON`
- 值里有 `undefined` → 该键被 stringify 静默丢弃 → round-trip 后键消失 → 同样被拒

⇒ 紧凑序列化 + 缺省值一律用 `null`（不是 `undefined`）。

### Web UI（Client 半段）的两个硬契约

- `package.json` 必须有 `exports["./client"]` + `files` 白名单含 `client.js` +
  `dsh.client` 段（`platform` / `immediately` / `inject`），缺一样宿主就不把
  Client 半段下发给 Web GUI；client 工厂返回值要 `inject: ['slots']`
- 面板挂 `plugins.bundle.config` 座位：宿主**按包名 key 派发**（`key` 必须与
  安装的包名一字不差），列表页则以 `view === 'summary'` 请求一行简介

## 已知边界

- **闭源 ZCode 与本插件同时用同一账号**会双倍消耗验证配额 —— 建议一处用
- `--headless` 宿主产不出 captcha（真 GUI 进程天然满足）
- 上游身份块结构与策略强耦合：官方客户端升级后若改了结构，需同步
  `lib/anthropic-body.js`，否则重新出现 3012 —— **不要为调试反复触发 3012**
- 账号库是 SQLite（`node:sqlite`，Node ≥22.5），不是参考实现的 AES-256-GCM + DPAPI；
  需要更强保护就把 `dataDir` 指向加密卷
- 参考实现带「宿主守卫」（识别闭源 ZCode 并拒绝产出）；DSH 场景没有这个二义性
  （宿主永远是 DSH），故未移植

## 开发

```powershell
node scripts/run-tests.mjs      # 93 个用例，单进程跑（沙箱里 spawn 会被拒）
node scripts/smoke-install.mjs  # 对**已安装**的插件跑真实接线（26 项）
node scripts/verify_compat.mjs  # 兼容性门禁（peerDependencies 不会被判不兼容）
node bin/cli.mjs help           # CLI 一览
```

测试覆盖：上游请求头与错误分类、身份块/日期块/工具断点、SSE 解码（含跨 chunk 与
EOF flush）、**宿主 `BlockAssembler` 契约级复刻**、Anthropic→DSH 流翻译
（text/tool_use/thinking/error）、切号策略、账号池、登录渠道归一、Config 校验、
端到端 `adapter.stream()` 与 `apply()` 接线。

## 文件地图

| 文件 | 作用 |
|---|---|
| `index.js` | Cordis 入口：Config 契约（零依赖 schemastery 兼容）、`inject` 声明、`apply` 与 cleanup |
| `client.js` | Client 半段：插件详情页的账号池管理面板（`plugins.bundle.config`） |
| `lib/pinned-model.js` | 「模型 × 账号」钉定条目的 id 编解码（`<base>@acct:<账号id>`） |
| `lib/assemble.js` | 资源装配与释放、状态工具、管理路由注册 |
| `lib/manage-routes.js` | `/api/zcode-start-plan/*` 管理路由（loopback 栅栏、凭据不出网关） |
| `lib/adapter.js` | `llm` 适配器（`providerInfo` / `providerRetryPolicy` / `listModels` / `resolveModel` / `prepareCall` / `stream`） |
| `lib/plan-client.js` | 一次调用的编排：选号 / captcha / 重试 / 切号 |
| `lib/anthropic-body.js` | 官方身份块、日期块、tools 断点、DSH↔Anthropic 内容转换 |
| `lib/sse.js` | SSE 解码、「200 但零内容」判定、**业务错误识别** |
| `lib/stream-translator.js` | Anthropic 事件 → DSH chunk（`BlockAssembler` 契约） |
| `lib/upstream.js` / `lib/upstream-api.js` | 请求头、端点、登录/余额/领取/模型目录 |
| `lib/captcha/*` | 离屏 iframe captcha 产出器（CDP） |
| `lib/pool.js` | SQLite 账号库 + 账号池 |
| `lib/local-endpoint.js` | 可选本地 Anthropic 端点（pi-ai 回落路线） |
| `bin/cli.mjs` | login / list / status / probe / claim / captcha |

## 许可

GPL-3.0-or-later，见 [LICENSE](LICENSE)。上游服务条款与账号策略以服务提供方为准。
协议实现参考并移植自 [bonus-plan-4-open-zcode](https://gitee.com/iJetLi/bonus-plan-4-open-zcode)。
