/**
 * 登录渠道（国内 智谱 / 国际 Z.AI）的归一化与配置校验。
 *
 * 依据（实测 2026-10-23）：两条渠道共用同一个 `oauth/cli/init` 协议，
 * 只在 `provider` 与授权站点上不同；非法 provider 返回 500 code=1000。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_LOGIN_CHANNEL,
  LOGIN_CHANNELS,
  normalizeLoginChannel,
  resolveLoginChannel,
} from '../lib/upstream-api.js'
import { Config } from '../index.js'

test('默认渠道是国内站', () => {
  assert.equal(DEFAULT_LOGIN_CHANNEL, 'bigmodel')
  assert.equal(normalizeLoginChannel(undefined), 'bigmodel')
  assert.equal(normalizeLoginChannel(''), 'bigmodel')
  assert.equal(normalizeLoginChannel('   '), 'bigmodel')
})

test('国内渠道的别名（含中文与我自己的简写 cn）', () => {
  for (const input of ['bigmodel', 'cn', 'china', 'domestic', '国内', '智谱', 'CN', 'BigModel']) {
    assert.equal(normalizeLoginChannel(input), 'bigmodel', input)
  }
})

test('国际渠道的别名（含中文与我自己的简写 intl）', () => {
  for (const input of ['zai', 'z-ai', 'intl', 'international', 'global', '国际', '海外', 'ZAI', 'INTL']) {
    assert.equal(normalizeLoginChannel(input), 'zai', input)
  }
})

test('非法渠道回退默认，不抛错（避免把用户挡住）', () => {
  assert.equal(normalizeLoginChannel('bigmodel-intl'), 'bigmodel')
  assert.equal(normalizeLoginChannel('openai'), 'bigmodel')
})

test('渠道描述：provider 是上游真实取值，站点与 API Key 地址不同', () => {
  const cn = resolveLoginChannel('cn')
  const intl = resolveLoginChannel('intl')
  assert.equal(cn.provider, 'bigmodel')
  assert.equal(intl.provider, 'zai')
  assert.equal(cn.site, 'bigmodel.cn')
  assert.equal(intl.site, 'z.ai')
  assert.notEqual(cn.apiKeyUrl, intl.apiKeyUrl)
  assert.match(cn.label, /国内/)
  assert.match(intl.label, /国际/)
  /** 上游只认这两个 provider 值。 */
  assert.deepEqual(Object.keys(LOGIN_CHANNELS).sort(), ['bigmodel', 'zai'])
})

test('Config 是 schemastery 原生 schema（DSH 用 isNativeConfigSchema 判定）', () => {
  /** 与宿主 `isNativeConfigSchema` 完全同构的判据。 */
  const meta = Reflect.get(Config, 'meta')
  assert.equal(Reflect.get(Config, Symbol.for('schemastery')), true)
  assert.equal(typeof Reflect.get(Config, 'type'), 'string')
  assert.equal(typeof meta, 'object')
  assert.notEqual(meta, null)
})

test('Config 校验：channel 只接受 cn/intl 及其别名', () => {
  const accept = (value) => {
    try {
      Config({ channel: value })
      return true
    } catch {
      return false
    }
  }
  for (const good of ['cn', 'intl', 'bigmodel', 'zai', '国内', '国际']) {
    assert.equal(accept(good), true, `应接受 ${good}`)
  }
  for (const bad of ['bigmodel-intl', 'openai', ' ', 'z-ai-x']) {
    assert.equal(accept(bad), false, `应拒绝 ${bad}`)
  }
})

test('Config 校验：默认 channel 是 cn，且未写时也补齐', () => {
  assert.equal(Config({}).channel, 'cn')
  /** 覆盖值原样生效。 */
  assert.equal(Config({ channel: 'intl' }).channel, 'intl')
})

test('Config 其余字段：默认值补齐 + 非法值报错', () => {
  const defaults = Config({})
  assert.deepEqual(defaults.models, ['GLM-5.3-Flash', 'GLM-5.3'])
  assert.deepEqual(defaults.captcha, { mode: 'cdp', debugPort: 9229, origin: 'https://zcode.z.ai/' })
  assert.deepEqual(defaults.endpoint, { enabled: false, port: 17899 })
  assert.equal(defaults.statusTool, true)
  assert.equal(defaults.provider, 'zcode-start-plan')

  assert.throws(() => Config({ captcha: { mode: 'browser' } }))
  assert.throws(() => Config({ captcha: { debugPort: 0 } }))
  assert.throws(() => Config({ models: 'GLM' }))
  assert.equal(Config({ captcha: { debugPort: 9333 } }).captcha.debugPort, 9333)
})

