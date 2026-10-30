# 通道与风控（免费 / coding-plan）

> coding-plan 通道在分支 `feature/coding-plan-channel`（0.9.1），master 暂未合并。

## 两条通道

| 项 | 免费通道（默认） | coding-plan |
|---|---|---|
| 端点 | `zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages` | `api.z.ai/api/anthropic/v1/messages` |
| 凭据 | `zcode_jwt`（登录直接下发） | `coding_plan_key` = `{apiKey}.{secretKey}` |
| 换取 | — | biz API 三步（见下） |
| 状态 | 2026-10-31 实测被 `3012` 风控 | 实测 200 出词（GLM-5.3-Flash，1.1s） |

端点来源：`GET /api/v1/client/configs` 下发的 `providers[]` ——
`api.z.ai` / `open.bigmodel.cn` 两个 origin × `anthropic` / `openai:chat` 两个 schema。
**`zcode.z.ai` 不在这个列表里**（那是赠送额度的专有通道）。

## 换 key（biz API 三步）

`lib/coding-plan.js` 的 `fetchCodingPlanApiKey`：

```
① GET api.z.ai/api/biz/customer/getCustomerInfo        → organizations[].organizationId + projects[].projectId
② GET .../api/biz/v1/organization/{org}/projects/{proj}/api_keys   → entries[].apiKey（★ 只 GET 不建）
③ GET .../api_keys/copy/{apiKey}                        → secretKey
→ coding_plan_key = "{apiKey}.{secretKey}"
```

实测纪律（来自参考实现）：

- biz origin **只有 `https://api.z.ai` 通**（`chat.z.ai` 同路径 404）
- biz 头只要 `Authorization: Bearer <access_token>` + win32-x64 平台三件套
- **只 GET 不建**：官方客户端没有创建行为，建了就是新指纹
- 换不到的原因（`no-oauth-token` / `no-org` / `no-key` / `no-secret`）**只降级不抛错**
  —— 没订阅是常态，免费通道照常
- key 偏好 **zai 优先**（与 access_token 来源一致）
- 双写：凭据内（权威）+ `coding-plan-keys.json`（重启补种，不打 biz API）
- `access_token` 缺失的账号换不了 —— **zai 渠道登录此前不解析 `data.zai.access_token`**
  （0.9.1 修）；存量账号需重新登录一次

## 通道选择（plan-client）

- **免费优先**：积分是白给的，不该被订阅额度先消耗掉（参考实现用户决策，同款）
- 免费腿撞 `3012` → 打 **10 分钟通道级退避**（进程内 `#riskUntil`），同账号后续请求
  自动改走 coding-plan（若 key 可用）
- coding-plan 腿撞 `3012` → 如实失败：换腿救不了**账号级**风控，重试只会加重
- coding-plan 请求**不带** `HTTP-Referer`（zcode.z.ai 专属头，发到 api.z.ai 无意义；
  实测该网关只认 `Authorization` + `anthropic-version`）
- coding-plan 承载的模型白名单：`glm-5.3` / `glm-5.3-flash`
  （官方 `builtinModelIds` 确认过的两个；远端 `/v1/models` 有 11 个，其余未验证）

## 3012 冷却惩罚

**30 分钟起步；24 小时内第 3 次起 24 小时；5 次停用。**

⇒ 两条通道都**永不重试** 3012。调试时也不要反复触发它。

## 已知限制

- **两条通道的额度池互不相通**：赠送额度只记在 `zcode.z.ai` 的 `billing/balance`
  （免费桶）；coding-plan 出的词消耗的是 `api.z.ai` 侧的订阅/资源包，
  不在免费桶里体现 —— 反过来也一样。通道选择只决定**谁先被烧**：
  免费优先 ⇒ 赠送桶先消耗，3012 后的请求才落到订阅侧。
  实测（2026-10-31）：本会话（分支已上线）全程烧免费桶
  ——账号 A 的 GLM-5.3-Flash 赠送桶从 3.81 亿降到 3.53 亿，账号 B（走订阅侧）的额度分毫未动
- `3012` 是账号/设备级：换 `X-Device-Mid`（重新登录生成）可脱离设备画像，
  账号本身被标记则还需换号
- 官方客户端可用 ≠ 上游没挂：它没进 3012 的风控画像而已
  （2026-10-31 实测：同一时刻我们 405/3012，官方正常）
