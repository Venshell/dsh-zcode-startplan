/**
 * 模型 id 的**准入校验**（网关与 CLI 共用的唯一判据）。
 *
 * ## 为什么必须有
 *
 * `plan-client.call` 按 `options.model` 选号并直发上游。上游对一个**不存在**的模型
 * 会返回 HTTP 200 + 零内容帧 —— 而 `plan-client` 对「200 但零内容」的处置是把该
 * 账号×模型标记限流到**当日结束**（`markModelRateLimited`）。于是：
 *
 * ```
 * POST /v1/chat/completions {"model": "随便写的"}
 *   → 全部启用账号被标记限流到当日 → 整个池子当天不可用
 * ```
 *
 * 一个拼错的模型名、或一次坏客户端重放，就能做掉整个池子。故模型 id 必须**先**在
 * 入口按目录校验，绝不把未识别的 id 送进选号链路。
 *
 * ## 允许的形态
 *
 * - 目录内 id（大小写不敏感 —— 上游目录是唯一的真相）；
 * - 钉定后缀形态 `<base>@acct:<accountId>` 中的 `<base>`（0.3.0 兼容）；
 * - 目录为空时**放行**（上游不可达且无兜底表：宁可让请求按原样继续，也不能因为
 *   「拿不到目录」把全部请求拒掉）。
 */

/** 把模型 id 归一成「要拿去比对的基础 id」（剥离 `@acct:` 钉定后缀）。 */
export function baseModelId(model) {
  if (typeof model !== 'string') return ''
  const at = model.indexOf('@acct:')
  return (at === -1 ? model : model.slice(0, at)).trim()
}

/**
 * 校验模型 id。
 *
 * @param {string} model 客户端请求的模型 id
 * @param {Array<{ id?: string }>} catalog 当前可用模型目录
 * @returns {{ ok: true, id: string } | { ok: false, reason: string, available: string[] }}
 */
export function checkModelId(model, catalog) {
  const ids = (Array.isArray(catalog) ? catalog : [])
    .map((entry) => (typeof entry?.id === 'string' ? entry.id : undefined))
    .filter((id) => typeof id === 'string' && id.length > 0)
  const wanted = baseModelId(model)
  if (wanted.length === 0) {
    return { ok: false, reason: '缺少 model 字段（发请求必须指名模型）', available: ids }
  }
  if (ids.length === 0) return { ok: true, id: wanted }
  const lower = wanted.toLowerCase()
  const hit = ids.find((id) => id.toLowerCase() === lower)
  if (hit !== undefined) return { ok: true, id: hit }
  return {
    ok: false,
    reason: `未知模型「${wanted}」：为避免把全部账号误标限流到当日，只接受目录内的模型`,
    available: ids,
  }
}
