# 2026-11-03 ~ 11-10 排查记录：活动列表为空与领取链路

> 本文件记录一次跨 8 天的完整排查：用户报「有活动但活动列表没有」。
> **结论先行**：根因是**服务端版本门控从 `3.16.3` 抬到 `3.17.2`**，旧常量让
> `marketing/touch` 恒返回空投放。排查过程中有多次错误归因，一并记录在末尾，
> 避免下次重复走弯路。

---

## 1. 症状

| 现象 | 用户视角 |
|---|---|
| 面板活动列表为空或只有一行无名灰字 | 「明明有活动，插件说没有」 |
| 官方 ZCode 客户端首页能看到活动、能领 | 「客户端有，插件没有」 |
| 直接 claim 返回 `1004 no permission` | 「是不是账号没资格」 |
| 领完之后按钮不变灰 | 「领了还能再点」 |
| 自动领取拨盘开着但从不生效 | 「自动领取是坏的」 |

---

## 2. 根因（按重要性）

### 2.1 【主因】版本门控被服务端抬高

**实测（2026-11-10，同账号同 `device_mid` 消融）**：

```
账号       3.16.3   3.17.2   3.18.0
Venshell     0         1 ★      1 ★
森也          0         1 ★      1 ★
baqkh937     0         1 ★      1 ★
Ye Send      0         0        0      ← 已领过，服务端撤投放
```

`marketing/touch` 必须带 `X-ZCode-App-Version >= 官方当前版本` 才有投放。
门控历史：`3.14.3` → `3.16.3` → `3.17.2`，**每次官方发版都会抬高**。

`deliveries: []` 与「本来就没活动」在响应里完全同形，客户端无法区分。

### 2.2 领取记录的字段位置

`billing/balance` 的唯一真实来源是 `data.plans[]`：

```json
{
  "plan_id": "zcode-v3-start-plan-1110-nt",
  "name": "ZCODE GLOBAL BUILD",        ← 活动名
  "status": "active",
  "starts_at": 1794308400,             ← 秒
  "ends_at": 1794358800,               ← 秒
  "entitlements": [{
    "show_name": "GLM-5.3-Flash",       ← 模型名，不是活动名
    "unit_type": "token",
    "grant_units": 300000000,
    "effective_at": 1794322800          ← 秒；> server_time 即「待生效」
  }]
}
```

⚠ **上游没有顶层 `pending` 数组**。曾有一版实现把它当成上游字段去扫，那是把
插件自己派生的 `balance.pending`（`fetchBalance` 从 entitlements 算出的未生效额度）
误认成服务端数据。

⚠ 多条 entitlement 要**按 `unit_type` 求和**（0.6.x 的 1024 活动是「3 亿 + 2 亿」，
只取第一条会少报 2 亿）；单位不同不混加。

### 2.3 领取成功后服务端立刻撤投放

领取成功 → `marketing/touch` 对该账号 `deliveries` 归零。
所以「已领账号」在投放源里永远看不见，必须靠 `billing/balance` 的 `plans[]` 回填。

---

## 3. 已修复

| # | 问题 | 修法 | 位置 |
|---|---|---|---|
| 1 | 门控常量随官方发布过期 | 内置常量 + **启动时抓官方版本抬高**（只抬不降） | `lib/version-probe.js`、`lib/upstream.js`、`lib/assemble.js` |
| 2 | 领取记录解析不完整 | `fetchClaimedPlans` 扫 `data.plans[]`，按 unit_type 求和，`effective_at` 归一 | `lib/upstream-api.js` |
| 3 | 回填丢元数据 | 带 `name/unitType/grantUnits/effectiveAt/expiresAt/pending` | `lib/manage-routes.js` |
| 4 | 回填误收订阅 plan | 恢复 `^zcode-v3-start-plan-` 前缀白名单 | `lib/manage-routes.js` |
| 5 | 「探测失败」与「确实没有」不可区分 | `/claimable` 增 `sources:{campaign,records}`，面板三态文案 | `lib/manage-routes.js`、`client.js` |
| 6 | 领完按钮不变灰 | 领取后**重新探测**（`catch` 分支也探，兼容幂等 1003） | `client.js` |
| 7 | 自动领取从不运行 | `ctx.timer.interval` 首轮要等满周期 → 改 **60 秒心跳**做「到点了吗」判定；拨开关立即跑一轮 | `lib/assemble.js`、`lib/manage-routes.js` |

`npm test`：**262/262 通过**。

---

## 4. 未验证 / 已知风险

| 项 | 状态 | 说明 |
|---|---|---|
| WSL param 能否跨环境使用 | ❓ 未测 | WSL Linux Chrome 能产出（4.1s，280 字符），但 param 是否绑定 `device_mid` 未知 |
| `1004` 的确切触发条件 | ❓ 未定论 | 官方文案含「账号资格」与「客户端版本」两类；版本门控是最可能的解释 |
| 活动是否按账号分配 | ✅ 已确认 | 四个账号 `plans[]` 只有 Ye Send 有记录 → 换设备领不到未分配的账号 |
| 投放是否按设备下发 | ❌ 已推翻 | 早期「换设备就能领」的结论被时间混杂污染，实际是活动按账号分配 |

---

## 5. 排查中的错误归因（重要，避免重犯）

| 错误结论 | 实际情况 | 教训 |
|---|---|---|
| 「`pending[]` 是上游字段」 | 是插件自己从 entitlements 派生的 | **别把本地派生物当上游字段** |
| 「`1004` = 本设备配额已用，换设备可领」 | 时间上「投放延迟到达」与「换设备」混杂，无法归因 | 时序混杂的对照实验不能下因果结论 |
| 「服务端不再下发活动了」 | 一直在下发，只是版本不够被屏蔽 | 先排除门控，再谈机制 |
| 「`device_mid` 决定领取资格」 | 换三种 `device_mid` 结果全空 | 控制变量要卡在「有可领样本」时做 |
| 「CDP 合成点击 `isTrusted=false` 所以无效」 | 实测 `true`（`Input.dispatchMouseEvent` 是浏览器层注入） | 猜测前先测一行 |
| 「`Page.setDocumentContent` 能执行内联脚本」 | **不能**，`window.__x` 恒 undefined | 测页面行为要用 `file://` 加载 |
| 「captcha 必须点击按钮」 | 宿主方案调的是 `instance.startTracelessVerification()`，不点击 | **先读现有实现，别臆造流程** |

---

## 6. 下次遇到同样症状的排查顺序

1. **先看版本门控**：`zcodeVersionGatedAppVersion` 返回什么？与官方最新版比。
   官方最新版可从 `https://zcode.z.ai/` 首页 HTML 的 `releases/<x.y.z>/` 取。
2. `marketing/touch` 带正确版本后 `deliveries` 是否非空。
3. `billing/balance` 的 `data.plans[]` 是否有记录（这才是「账号有没有活动」的判据）。
4. 两者都空 → 服务端确实没给这个账号；只有其一 → 是该来源的解析问题。
5. 查 `sources:{campaign,records}` 区分「探测失败」与「确实没有」。

---

## 7. captcha 链路（供参考）

| 环境 | 能否产出 param | 备注 |
|---|---|---|
| 宿主 Electron（`--remote-debugging-port=9229`） | ✅ 约 6 秒 | 现有方案；**必须带启动参数** |
| WSL Linux Chrome + WSLg | ✅ 4.1 秒 | 原生 Linux 浏览器，无自动化特征 |
| Windows Edge 脚本拉起 | ❌ `F008` | 被风控判定 |

三类都用同一套调用：

```js
initAliyunCaptcha({
  SceneId, mode: 'popup', element, button,
  getInstance: (instance) => instance.startTracelessVerification(),  // ← 不点击
  success: (param) => { /* param 一次性，复用报 3007 */ },
  fail: (error) => { /* F008 = 风控拒绝 */ },
})
```

⚠ `x-aliyun-captcha-verify-param` **一次性**：每个 plan 必须重新 mint。
⚠ `F008` 是环境风控，重试无效。

---

## 8. 排障后的结构性整理（2026-11-10）

排查期间反复改错又改回，代码留下了一批互相矛盾的判据。用四个文件隔离的子代理
做了一次整理，**273/273 测试通过**，并用变异测试验证 8 个变异体全部能被检出。

### 修掉的行为矛盾

| 矛盾 | 后果 | 现状 |
|---|---|---|
| 3012 抛 `RATE_LIMIT`，而它是「可重试/可回退」码 | 宿主重试 5 次，加重账号冷却（issue #3） | 抛 `RISK_BLOCKED`，不进回退名单 |
| 3012 后限流标记要手动清 | 账号被自己的标记锁死 | 抛错前**自动** `clearModelRateLimits` |
| 钉定用 `last_error` 秒拒、自动选号不用 | 同账号一个拒一个放行 | 两边统一：只看 `model_rate_limits` 硬标记 |
| `sink.exhausted` 恒为空 | 「全部账号额度用尽」整段不可达 | 删除该参数与分支 |
| 401 落 `QUOTA` | 引导用户「等次日重置」而非重新登录 | 落 `AUTH` |

### 删除的死代码

`hasQuotaError`、`quotaBlock`、`candidates` 的 `sink` 参数、`quotaSink`/`quotaBlocked` 分支、
`assemble` 里 4 个纯转发包装、描述已不存在实现的孤儿 JSDoc。

### 测试被修正的地方

| 文件 | 原来断言 | 现在断言 |
|---|---|---|
| `tests/quota-blackhole.test.mjs` | `last_error` 是 1005 就**不发请求** | 仍然发请求，真耗尽才写硬标记 |
| `tests/plan-client.test.mjs` | 3012 → `RATE_LIMIT` | → `RISK_BLOCKED` + **自动清标记被调用** |
| `tests/plan-client.test.mjs` | 401 → `QUOTA` | → `AUTH` |
| `tests/routing-quota.test.mjs` | 只测硬标记 | 新增「只有 `last_error` → 不判 limited」 |
| `tests/version-probe.test.mjs`（新） | — | 6 条，覆盖版本抓取与只抬不降 |

**教训**：上线前 262 个测试全绿，但它们断言的是**已被删除的实现**——
测试锁的是「当时怎么写的」，不是「现在应该怎么行为」。变异测试是发现这类假绿的有效手段。
