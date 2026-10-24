/**
 * 消息首行（`##` 标题 / ``` 代码围栏）与「是否看起来像拒答」的极简判定。
 *
 * 只用于**可观测性**（状态工具里报告「上一轮像拒答」），**不参与**任何提示词注入：
 * 真正的破甲/人格逻辑属于独立插件（例如 dsh-infinite-gen-x），本插件只管通道路由。
 */
const REFUSAL_MARKERS = Object.freeze([
  /^i\s+(?:can't|cannot|won't|am unable)/i,
  /^i'm\s+sorry/i,
  /^sorry[,.]/i,
  /^(?:unfortunately[,.]\s*)?i\s+(?:must|cannot|can't)/i,
  /^(?:很抱歉|抱歉|对不起)[，,。.]?/,
  /^我(?:无法|不能|不便|不会)/,
])

/**
 * 首行是否以 `##` 标题或 ``` 围栏开头（交付物契约）。
 * @param {string} text
 */
export function opensWithDeliverable(text) {
  if (typeof text !== 'string') return false
  const firstLine = text.trimStart().split(/\r?\n/, 1)[0] ?? ''
  return firstLine.startsWith('## ') || firstLine.startsWith('```')
}

/**
 * 开头窗口内是否出现拒答特征。
 * @param {string} text
 * @param {number} [window]
 */
export function looksLikeRefusal(text, window = 160) {
  if (typeof text !== 'string') return false
  const head = text.trimStart().slice(0, window)
  return REFUSAL_MARKERS.some((pattern) => pattern.test(head))
}
