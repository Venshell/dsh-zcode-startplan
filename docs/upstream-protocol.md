# 上游协议硬约束（来自实测，不要"优化"）

README 只留清单，本文记录每条的**症状、机制与本插件的处理**。
带「实测」的条目在 CHANGELOG 里有对应验证记录。

## 3012 准入：身份块与日期块

| 现象 | 后果 | 本插件的处理 |
|---|---|---|
| `system` 不以**官方身份块**开头 | `3012 unusual activity`，**有账号冷却惩罚**（30 分钟；24h 内第 3 次起 24 小时；5 次停用） | `lib/anthropic-body.js` 逐字复刻 cliPrefix + stable 段，调用方 system 追加在最后 |
| 首轮 user 消息缺 `<system-reminder>` 日期块 | 同上（3012） | 幂等插入到**内容数组**最前面 |

身份块文本出处：开源 [ZCode](https://github.com/zai-org/ZCode) 的
`identity.ts`（Apache-2.0，逐字）。**上游策略与身份块结构强耦合**：官方客户端
升级后若改了结构，需同步 `lib/anthropic-body.js`，否则重新出现 3012 ——
**不要为调试反复触发 3012**。

## captcha 时序

| 现象 | 后果 | 处理 |
|---|---|---|
| 每次请求都产出 captcha | 白耗设备信誉与 0.5–7 秒 | 先不带，被 `3007` 拒才产出（「要了才取」），成功则清 2 分钟记忆 |
| 同一 captcha param 复用 | 必 `3007` | 每轮重试都重新产出 |
| 普通浏览器 / `about:blank` 出 captcha | 二次 mint 必 F001 | 用**真实 https origin** 的离屏 iframe（宿主 Electron，CDP） |

## 错误码语义（混用会带错排查方向）

| 码 | 语义 | 处理 |
|---|---|---|
| `3007` | captcha 校验失败 | 换新 param 重试（最多 2 次），**不换号** |
| `3009` | 并发限流（瞬态） | 60s **忙标记**（软优先级）+ 退避 1500/3000ms，穷尽换号；**不当成额度限流落库** |
| `3012` | 风控（账号冷却惩罚递进） | **绝不重试**；免费腿撞了自动切 coding-plan（分支功能） |
| `1005` / `1113` | 额度/资源包用尽 | 标记限流到当日 24:00（UTC+8），换号 |
| `401` / `1002` | 凭据失效 | 重新登录，换号救不了 |

忙账号被后续请求反复撞会让并行会话的退避**串行叠加**直至全部超时 ⇒
选号两档：先取不忙的（`pool.pick` 第一档），全忙才回落排队。

## 200 里包裹业务错误

本渠道实测会返回 `HTTP 200 + application/json + {"code":1005,...}`，
以及「200 但零内容」。直接透传的后果：错误码被当成空响应丢掉、账号被反复使用、
用户看到空回答。`lib/sse.js` 先读首帧识别 `{code,msg}` / `{type:error}` / 裸 `{error}`，
按错误表处置后再决定换号或报错。

## 图片与模型能力

| 现象 | 后果 | 处理 |
|---|---|---|
| DSH 的 image 块是**持久引用**（`{type:'image', attachment:ref}`），不是 base64 | 只认内联 base64 会把图片**静默丢弃** | 组 body 前经附件服务 `readImageRequest` 解析成字节再编码（`ctx.get('attachments')` 探测，刻意不进 inject —— inject 是硬依赖，服务缺席会挂起整个插件） |
| 上游模型目录 `capabilities.vision` 决定图片能力 | 宿主对声明不含 `image` 的模型直接拒带图消息 | `GLM-5.3-Flash` 实测 `vision:true` 可传图；`GLM-5.3` 为空，带图请换 Flash |
| 非流式 JSON 用 SSE 特征串判内容 | 正常回答被判空 → **账号被错误标记限流** | 按 content-type 分流，JSON 走结构解析 |

## 时间与渠道

- `expires_at` **当毫秒用** → 刚点登录就"授权超时"。`toEpochMs()` 按数量级归一（秒/毫秒）
- 非法渠道 provider → 上游 500 `code:1000`。渠道白名单（`bigmodel` / `zai`）在激活期就拒

## 领取与活动发现

| 现象 | 后果 | 处理 |
|---|---|---|
| 领取前不补活跃上报 | `preview` 恒为空 → 永远"没得领" | 每次查 preview 前先发 `app_launch` + `app_daily_active` |
| 靠 `/billing/preview` 探测活动 | 1024 这类活动**只在 marketing/touch 里**（preview 恒空，与「没活动」同形） | 双来源合并（0.8.0） |
| marketing/claim 用旧版本号 | `1004 no permission` / 投放恒空（`3.14.3` 实测） | 版本门控：`X-ZCode-App-Version` ≥3.16.3（凭据版本取较大者）；**推理路径不抬**（3012 消融矩阵在 3.14.3 取的） |
| plan 元数据只读按钮路径 | 投放改版后静默失效（少报额度、不发回执） | 递归扫描投送物（深度上限 8）——元数据镜像在 background.args / success_popup.hero.args 等多处 |
| `grant_units` 只取第一条 | 1024 活动两条 entitlement（3 亿+2 亿），**少报 2 亿** | 按 unit_type 求和（不同单位不混加） |
| confirm 回执乱发 / 不发 | 失败时发 = 叫服务端别再投了（白丢机会）；不发 = 服务端重复投放（每轮烧 captcha） | **只在 `0`/`1003` 后发 `confirm`** |
| 自动领取不记已领集合 | 投放持续数天，每轮白烧 captcha 吃 1003 | `0`/`1003`/`1005` 终态码持久化（`auto-claim-state.json`） |
| `app_version` 脏值（含换行注入） | `Headers()` 抛 TypeError，整条请求未分类失败 | semver 白名单（`/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/`） |

## 转发头对齐（0.8.0）

官方 GUI 的一次 `/v1/messages` 带 **18 个头**。此前只发 10 个，两个值不符：

| 头 | 官方 | 旧值 |
|---|---|---|
| `x-release-channel` | `production` | `stable` ✗ |
| `x-platform` | `win32-x64` | `win32` ✗ |

并缺 7 个官方每次都带的头：`x-title` / `x-os-version` / `x-zcode-agent` /
`x-session-id` / `x-zcode-session-type` / `x-request-id` / `x-zcode-trace-id`。

- 2026-10-23 上游升级 3.16.3 后 `405 + unusual activity` 在**所有**插件请求上稳定出现
  （跨账号、跨会话），官方客户端同账号同网络正常 ⇒ 头的形状是首要指纹
- `X-Session-Id` **每账号一个、进程内稳定**（⚠ 不能做成模块级常量：那会让池里所有账号
  共用一个 session id，上游可把多账号轮换关联成「同一会话」—— 没有任何真实客户端
  会产出这种关联）
- `X-Request-Id` / `X-ZCode-Trace-Id` 每请求新 UUID（官方语义）
- coding-plan 通道**不带** `HTTP-Referer`（zcode.z.ai 专属头，发到 api.z.ai 无意义）

## 凭据与业务码解析

- 业务码必须认**纯数字字符串**：`num()` 只认 number ⇒ 上游回 `{"code":"3012"}`
  时风控码整条丢失（`msg` 不含数字时连扫正文都救不回来）
- 读响应体必须整段包住：`fetch` 返回非 Response（自定义实现可能出现）时
  `response.text` 的**属性访问**就同步抛，`.catch` 挂不上
- `zai` 渠道登录的 access_token 在 `data.zai.access_token`（**通用第三方凭据分支**），
  不解析它 ⇒ 该渠道账号的 coding-plan 通道永久不可用（0.9.1 修）
