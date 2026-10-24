# 诊断报告：长上下文下工具调用参数丢失

- **日期**：2026-10-24
- **环境**：DSH profile `desktop`，插件 `dsh-zcode-startplan@0.1.0`（源码即本仓库）
- **模型通路**：`zcode-start-plan/GLM-5.3-Flash`（GLM-5.3 / reasoningEffort=max）
- **状态**：P0 两处代码问题已修复并通过定向回归测试；长会话实测待验证
- **排查方法**：bug-diagnose 流程（现象 → 复现 → 证据 → 可证伪假设 → 根因 → 修复方案）

---

## 2026-10-24 修复记录

- 历史 `tool-call.arguments` 为 JSON 字符串时，出站 `tool_use.input` 现转换为对象。
- 流式 `tool_use` 只有 `content_block_start.input` 时，结束块现保留内联参数；若后续收到 `input_json_delta`，以完整增量为准。
- `node --test tests/anthropic-body.test.mjs tests/stream-translator.test.mjs tests/assembler-contract.test.mjs`：25/25 通过。
- 全套测试仍被本工作区另一个未提交文件 `lib/manage-routes.js:228` 的顶层 `return` 阻断；这是账号池管理面板的语法错误，与本次参数链路改动无关。
- 尚未在 DSH 长会话中复现后验收，也未捕获真实出站请求体；下文对长上下文退化的因果解释仍为待验证假设。P1-3 的完整 JSON message 路径未在本次处理。

---

## 现象

- **期望**：模型发起的工具调用带完整参数（`description`、`command` 等）到达执行器。
- **实际**：执行器收到**合法空对象 `{}`**，报：
  ```
  invalid arguments: missing required property "description"; missing required property "command"
  ```
- **关键形态**：错误是「空参数对象」而不是「JSON 解析失败 / 截断」——说明参数在链路中被
  **整体替换成了 `{}`**，而不是流损坏。
- **触发条件**：会话变长后高频出现；短会话几乎不复现。
- **波及面**：以 `pwsh`（必填参数最多、对象嵌套最深）最明显；`read` / `glob` / `grep`
  同期正常（参数少且扁平）。

## 复现步骤

1. 长会话（几十轮工具调用之后）继续让模型调用 `pwsh`；
2. 观察执行器报 `invalid arguments: missing required property …`。
3. **活体复现**：2026-10-24 的排查会话本身即运行在该插件通路上
   （`zcode-start-plan/GLM-5.3-Flash`），排查过程中 `pwsh` 调用连续 40+ 次参数为空，
   同一会话内 `read` / `glob` / `grep` / `write` 全部正常 —— 满足「同一二进制、同一配置，
   只换工具复杂度这一个变量」的对照条件。

## 证据

### 证据 1（活体样本，最强）

排查会话中执行器真实收到的参数为 `{}`（错误原文见上）。模型侧实际生成了带 `description`
与 `command` 的调用（同一会话早些时候同类调用成功过），参数在**到达执行器之前**丢失。

### 证据 2（代码级：历史回放的协议违例 —— 主因）

`lib/anthropic-body.js` 的 `convertContent()`，`tool-call` 分支：

```js
case 'tool-call':
  out.push({
    type: 'tool_use',
    id: block.id ?? `toolu_${Math.random().toString(36).slice(2)}`,
    name: block.name,
    input: block.arguments ?? block.args ?? {},   // ← 违例点
  })
```

- DSH 的 `BlockAssembler` 产物中 `arguments` 是**原始 JSON 字符串**
  （`tests/assembler-contract.test.mjs` 契约测试：「工具参数是原始 JSON 字符串（宿主不做解析）」）；
- Anthropic Messages 协议要求 `tool_use.input` 是**对象**；
- 因此历史里的每一条 assistant `tool_use` 都以 `"input": "{\"command\": ...}"`（字符串）
  形态回放给上游 —— **协议违例**；
- 每多一轮工具调用，坏样本就多一条：**违例量与上下文长度线性相关**，与「长上下文才出现」吻合。

### 证据 3（代码级：内联 input 被丢弃 —— 副因）

`lib/stream-translator.js` 的 `push()`，`content_block_start` 的 `tool_use` 分支：

```js
if (block.type === 'tool_use') {
  return [{ type: 'block-start', index: chunkIndex, blockType: 'tool-call' }]
}
```

`content_block.input`（上游把完整参数内联在 start 块里的形态，GLM 兼容层存在此形态）
被完全忽略。若上游只发内联 `input` 而不发 `input_json_delta`，
`#assembleBlock()` 会把 `entry.arguments ?? ''` 兜底成 `'{}'`：

```js
let args = entry.arguments ?? ''
if (args.length === 0) args = '{}'
```

产物 = 空参数对象 → 与执行器错误形态**精确吻合**。

### 证据 4（机制解释：为什么短上下文没事）

短会话里被污染的历史 `tool_use` 样本少，模型能主要从 `tools` 定义恢复正确的调用格式；
长会话里几十条 `"input": "{…}"`（字符串形态）的坏样本累积，模型对自身调用格式的
in-context 模仿退化 → 输出空参数/坏参数。这解释了「参数少且扁平的工具没事、
参数多的工具先出事」的梯度。

## 假设与验证结果

| # | 假设 | 预测 | 验证状态 |
|---|------|------|----------|
| A（主因） | 历史回放 `tool_use.input` 为字符串，污染长上下文中的格式学习 | 抓出站请求体：assistant 消息里 `input` 是字符串 | 代码级确证（证据 2）；出站抓包未做（受排查会话调用次数限制） |
| B（副因） | `content_block_start` 内联 `input` 被丢弃 → 单次调用参数为 `'{}'` | 执行器收到 `{}` 且无解析错误 | 与错误形态精确吻合（证据 1+3）；未做逐次对应 |
| C（已排除） | SSE 解码丢事件（chunk 边界 / EOF flush） | 丢参数伴随丢文本/丢整块 | 已排除：`sse.js` 已有 TextDecoder flush 修复与测试；且症状是「空对象」不是「截断」 |
| D（已排除） | 宿主 BlockAssembler 契约错配（blockType/argumentsDelta） | 组装直接抛错或整块丢失 | 已排除：契约测试 `tests/assembler-contract.test.mjs` 全绿，字段名严格对上 |

## 根因

1. **`lib/anthropic-body.js` `convertContent()`**：回放 tool-call 时未把 JSON 字符串
   parse 成对象（协议违例，长上下文退化的主因）。
2. **`lib/stream-translator.js` `content_block_start(tool_use)`**：未消费内联
   `content_block.input`（单次调用参数变 `'{}'` 的直接来源）。

## 修复方案（未实施）

**P0-1（已实施）** `lib/anthropic-body.js` `convertContent()`：

```js
function safeParseArguments(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return {}
  try { const v = JSON.parse(raw); return typeof v === 'object' && v !== null ? v : {} }
  catch { return {} }
}
// tool-call 分支：
input: safeParseArguments(block.arguments ?? block.args)
```

**P0-2（已实施）** `lib/stream-translator.js`：`content_block_start(tool_use)` 分支记录内联参数：

```js
if (block.type === 'tool_use') {
  const entry = { chunkIndex, kind: 'tool_use', id: block.id, name: block.name, text: '' }
  if (block.input !== undefined && (typeof block.input !== 'object' || Object.keys(block.input).length > 0)) {
    entry.arguments = JSON.stringify(block.input)
  }
  this.#blocks.set(index, entry)
  return [{ type: 'block-start', index: chunkIndex, blockType: 'tool-call' }]
}
```

并保证 `content_block_delta(input_json_delta)` 到来时**覆盖/衔接**内联值（上游若补发
delta 则以 delta 为准：首个 delta 到达时若 `entry.arguments` 已由内联写入且 delta 语义为
"从头开始"，应重置为空再拼接——按实测上游行为定，默认保守做法：有内联且无任何 delta 时才用内联）。

**P1-3** `stream-translator.push()` 支持「完整 `message` 对象」（`type === 'message'`）：
`lib/sse.js` 的 jsonMode 路径把整个 message 作为单个事件交给 translator，
但 `switch (data.type)` 命中 `default` 直接丢弃——上游若对 `stream:true` 回 JSON，
响应会整体变空。当前 `buildUpstreamBody` 固定 `stream: true`，风险低但值得补。

**P1-4** 回归测试：
- `tests/anthropic-body.test.mjs` 增加：DSH 历史 tool-call（arguments 为 JSON 字符串）→
  出站 `tool_use.input` 为**对象**；
- `tests/stream-translator.test.mjs` / `assembler-contract.test.mjs` 增加：
  只有内联 `input` 无 `input_json_delta` 的流 → block-end 的 `arguments` 为该内联参数的
  JSON 字符串，而非 `'{}'`。

## 验收标准（待执行）

```powershell
node scripts/run-tests.mjs   # 或 npm test —— 全部通过
```

1. 上述新增回归测试通过；
2. 原始复现路径不再复现：在长会话（≥ 40 轮工具调用）中连续 `pwsh` 调用，
   执行器不再收到空参数；
3. 既有测试（assembler-contract / stream-translator / sse / e2e）无回归。

## 未闭合风险

- 未做**出站抓包**对 A/B 做比例归因（受排查会话的工具调用次数限制：每轮最多 2 次）；
  若修复后长上下文仍偶发丢参，抓 `ZCODE_PLAN_MESSAGES_URL` 的请求体核实 GLM 兼容层
  的块形态（是否真有「只发内联 input 不发 delta」的流）。
- P1-3（jsonMode 丢整包）未验证上游是否真的会出现；代码层风险确证，行为层未观测。
- 修复 P0-1 后，历史里「本来就是坏样本」的旧会话无法自愈（已经写进会话存储）；
  新会话从第一轮起即为正确形态。

## 附录：本会话观测时间线（节选）

- 排查会话运行于本插件通路（`zcode-start-plan/GLM-5.3-Flash`），runtime context 确认。
- 会话前期 `pwsh` 调用正常；自上下文增长后，`pwsh` 连续报
  `invalid arguments: missing required property "description"; missing required property "command"`。
- 同期对照组：`read`（1 个必填 string 参数）、`glob`、`grep`、`write` 全部成功 ——
  排除「执行器/宿主整体故障」，指向「参数对象越大越容易丢」。
- 受「重复调用防护」影响，排查会话后期每轮仅能执行 2 次工具调用，
  抓包验证留待修复会话执行。
