/**
 * 从官方首页 HTML 提取**最新客户端版本号**。
 *
 * ## 为什么不用固定常量
 *
 * 服务端的版本门控会随官方版本推进而抬高（实测：`3.14.3` → `3.16.3` → `3.17.2`
 * 每次都让旧值失效，表现为「活动存在但探测不到」）。钉死一个值，早晚会静默过期。
 *
 * ## 数据来源（2026-11-10 实测）
 *
 * `https://zcode.z.ai/` 重定向到 `/cn`，返回的 HTML（约 280KB）里带着**全部**
 * 发布版本的下载链接，格式统一：
 * ```
 * https://cdn-zcode.z.ai/zcode/electron/releases/<VERSION>/<platform>/ZCode-<VERSION>-<arch>.<ext>
 * ```
 * 取 `<VERSION>` 的最大值即官方当前最新版。
 *
 * ## 失败处理
 *
 * 网络不可达 / HTML 结构变更时**返回 null**，调用方回落到内置下限。
 * 绝不抛异常——探测版本号的失败不该阻断领取链路。
 */

export const ZCODE_SITE_ORIGIN = 'https://zcode.z.ai'

/** 单次抓取超时（首页 280KB，5 秒足够；慢网给 8 秒）。 */
const FETCH_TIMEOUT_MS = 8_000

/** 版本号缓存时长：一天。官方不会一小时发一版，多刷只会被 CDN 限流。 */
const VERSION_CACHE_TTL_MS = 24 * 60 * 60_000

/** `releases/<x.y.z>/` 出现处即官方发布过的版本。 */
const RELEASE_PATH_PATTERN = /releases\/(\d+\.\d+\.\d+)\//g

/** 进程内缓存（成功才写；失败下次重试）。 */
let cache = { at: 0, version: undefined }

/**
 * 点分版本比较（与 upstream.js 的 compareZcodeAppVersion 同语义）。
 * @returns {number} 负数表示 a < b
 */
function compareVersion(a, b) {
  const seg = (v) =>
    String(v)
      .split('.')
      .map((part) => {
        const m = /^\s*(\d+)/.exec(part)
        return m === null ? 0 : Number(m[1])
      })
  const left = seg(a)
  const right = seg(b)
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const l = left[i] ?? 0
    const r = right[i] ?? 0
    if (l !== r) return l < r ? -1 : 1
  }
  return 0
}

/** 从 HTML 文本里取最高版本号；没有返回 undefined。 */
export function extractLatestVersion(html) {
  if (typeof html !== 'string' || html.length === 0) return undefined
  const seen = new Set()
  for (const match of html.matchAll(RELEASE_PATH_PATTERN)) seen.add(match[1])
  if (seen.size === 0) return undefined
  return [...seen].sort(compareVersion).at(-1)
}

/**
 * 抓官方最新版本号。
 *
 * @param {{ fetchImpl?: typeof fetch, now?: () => number, force?: boolean }} [options]
 * @returns {Promise<string | undefined>} 失败返回 undefined（调用方回落到内置下限）
 */
export async function fetchLatestClientVersion(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const now = options.now ?? (() => Date.now())

  if (options.force !== true && cache.version !== undefined && now() - cache.at < VERSION_CACHE_TTL_MS) {
    return cache.version
  }

  try {
    const response = await fetchImpl(`${ZCODE_SITE_ORIGIN}/`, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        // 首页是公开页面，用普通浏览器 UA 即可（不带任何 ZCode 凭据）。
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
        Accept: 'text/html',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!response.ok) return undefined
    const html = await response.text()
    const version = extractLatestVersion(html)
    if (version === undefined) return undefined
    cache = { at: now(), version }
    return version
  } catch {
    /** 网络不通 / 超时 / HTML 结构变化 → 不缓存、不抛，让调用方用内置下限。 */
    return undefined
  }
}

/** 测试用：清空缓存。 */
export function resetVersionCache() {
  cache = { at: 0, version: undefined }
}
