/**
 * 「钉定账号」模型 id 的编解码。
 *
 * ## 这个功能解决什么问题
 *
 * 默认选号是「手动顺序」：面板置顶谁，下一次请求就用谁。但用户有时想**同时**
 * 用多个会话，各会话吃不同账号的额度 —— 顺序只有一个，做不到。
 *
 * 因此在模型选择器里为每个启用账号额外暴露一条「模型 × 账号」条目：
 *
 * ```
 * GLM-5.3-Flash                      ← 普通条目：自动选号（手动顺序）
 * GLM-5.3-Flash · 主号               ← 钉定条目：只消耗「主号」的额度
 * ```
 *
 * ## id 编码
 *
 * 钉定条目的模型 id 形如 `GLM-5.3-Flash@acct:<账号id>`：
 *
 * - `@acct:` 之前是**发给上游的基础模型 id**（上游只认识 `GLM-5.3-Flash` 这类）；
 * - 之后是池内账号 id（`randomUUID`）。
 *
 * 上游合法模型 id 与账号 id 都不含 `@acct:`，该分隔符无歧义；用 `lastIndexOf`
 * 解析，即便未来 id 里再出现该串也取最后一个分隔段。
 *
 * ⚠ 这个 id 会对宿主/上游/持久化（会话保存的模型名）三方可见，**编码格式一经
 * 发布就不能变**，否则老会话里保存的钉定模型全部失效。
 */

/** 分隔符（发布后不可更改，见文件头）。 */
export const PINNED_MODEL_SUFFIX = '@acct:'

/** 拼一个钉定模型 id。 */
export function makePinnedModelId(baseModelId, accountId) {
  return `${baseModelId}${PINNED_MODEL_SUFFIX}${accountId}`
}

/**
 * 解析钉定模型 id。
 *
 * @returns {{ baseModelId: string, accountId: string } | null} 非钉定 id 或形状不完整时返回 null
 */
export function parsePinnedModelId(modelId) {
  const raw = String(modelId ?? '')
  const at = raw.lastIndexOf(PINNED_MODEL_SUFFIX)
  if (at <= 0) return null
  const baseModelId = raw.slice(0, at)
  const accountId = raw.slice(at + PINNED_MODEL_SUFFIX.length)
  if (baseModelId.length === 0 || accountId.length === 0) return null
  return { baseModelId, accountId }
}

/** 是否是钉定模型 id。 */
export function isPinnedModelId(modelId) {
  return parsePinnedModelId(modelId) !== null
}
