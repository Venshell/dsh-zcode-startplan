/**
 * 阿里云 captcha 网页侧脚本常量与兜底配置。
 *
 * 与参考实现逐字一致：SDK 地址、承载 origin、DOM id、兜底 sceneId/prefix。
 * 其中 `ZCODE_CAPTCHA_FALLBACK` 是实测自本机账号的兜底值；运行时优先服务端下发
 * （`GET /api/v1/client/configs`，60 秒 TTL，失败不缓存）。
 */

/** 阿里云 captcha SDK 地址（与官方逐字一致）。 */
export const CAPTCHA_SDK_URL = 'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js'

/** captcha 页面必须导航到的**真实 origin**（能否重复 mint 的关键）。 */
export const CAPTCHA_PAGE_ORIGIN = 'https://zcode.z.ai/'

/** 兜底 captcha 配置（运行时优先服务端下发）。 */
export const ZCODE_CAPTCHA_FALLBACK = Object.freeze({
  region: 'cn',
  prefix: 'no8xfe',
  sceneId: '11xygtvd',
})
