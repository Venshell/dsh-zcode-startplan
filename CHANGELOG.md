# Changelog

本文件记录**每次修复背后的宿主契约**。只看 diff 看不出「为什么不能改回去」，
所以把约束与症状一起写下来。

## 0.4.5 — 面板开关列对齐 + tooltip 去动态化

### 症状

三颗「显示在模型列表」开关（各账号栏 + 「统一选号」行）不在同一条竖线上：
卡片内的开关贴卡片内边距，统一行的开关贴整行右缘，视觉错位。

### 修复

- `.zsp-toggle` 加 `margin-left:auto`：开关统一由行内右侧推齐，不再依赖调用点
  传入的布局；
- `.zsp-unified`（统一行）补 `padding-right:13px`：统一行比卡片少一层
  「卡片边框 + 卡片内边距」（卡片侧 1+12+1+12=26px，统一行侧 13px），补差后
  三颗开关落到同一条竖线；
- `Toggle` 组件去掉按状态切换的动态 `title`（「点此隐藏/点此恢复」两套文案），
  固定为 `aria-label: 在模型列表中显示这一栏`。动态 tooltip 在开关密集时反而
  制造噪音，固定 label 对读屏与键盘用户行为可预期。

## 0.4.4 — 兜底表档位元数据 + 目录失败先用过期缓存（GLM-5.3「不支持当前档位」根因）

### 症状

给 GLM-5.3（或 Flash）选思考档位 → 立刻报「不支持当前档位」、无输出；
「暂时切换」（只选模型不动档位）就能继续。

### 根因

不是 wire 映射（`output_config.effort` 对 GLM-5.3 同样被上游接受，已实测），
而是**目录元数据瞬间缺失**：`fetchModels` 间歇失败 → `loadModels` 直接落兜底表 →
兜底表无 `reasoningLevels` → 宿主 `resolveCallWithInfo` 对显式 effort 抛
`UNSUPPORTED_REASONING_EFFORT`。selectModel 时机只弹 UI，**不进会话日志**；
诊断靠「下一个成功请求头」的 `adapterDefaults`（只有 `{"maxTokens":true}` 而无
`reasoningEffort:true` = 宿主当时手里是无档位元数据的兜底目录）。

### 修复（两处独立生效，缺一仍有窗口）

- `lib/upstream.js`：兜底表补齐 `reasoningLevels: ['low','high','max']` /
  `defaultReasoningLevel: 'max'`（与上游目录 2026-10-25 实测一致）。⚠ 以后改兜底表
  必须带档位元数据 —— `fallback-models.test.mjs` 看门（含宿主校验链仿真）；
- `lib/assemble.js`：拉取失败时**先返回过期缓存再落兜底表**。过期缓存元数据结构
  完整（只是内容旧），兜底表只给从未成功过的冷启动用。

### 诊断手法（备查）

- 会话日志 zstd 是**多帧拼接**，按 magic `28 B5 2F FD` 分帧逐段解压；
- `request/header` 的 `adapterDefaults.reasoningEffort: true` 表示宿主把该档位
  当作**默认值**注入（目录有元数据且用户未显式选档）；显式选档时它在 `config` 里。

## 0.4.3 — 图片输入：宿主持久引用 → 附件服务字节 → Anthropic base64

### 症状

Web UI 输入框上传图片后，模型表现「看不见图」（GLM-5.3-Flash 报当前模型不支持，
或带图消息发出后回答与图片无关）。

### 根因（两层，都源自宿主契约误判）

1. **图片块被静默丢弃（主因）**。宿主传给适配器的 image 块是**持久引用**形态
   `{ type: 'image', attachment: ImageAttachmentRef }`（`dsh-llm` 的 `ImageBlock`，
   rc.3 `.d.ts` 钉死），ref = `{ attachmentId:'sha256:<hex>', mediaType, width, height, bytes, name? }`
   （`dsh-attachment-local` 实测）。而 `convertContent()` 只认
   `{ source: { type: 'base64' | 'url' } }` 内联形态 —— 引用块两个分支都不命中，
   **图片无声消失**，上游收到的请求根本没有图。官方 `dsh-llm-deepseek` 的同款链路是
   `ctx.get('attachments')` → `attachments.readImageRequest(ref, target)` 拿确定性请求
   版本字节 → `Buffer.from(version.data).toString('base64')` 编成 Anthropic 块。
2. **能力声明缺口**。模型目录 `capabilities.vision` 决定 `inputModalities`：
   实测 `GLM-5.3-Flash` 为 `vision:true`，`GLM-5.3` 为空。宿主
   `dsh-api-session-controller` 在 prompt 准入时对声明不含 `image` 的模型直接拒
   （`MODEL_DOES_NOT_SUPPORT_IMAGES` → UI「当前模型不支持图片」）。GLM-5.3 发图
   必被宿主拒绝 —— 这是目录事实，不是本插件 bug；带图请改用 GLM-5.3-Flash。

### 修复

- `lib/anthropic-body.js`：新增 `imageOccurrences()`（识别引用/内联两种形态）、
  `imageBlockFromAttachment()`（字节 → base64 块，带无 Buffer 兜底）、
  `resolveImages()`（经附件服务解析引用，单张失败只降级不拖垮请求）；
  `convertContent()` 对查不到字节的引用给**占位文本**（不再静默丢弃）；
- `lib/plan-client.js`：组 body 前先 `resolveImages()`，字节经
  `resolvedImages` 传入 `buildUpstreamBody()`；
- `lib/assemble.js`：惰性回调 `() => ctx.get('attachments')` 交给 plan-client。
  ⚠ 附件服务**刻意不进 `inject`**：cordis 的 inject 是硬依赖（声明的服务缺席时
  fiber INACTIVE，插件整体不加载）；沙箱 façade 的 `ctx.get(name)` 允许未声明服务
  的只读查询（`dsh-cordis-host-runner` 的 `sandboxContext` 实证），缺席时图片降级
  占位文本，主功能不受影响。

### 测试

101 个用例全过（新增：两种图片形态识别、base64 编码、解析失败占位、附件服务
缺席/单张失败容错、端到端引用图片进入上游请求体）；`smoke-install` 26 项 PASS。
真实账号端到端：1×1 PNG 经完整链路发上游，HTTP 200 + 全事件流，模型正确报出
图片颜色（"Maroon"）。

## 0.4.2 — 面板布局：统一行置顶 + 账号区方块

- 「统一选号」行移到面板最顶上（标题行之下、添加账号之上），右侧开关与
  账号卡片的开关右对齐（`padding-right` 补偿卡片边框+内边距）；
- 全部账号卡片包进一个带边框的方块（`zsp-group`），与「添加账号」虚线框
  同一套边框样式；
- 去掉统一行的说明文本与卡片上「模型栏」文字标签：开关语义由 title
  悬停提示承担；
- 账号卡片的「使用/删除」操作按钮行尾部加一个 30px 占位（与开关同宽），
  按钮右缘与标题行右侧开关右对齐。

## 0.4.1 — 每栏右侧的「模型栏」开关

0.4.0 的统一栏位开关是一颗按钮；本版改成**每一栏最右侧一颗开关**
（iOS 风格 toggle），各自控制自己是否出现在模型选择器里：

- 面板布局 = 选择器布局：每个账号卡片标题行最右侧一颗「模型栏」开关；
  底部「统一选号」说明卡最右侧同款开关；
- 隐藏的卡片整体降透明度（`data-hidden`），状态一目了然；
- 数据通道：`POST /model-list-visible {id, visible}`（单账号栏位）、
  `POST /unified-list {visible}`（统一栏位，0.4.0 已有）；
  `/summary` 的每账号视图带 `modelListVisible`；
- 持久化：`settings.json` 新增 `hiddenModelLists`（被隐藏栏位的账号 id
  数组，默认空 = 全显示），重启后恢复；
- **隐藏 ≠ 停用**：栏位隐藏只是从模型列表里收起（空目录），路由仍在、
  钉定请求照常 —— 已选着该栏的旧会话不中断；停用仍走账号卡片的启停。

测试：93 个用例全过（新增 `setAccountVisible` 空目录/请求不受影响、
`/model-list-visible` 路由回调与校验）。

## 2026-10-25 — zcode-cli-adapter：接入 ZCode CLI + 非流式端点截断修复

### 新增 `zcode-cli-adapter/`（三个独立脚本，零新协议代码）

把 ZCode CLI（开源版，本机 v0.17.0）接到本项目的免费 plan 通道。原理与
bonus-plan-4-open-zcode 一致（本地 Anthropic 端点 + ZCode 自定义供应商），但
全部复用现有 `lib/`：

- `server.mjs`：独立进程跑 `lib/local-endpoint.js` 的 `/v1/messages` +
  `ZcodePlanClient`（无需 DSH 在跑）。端口 17899 被占自动回退随机并落盘
  `cli-endpoint-port.txt`；token 走 `resolveEndpointToken`（环境变量 → 文件 →
  新生成），**必须持久化** —— CLI 配置里的 baseURL/apiKey 指向它们；
- `register-provider.mjs`：往 `~/.zcode/v2/config.json` 的 `provider` 表原子
  写入 `custom:dsh-zcode-startplan`（`kind: "anthropic"` + `options.baseURL`
  + `models`，schema 已从官方 bundle 的 Zod 定义核实，passthrough 容错）。
  只动 provider 表、`.bak` 备份 + 同目录 rename、幂等；
- `import-zcode-credential.mjs`：从 CLI 登录态（`credentials.json` /
  config 里 JWT 形 apiKey）导入账号入池，`pool.add` 按 user_id 去重，
  device_mid 现场生成（独立设备标识，与 CLI 原生通道互不干扰）。

数据目录默认与 DSH 插件**共用**（`~/.dsh/zcode-start-plan`，SQLite WAL 多进程
安全）；DSH 插件的本地端点与本适配器默认都抢 17899，**同一时间只开一个**。

### 修复：本地端点非流式响应被截断成开头几个字（`lib/local-endpoint.js`）

`plan-client.call()` 返回的 `head` 只是**首帧切片**（读到首帧就返回，好尽早
判定零内容/业务错误），正文增量全在 `decoder` 里。流式分支正确消费了 decoder，
非流式分支只折叠了 head —— 回答被截成开头几个字（实测 `"The"`），usage 全 0。
pi-ai 路线几乎总走流式所以一直没暴露；ZCode CLI 的非流式请求一发即中。

修复：非流式先读干 decoder 余量再折叠。测试套件 92/92 通过。

### 实测（真实账号端到端）

非流式 200 完整回答 + usage；流式 SSE 事件序列完整（上游 keepalive `ping`
帧正确透传）；`--status` / 401 / 空池 500 + Anthropic 形错误均符合预期。

## 0.4.0 — 每账号一个 provider 栏位（workbuddy 模式）+ 统一选号开关

0.3.0 把钉定做在模型 id 上（`GLM-5.3@acct:<id>`）；本版改成 workbuddy 的
形态：**每个账号一个独立 provider 栏位**（`ZCode Start Plan · 主号`），
模型选择器里一栏一个账号，栏内模型固定消耗该账号额度。统一选号栏位可在
插件面板一键隐藏/恢复。

### 多路由注册（`lib/assemble.js`）

- **一个 adapter 实例服务整组路由**：`zcode-start-plan`（统一选号）+
  每个启用账号一条 `zcode-start-plan-acct-<账号id>`；
- 照抄 workbuddy 的可见性机制（`@venshell/dsh-workbuddy-connect` 源码实证）：
  provider **无条件注册**，隐藏栏位 = `listModels` 返回**空数组**
  （宿主过滤没有模型的分组）—— 路由始终可达，老会话不断，登录/开关在
  启动后发生也不需要重新注册；
- 账号增删/启停/统一栏位开关 → `registerAdapter` 返回的
  **`handle.replace(routes)` 原子换路由**（rc.3 的
  `AdapterRegistrationHandle.replace`，`commitRoutes` 内自动广播
  `llm/adapters-updated`，模型选择器随即重拉）。

### 路由级钉定（`lib/adapter.js` / `lib/plan-client.js`）

- `stream(options)` 按 `options.provider` 判定账号栏位，向 plan-client 传
  `pinnedAccountId`；钉定优先级：**provider 路由 > `@acct:` 后缀**；
- `providerInfo` 对账号路由返回「ZCode Start Plan · 昵称」（宿主
  `prepareRoutes` 硬契约：`info.id === provider` 且 name 非空 —— 已删账号
  也回退出合法 name）；
- `listModels(provider)`：账号栏位 = 基础模型目录 + description 带该账号的
  额度/限流状态；停用/删除的账号 = 空目录（栏位隐藏）；
- `resolveModel` 的 `id` 与请求**原样一致**（`normalizeModelInfo` 的
  `INVALID_MODEL_INFO` 硬契约），0.3.0 的 `@acct:` 后缀 id 仍原样放行；
- plan-client 路由级钉定与 0.3.0 语义一致：绝不换号、额度尽报 QUOTA
  （消息带账号昵称）、先标「账号×模型」限流再报错。

### 统一选号开关（面板）

- 插件详情页新增「隐藏/显示统一选号栏位」按钮；隐藏后模型列表只留
  每账号一栏，统一路由保留（空目录），老会话不受影响；
- 状态持久化在 `<dataDir>/settings.json`（`unifiedModelList`），坏文件按
  默认值（显示）处理；管理路由新增 `POST /unified-list {visible}`，
  `/summary` 返回 `unifiedModelList` 字段。

### 配置更名

- `pinnedAccounts` → `accountProviders`（同义更名；**旧名仍被接受**，
  新名优先）。0.3.0 的 `@acct:` 模型 id 编码不变，老会话继续可用。

### 测试

- 92 个用例全过（多路由派生互逆、providerInfo 契约、空目录可见性、
  路由级钉定发对凭据、`@acct:` 兼容、QUOTA 不换号、开关路由回调）。

## 0.3.0 — 模型列表直选账号额度（钉定账号条目）

在 DSH 模型选择器里为每个启用账号生成「模型 · 账号昵称」条目（如
`GLM-5.3 · 主号`），选中即只消耗该账号的额度 —— 多会话可以同时各吃各的账号，
不再只有一个「置顶顺序」。

### 模型 id 编码（`lib/pinned-model.js`）

- 钉定条目 id：`<基础模型id>@acct:<账号id>`（如 `GLM-5.3@acct:<uuid>`）；
- 上游只见基础模型 id；`@acct:` 对上游/宿主/持久化三方无歧义，
  **编码一经发布不可更改**（会话里保存的模型名会失效）；
- 宿主契约（rc.3 `dsh-llm` 源码核实）：`listModels` 只要求 `id` 非空且
  全表不重复（`INVALID_CATALOG`），`normalizeModelInfo` 要求
  `resolveModel` 返回的 `id` 与请求原样一致（`INVALID_MODEL_INFO`）——
  复合 id 两条都满足。

### 选号（`lib/plan-client.js`）

- 钉定模式：`#pickPinned` 只取指定账号，**绝不换号**；账号缺失 / 停用 /
  凭据不可用 / 该模型限流中都以明确报错收场（各自给出路），不静默回退 ——
  回退会让「钉定」名存实亡；
- 额度耗尽（1005/1113、200 但零内容、body 为空）→ 标记该账号×模型限流
  （与面板一致）→ 报 QUOTA，消息里带账号昵称与上游原文；
- 自动模式行为不变（手动顺序、逐个试到有产出）。

### 目录与刷新（`lib/adapter.js` / `lib/assemble.js` / `lib/manage-routes.js`）

- `listModels` = 基础模型 +（启用账号 × 基础模型）钉定条目；description
  带「只消耗某账号额度 / 限流至 HH:mm」提示；停用账号不出条目；
- 账号变更（面板增删/启停/置顶/改名/登录入池）→ 管理路由 `onChanged` →
  `ctx.llm.emitAdaptersUpdated()` → 选择器自动重拉模型目录；
- `AccountPool.get(id, { withCredentials })` 新增（plan-client 按钉定 id 取号）。

### 配置

- `config.pinnedAccounts`（默认 `true`）：关掉后模型列表回到只有基础模型。

### 测试

- 88 个用例全过（新增 `tests/pinned-models.test.mjs`：编解码、目录契约、
  resolveModel 幂等、钉定只打一发、额度尽报 QUOTA 不换号、账号已删不回退）。

## 2026-10-24 — 适配 dsh 0.2.1-rc.3：finish chunk 形状修正

### rc.2 → rc.3 差异审查结论

对插件触达的全部宿主包（`dsh-llm` / `dsh-tools` / `cordis` / `cordis-plugin-loader` /
`cordis-plugin-timer` / `dsh-host-webserver` / `dsh-llm-pi-ai` / `dsh-llm-retry` /
`dsh-client-ui-renderer` / `dsh-client-ui-plugin-manager` / `schemastery` / `cosmokit`）
做了 rc.2 与 rc.3 的全量 `.js` SHA256 对比：**运行时零差异**。rc.3 只是补齐
`.d.ts` 类型声明 —— 所以本次「适配」的实质是：用官方类型把此前靠猜的契约钉死，
修正其中一处不一致。`peerDependencies` 抬到 `^0.2.1-rc.3`（includePrerelease 语义下
该区间继续覆盖同族的后续 rc）。

### finish chunk 形状（修复点）

官方 `FinishReasonMap`（`dsh-llm/lib/types/types.d.ts`，rc.3 新增）钉死终止块契约：

```
{ type: 'finish', reason: FinishReason }
FinishReason =
  { kind: 'stop' } | { kind: 'tool-calls' } | { kind: 'max-tokens' }
| { kind: 'aborted', failure } | { kind: 'error', failure }
```

- 宿主 `BlockAssembler` 读 **`chunk.reason`**（`this._finish = chunk.reason`），
  agent-loop 再按 `finish.kind === 'error' | 'aborted'` 判错。
- 之前发的是 `{ kind: 'error', failure }`（kind 在顶层、没有 `reason` 包裹）：
  宿主读到 `reason === undefined` → 默认 `{ kind: 'stop' }` ——
  **流内错误被静默吞成正常结束**，重试与错误上报全部失效。正常路径碰巧能跑
  （`undefined.kind` 不落入错误分支），所以一直没暴露。
- 修复：`stream-translator.js` 的 `finish()` / `mapStopReason()` 与
  `adapter.js` 的 catch 路径统一改为 `reason` 包裹对象；
  `mapStopReason` 返回 `{ kind: 'max-tokens' }` 等对象（此前返回 `'length'`
  这类字符串，且 `'length'` 不是合法 kind —— 宿主的合法值是 `'max-tokens'`）。
- 契约级测试（`tests/assembler-contract.test.mjs`）新增断言：
  `finish.kind` 必须为 undefined（kind 只能在 `reason` 里）。

### rc.3 类型文档揭示的可选能力（暂不用，留档）

- `AdapterRegistrationHandle.replace(providers)`：原子换路由，将来配置热改可省
  「先撤销再注册」的空窗；
- `LlmResolvedModelInfo.systemPromptUpdate: 'in-history'`：若上游确认改 system
  不破缓存，声明它可改善长会话缓存命中；
- `TokenUsage.totalTokens` / `reasoningTokens`：可选补全用量字段。

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
