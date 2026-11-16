/**
 * 与宿主 `LlmAdapter` 直调契约的**形状级**测试（issue #6 缺陷 1）。
 *
 * 宿主 `dsh-llm/lib/index.js`（0.2.1-rc.3 ~ 0.2.2-rc.3 逐字同形）：
 *
 * ```js
 * // LlmAdapter 基类默认实现（:1706）
 * imageRequestTarget(_provider, _model, image) {
 *   return { width: image.width, height: image.height, maxBytes: image.bytes };
 * }
 *
 * // ctx.llm 的转发（:2063）——没有可选调用保护：
 * imageRequestTarget(provider, model, image) {
 *   return this.registration(provider).adapter.imageRequestTarget(provider, model, image);
 * }
 * ```
 *
 * 本插件的两个适配器都**不 extends 基类**（鸭子类型，宿主不做 instanceof 检查），
 * 所以每一个被宿主直调的方法都必须自己补齐。此前补了 `providerRetryPolicy` /
 * `imageRequestPricing` / `prepareCall`，漏了 `imageRequestTarget` ——
 * 唯一调用方是 `@deepseek-ai/dsh-cua`（截图链路）：模型目录声明了 image 输入
 * （`GLM-5.3-Flash` 的 `supportsImage` 是 true）⇒ 用户装了 CUA 并把模型切到
 * 本渠道后，截图动作必崩 `TypeError: adapter.imageRequestTarget is not a function`。
 * 纯文本对话不受影响，所以这个坑在日常使用里完全隐蔽。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { NativeZcodeStartPlanAdapter, PiAiZcodeStartPlanAdapter } from '../lib/adapter.js'

const noModels = async () => []

/** 宿主基类默认实现的忠实复刻（对照用）。 */
function hostDefault(image) {
  return { width: image.width, height: image.height, maxBytes: image.bytes }
}

const IMAGE = { width: 1024, height: 768, bytes: 456_789, mimeType: 'image/png' }

test('NativeZcodeStartPlanAdapter.imageRequestTarget 与宿主基类默认实现同形', () => {
  const adapter = new NativeZcodeStartPlanAdapter({ client: {}, models: noModels })
  assert.equal(typeof adapter.imageRequestTarget, 'function', '宿主直调的方法必须存在')
  assert.deepEqual(adapter.imageRequestTarget('zcode-start-plan', 'GLM-5.3-Flash', IMAGE), hostDefault(IMAGE))
})

test('PiAiZcodeStartPlanAdapter.imageRequestTarget 与宿主基类默认实现同形', () => {
  const adapter = new PiAiZcodeStartPlanAdapter({ models: noModels })
  assert.equal(typeof adapter.imageRequestTarget, 'function', '回落适配器同样被宿主直调')
  assert.deepEqual(adapter.imageRequestTarget('zcode-start-plan', 'GLM-5.3-Flash', IMAGE), hostDefault(IMAGE))
})

test('宿主直调契约方法在两个适配器上全部齐备（回归守卫）', () => {
  /**
   * 这份名单来自宿主 `registerAdapter` / `prepareRoutes` / CUA / token-meter 的
   * **无条件直调**清单（有可选调用的不算）：
   * - `providerInfo` / `providerRetryPolicy`：路由注册时直调；
   * - `listModels` / `resolveModel` / `prepareCall`：模型选择与派发时直调；
   * - `imageRequestPricing`：token-meter / 压缩压力判定直调；
   * - `imageRequestTarget`：CUA 截图链路直调（issue #6 缺陷 1）。
   */
  const hostCalledMethods = [
    'providerInfo',
    'providerRetryPolicy',
    'listModels',
    'resolveModel',
    'prepareCall',
    'imageRequestPricing',
    'imageRequestTarget',
  ]
  for (const Ctor of [NativeZcodeStartPlanAdapter, PiAiZcodeStartPlanAdapter]) {
    const adapter = new Ctor({ client: {}, models: noModels })
    for (const name of hostCalledMethods) {
      assert.equal(typeof adapter[name], 'function', `${Ctor.name}.${name} 缺失 —— 宿主直调会 TypeError`)
    }
  }
})

test('imageRequestTarget 不受重试/钉定影响：同一输入恒同形', () => {
  const native = new NativeZcodeStartPlanAdapter({ client: {}, models: noModels })
  const piAi = new PiAiZcodeStartPlanAdapter({ models: noModels })
  const expected = { width: 1, height: 2, maxBytes: 3 }
  for (const adapter of [native, piAi]) {
    assert.deepEqual(adapter.imageRequestTarget('p', 'm', { width: 1, height: 2, bytes: 3 }), expected)
    /** 钉定路由（provider 带 -acct- 后缀）同样走同一实现。 */
    assert.deepEqual(
      adapter.imageRequestTarget('zcode-start-plan-acct-abc', 'GLM-5.3-Flash', { width: 1, height: 2, bytes: 3 }),
      expected,
    )
  }
})
