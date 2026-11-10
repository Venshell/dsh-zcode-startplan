/**
 * 版本探测（`lib/version-probe.js`）与门控下限（`lib/upstream.js`）的回归测试。
 *
 * 背景：服务端门控下限会随官方发布推进而抬高（实测 3.14.3 → 3.16.3 → 3.17.2，
 * 每次抬高都让写死的常量失效，表现为「活动存在但探测不到」）。所以下限改为
 * **运行期向官方首页取最新版本**再抬高，本文件锁三件事：
 *
 * 1. `extractLatestVersion` 从首页 HTML 里取**最高**版本（不是第一个、也不是最后一个）；
 * 2. `fetchLatestClientVersion` 任何失败都返回 `undefined`（探测失败不许阻断领取链路）；
 * 3. `setGatedMinAppVersion` **只抬高不降低**（探到更旧的版本 / 脏值一律忽略）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ZCODE_SITE_ORIGIN,
  extractLatestVersion,
  fetchLatestClientVersion,
  resetVersionCache,
} from '../lib/version-probe.js'
import {
  ZCODE_VERSION_GATED_MIN_APP_VERSION,
  currentGatedMinAppVersion,
  resetGatedMinAppVersion,
  setGatedMinAppVersion,
} from '../lib/upstream.js'

/** 官方首页的真实形态：所有发布版本的下载链接铺在 HTML 里（顺序与版本高低无关）。 */
const releaseLink = (version, platform = 'win32', arch = 'x64', ext = 'exe') =>
  `https://cdn-zcode.z.ai/zcode/electron/releases/${version}/${platform}/ZCode-${version}-${arch}.${ext}`

const htmlWith = (...versions) =>
  `<html><body><script>window.__ASSETS__=${JSON.stringify(versions.map((v) => releaseLink(v)))}</script></body></html>`

test('extractLatestVersion: 取**最高**版本（不是首个/末个）', () => {
  /** 刻意把 3.9.10 放在最后：字典序会误判成最高，点分比较不会。 */
  const html = htmlWith('3.17.2', '3.14.3', '3.16.3', '3.9.10')
  assert.equal(extractLatestVersion(html), '3.17.2')
  /** 乱序、含重复：仍取最大，且不去重也不影响结果。 */
  assert.equal(extractLatestVersion(htmlWith('3.18.0', '3.17.2', '3.18.0')), '3.18.0')
  /** 段数不同时按缺失补 0 比较（3.10.0 > 3.9.9）。 */
  assert.equal(extractLatestVersion(htmlWith('3.9.9', '3.10.0')), '3.10.0')
  /** 主版本进位（10.0.0 > 9.99.99 而不是字符串比较）。 */
  assert.equal(extractLatestVersion(htmlWith('9.99.99', '10.0.0')), '10.0.0')
})

test('extractLatestVersion: 没有发布链接 / 非字符串 / 空串 → undefined（不猜）', () => {
  assert.equal(extractLatestVersion('<html><body>no releases here</body></html>'), undefined)
  assert.equal(extractLatestVersion(''), undefined)
  assert.equal(extractLatestVersion(undefined), undefined)
  assert.equal(extractLatestVersion(null), undefined)
  /**
   * 只认 `releases/<x.y.z>/` 这种路径段：裸版本号（如 `app_version: 3.99.0`）
   * 不是发布链接，不能当成「官方最新」。
   */
  assert.equal(extractLatestVersion('<script>const app_version = "3.99.0"</script>'), undefined)
})

test('fetchLatestClientVersion: 抓到的 HTML 里取最高版本，并命中进程内缓存', async () => {
  resetVersionCache()
  const urls = []
  const fetchImpl = async (url) => {
    urls.push(url)
    return { ok: true, status: 200, text: async () => htmlWith('3.16.3', '3.17.2') }
  }
  const version = await fetchLatestClientVersion({ fetchImpl, now: () => 1_000 })
  assert.equal(version, '3.17.2')
  assert.equal(urls.length, 1)
  assert.equal(urls[0], `${ZCODE_SITE_ORIGIN}/`, '抓的是官方首页（公开页面，不带任何凭据）')

  /** 24h 内走缓存：不再发请求（多刷只会被 CDN 限流）。 */
  const cached = await fetchLatestClientVersion({ fetchImpl, now: () => 1_000 + 60_000 })
  assert.equal(cached, '3.17.2')
  assert.equal(urls.length, 1, '缓存窗口内不该重复抓取')

  /** `force: true` 强制重抓。 */
  await fetchLatestClientVersion({ fetchImpl, now: () => 1_000 + 60_000, force: true })
  assert.equal(urls.length, 2)
  resetVersionCache()
})

test('fetchLatestClientVersion: 失败一律返回 undefined（绝不抛，绝不阻断领取链路）', async () => {
  resetVersionCache()
  /** ① fetch 自己抛错（DNS 失败 / 连接被拒 / 断网）。 */
  const throwing = async () => {
    throw new TypeError('fetch failed')
  }
  assert.equal(await fetchLatestClientVersion({ fetchImpl: throwing }), undefined)

  /** ② 非 2xx（CDN 502 / 被限流）。 */
  const notOk = async () => ({ ok: false, status: 502, text: async () => 'bad gateway' })
  assert.equal(await fetchLatestClientVersion({ fetchImpl: notOk }), undefined)

  /** ③ 200 但 HTML 结构变了（找不到 releases 路径）。 */
  const noReleases = async () => ({ ok: true, status: 200, text: async () => '<html>redesigned</html>' })
  assert.equal(await fetchLatestClientVersion({ fetchImpl: noReleases }), undefined)

  /** ④ 读 body 时抛（连接中断）。 */
  const brokenBody = async () => ({
    ok: true,
    status: 200,
    text: async () => {
      throw new Error('terminated')
    },
  })
  assert.equal(await fetchLatestClientVersion({ fetchImpl: brokenBody }), undefined)

  /** 失败不写缓存：下一次仍然真的去抓（否则一次抖动会固化一整天的「探不到」）。 */
  let calls = 0
  const recover = async () => {
    calls += 1
    return calls === 1 ? { ok: false, status: 500, text: async () => '' } : { ok: true, status: 200, text: async () => htmlWith('3.18.0') }
  }
  assert.equal(await fetchLatestClientVersion({ fetchImpl: recover }), undefined)
  assert.equal(await fetchLatestClientVersion({ fetchImpl: recover }), '3.18.0', '失败不缓存，下一次能自愈')
  resetVersionCache()
})

test('setGatedMinAppVersion: 只**抬高**不降低', () => {
  resetGatedMinAppVersion()
  const base = ZCODE_VERSION_GATED_MIN_APP_VERSION
  assert.equal(currentGatedMinAppVersion(), base, '初值 = 编译期常量')

  /** 抬高：生效。 */
  assert.equal(setGatedMinAppVersion('3.18.0'), '3.18.0')
  assert.equal(currentGatedMinAppVersion(), '3.18.0')

  /** 更低的版本：忽略（降低会让服务端门控重新失效，等于退化）。 */
  assert.equal(setGatedMinAppVersion('3.16.3'), '3.18.0', '探到更旧的版本绝不能把下限拉低')
  assert.equal(currentGatedMinAppVersion(), '3.18.0')

  /** 相等：保持。 */
  assert.equal(setGatedMinAppVersion('3.18.0'), '3.18.0')

  /** undefined / 空串 / 脏值：忽略（脏值会原样进 User-Agent，`Headers()` 对脏值抛 TypeError）。 */
  for (const dirty of [undefined, null, '', '   ', 'latest', '3.18', '3.18.0-beta.1', '3.18.0\r\nX-Injected: 1', '03.18.0', 3.18]) {
    assert.equal(setGatedMinAppVersion(dirty), '3.18.0', `脏值 ${JSON.stringify(dirty)} 必须被忽略`)
  }

  /** 再抬一档：继续生效（单调递增是唯一允许的移动方向）。 */
  assert.equal(setGatedMinAppVersion('4.0.0'), '4.0.0')

  /** 复位回常量（供测试与运行期重置用）。 */
  resetGatedMinAppVersion()
  assert.equal(currentGatedMinAppVersion(), base)
})

test('端到端：探测到的版本 → 抬高门控下限（失败则沿用内置常量）', async () => {
  resetVersionCache()
  resetGatedMinAppVersion()
  const base = ZCODE_VERSION_GATED_MIN_APP_VERSION
  /** 官方已发到比内置常量更新的版本。 */
  const newer = '9.9.9'
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => htmlWith(base, newer) })
  const probed = await fetchLatestClientVersion({ fetchImpl })
  assert.equal(probed, newer)
  assert.equal(setGatedMinAppVersion(probed), newer, '探测成功即抬高下限（不必每次发版改常量）')

  /** 探测失败（undefined）：下限保持不动，链路照常可用。 */
  resetGatedMinAppVersion()
  /** 缓存里还留着上一次的成功值 —— 先清掉，否则走的是缓存而不是「探测失败」。 */
  resetVersionCache()
  const offline = async () => {
    throw new Error('offline')
  }
  const failed = await fetchLatestClientVersion({ fetchImpl: offline })
  assert.equal(failed, undefined)
  assert.equal(setGatedMinAppVersion(failed), base, '探测失败沿用内置下限')
  resetVersionCache()
  resetGatedMinAppVersion()
})
