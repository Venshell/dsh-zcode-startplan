/**
 * 阿里云 captcha 产出 —— 以**任意 Electron/Chromium 宿主**为载体（默认 DSH 自己的窗口）。
 *
 * ## 为什么不额外起浏览器
 *
 * captcha 是**网页 SDK**，不是 Electron 专有 API：
 *   script: https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js
 *   config: window.AliyunCaptchaConfig = { region, prefix }
 *   call:   initAliyunCaptcha({ SceneId, mode, element, button, getInstance, success, ... })
 *   param:  instance.startTracelessVerification() → success(param)
 *
 * 参考实现把这段脚本注入**开源 ZCode 自己的 Electron** 里的一个离屏隐藏 iframe
 * （因为 Electron 不支持 `Target.createTarget` / `PUT /json/new`，且壳 renderer 的
 * `file://` origin 会被风控拒绝）。DSH 侧同理：连 DSH 桌面端的 CDP 端口
 * （`--remote-debugging-port`），在它的 renderer 里挂**离屏 iframe**。
 *
 * ## 实测硬约束（沿用参考实现，不要"优化"）
 *
 * 1. 页面 origin 必须真实 https（`about:blank` 的 origin 是 "null"，二次 mint 必 F001）；
 * 2. ~~同页空闲 >8s 后必失效~~ —— **该结论已被推翻**：F001 的真因是「DOM 被重置而
 *    SDK 全局实例仍在」，与空闲无关。故复用路径**绝不重置 DOM**（`prepared` 守卫）；
 * 3. mint 失败必须作废该帧（坏会话会传染），换新帧重试一次；
 * 4. `--headless` 一律失败（宿主是真 GUI 进程，天然满足）。
 */

import { CAPTCHA_SDK_URL, CAPTCHA_PAGE_ORIGIN } from './sdk-page.js'

/** 默认 CDP 端口（DSH 桌面端若以 --remote-debugging-port=9229 启动即命中）。 */
export const DEFAULT_DEBUG_PORT = 9229

const FRAME_ID_PREFIX = 'dsh-zcode-captcha-frame-'

/**
 * 生产传输实现：flatten 模式的 CDP over WebSocket（Node 22+ 内置 WebSocket）。
 */
class AttachedHostTransport {
  #ws
  #nextId = 0
  #pending = new Map()
  #iframeQueue = []
  #iframeWaiters = []

  constructor(ws) {
    this.#ws = ws
    ws.addEventListener('message', (event) => {
      let message
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (message.method === 'Target.attachedToTarget') {
        const sessionId = message.params?.sessionId
        const type = message.params?.targetInfo?.type
        if (typeof sessionId === 'string' && type === 'iframe') {
          const waiter = this.#iframeWaiters.shift()
          if (waiter !== undefined) waiter(sessionId)
          else this.#iframeQueue.push(sessionId)
        }
        return
      }
      if (message.id === undefined) return
      const slot = this.#pending.get(message.id)
      if (slot === undefined) return
      this.#pending.delete(message.id)
      if (message.error !== undefined) slot.reject(new Error(JSON.stringify(message.error)))
      else slot.resolve(message.result)
    })
  }

  #sendRaw(method, params, sessionId, timeoutMs) {
    const id = ++this.#nextId
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      const payload = { id, method, params }
      if (sessionId !== undefined) payload.sessionId = sessionId
      try {
        this.#ws.send(JSON.stringify(payload))
      } catch (error) {
        this.#pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
        return
      }
      const timer = setTimeout(() => {
        if (this.#pending.has(id)) {
          this.#pending.delete(id)
          reject(new Error(`CDP ${method} 超时（${timeoutMs}ms）`))
        }
      }, timeoutMs)
      timer.unref?.()
    })
  }

  send(method, params = {}, timeoutMs = 30_000) {
    return this.#sendRaw(method, params, undefined, timeoutMs)
  }

  sendToSession(sessionId, method, params = {}, timeoutMs = 30_000) {
    return this.#sendRaw(method, params, sessionId, timeoutMs)
  }

  async waitForIframeSession(timeoutMs) {
    const queued = this.#iframeQueue.shift()
    if (queued !== undefined) return queued
    return await new Promise((resolve) => {
      let settled = false
      const onSession = (sessionId) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(sessionId)
      }
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        this.#iframeWaiters = this.#iframeWaiters.filter((waiter) => waiter !== onSession)
        resolve(undefined)
      }, timeoutMs)
      timer.unref?.()
      this.#iframeWaiters.push(onSession)
    })
  }

  close() {
    try {
      this.#ws.close()
    } catch {
      // 已关闭。
    }
  }
}

async function defaultHostTransportFactory(pageWebSocketDebuggerUrl) {
  const ws = new WebSocket(pageWebSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('连接调试端口超时（10s）')), 10_000)
    timer.unref?.()
    ws.addEventListener('open', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
    ws.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('连接调试端口失败'))
    }, { once: true })
  })
  return new AttachedHostTransport(ws)
}

/** 构造「创建离屏 iframe」的表达式（离屏、不可见、不可点、不参与布局）。 */
export function buildFrameCreateExpression(frameId, origin) {
  return `(() => {
    const id = ${JSON.stringify(frameId)};
    document.getElementById(id)?.remove();
    const frame = document.createElement('iframe');
    frame.id = id;
    frame.setAttribute('aria-hidden', 'true');
    frame.setAttribute('tabindex', '-1');
    frame.style.cssText = 'position:fixed;left:-99999px;top:0;width:1px;height:1px;'
      + 'border:0;opacity:0;pointer-events:none;';
    frame.src = ${JSON.stringify(origin)};
    document.body.appendChild(frame);
    return 'created';
  })()`
}

/**
 * captcha 产出器（连接宿主的 Electron，只在**自己的离屏 iframe** 内活动）。
 *
 * 生命周期：进程内**单实例**（captcha 是设备级的，并发无益且会互相踩页面）。
 * `dispose()` 只移除**我们自己的** iframe 并关闭**我们自己的** CDP 连接，
 * **绝不**杀宿主进程。
 */
export class CaptchaMinter {
  #debugPort
  #origin
  #idleReuseMs
  #pageWaitTimeoutMs
  #frameAttachTimeoutMs
  #readyTimeoutMs
  #transportFactory
  #fetchImpl
  #sleep
  #now
  #log
  #frameIdPrefix
  #host
  #reusableFrame
  #pageBusy = false

  constructor(options = {}) {
    const envPort = Number(process.env['ZCODE_START_PLAN_CDP_PORT'] ?? '')
    this.#debugPort = options.debugPort ?? (Number.isFinite(envPort) && envPort > 0 ? envPort : DEFAULT_DEBUG_PORT)
    this.#origin = options.origin ?? CAPTCHA_PAGE_ORIGIN
    /** 默认 Infinity：**不因空闲换帧**（预测式换帧会让每次空闲后白付 2.7s）。 */
    this.#idleReuseMs = options.idleReuseMs ?? Number.POSITIVE_INFINITY
    this.#pageWaitTimeoutMs = options.pageWaitTimeoutMs ?? 30_000
    this.#frameAttachTimeoutMs = options.frameAttachTimeoutMs ?? 10_000
    this.#readyTimeoutMs = options.readyTimeoutMs ?? 10_000
    this.#transportFactory = options.transportFactory ?? defaultHostTransportFactory
    this.#fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      timer.unref?.()
    }))
    this.#now = options.now ?? (() => Date.now())
    this.#log = options.log ?? (() => {})
    this.#frameIdPrefix = `${FRAME_ID_PREFIX}${Math.random().toString(36).slice(2, 10)}-`
  }

  get #baseUrl() {
    return `http://127.0.0.1:${this.#debugPort}`
  }

  /** 探测宿主的调试端口与 renderer page target 是否可达（原因文案必须可操作）。 */
  async probe() {
    try {
      const response = await this.#fetchImpl(`${this.#baseUrl}/json/version`, {
        signal: AbortSignal.timeout(this.#readyTimeoutMs),
      })
      if (!response.ok) return { ok: false, reason: `调试端口返回 HTTP ${response.status}` }
      const targets = await this.#listTargets()
      if (targets.find((item) => item.type === 'page') === undefined) {
        return { ok: false, reason: '调试端口可达，但没有找到 renderer 页面目标（宿主可能还在启动中）' }
      }
      return { ok: true }
    } catch (error) {
      return {
        ok: false,
        reason:
          `连不上宿主的调试端口（127.0.0.1:${this.#debugPort}）：` +
          `${error instanceof Error ? error.message : String(error)}。` +
          '请以 --remote-debugging-port 启动 DSH 桌面端（或设 ZCODE_START_PLAN_CDP_PORT）。',
      }
    }
  }

  async #listTargets() {
    const response = await this.#fetchImpl(`${this.#baseUrl}/json/list`, {
      signal: AbortSignal.timeout(this.#readyTimeoutMs),
    })
    if (!response.ok) throw new Error(`读取目标列表失败（HTTP ${response.status}）`)
    const parsed = await response.json()
    return Array.isArray(parsed) ? parsed : []
  }

  async #ensureHost() {
    if (this.#host !== undefined) return this.#host
    const targets = await this.#listTargets()
    const page = targets.find((item) => item.type === 'page' && typeof item.webSocketDebuggerUrl === 'string')
    if (page === undefined) throw new Error('没有找到宿主的 renderer 页面目标')
    const host = await this.#transportFactory(page.webSocketDebuggerUrl)
    await host.send('Target.setAutoAttach', { autoAttach: true, flatten: true, waitForDebuggerOnStart: false })
    this.#host = host
    return host
  }

  /**
   * 产出一个**新鲜**的 captcha param。
   *
   * 复用策略：失败重试 → 丢弃旧帧建新帧；空闲超窗口 → 建新帧；否则复用（不重置 DOM）。
   * 任一次失败 → 作废帧 + 换新帧重试一次（自愈链）。
   */
  async mint(config, options = {}) {
    const attempts = 2
    let lastError
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (options.signal?.aborted === true) throw lastError ?? new Error('captcha 产出已取消')
      let frame
      try {
        frame = await this.#acquireFrame(attempt > 1)
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        if (attempt < attempts) {
          await this.#sleep(300)
          continue
        }
        throw lastError
      }
      try {
        const outcome = await this.#mintInFrame(frame, config)
        frame.lastUsedAt = this.#now()
        return outcome
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        await this.#discardFrame(frame)
        if (attempt < attempts) await this.#sleep(300)
      } finally {
        /** ⚠ 必须无条件复位（只在部分路径复位会让后续 mint 死等）。 */
        this.#pageBusy = false
      }
    }
    throw lastError ?? new Error('captcha 产出失败（未知原因）')
  }

  async #mintInFrame(frame, config) {
    const host = await this.#ensureHost()
    const session = frame.sessionId

    if (!frame.prepared) {
      await this.#prepareFrame(host, session)
      frame.prepared = true
    } else if (!(await this.#frameStillUsable(host, session))) {
      /** 帧内站点自己导航过 ⇒ 新文档 ⇒ 重新完整准备（无副作用）。 */
      await this.#prepareFrame(host, session)
      frame.prepared = true
    }

    const minted = await host.sendToSession(session, 'Runtime.evaluate', {
      expression: buildMintExpression(config),
      awaitPromise: true,
      returnByValue: true,
    }, 75_000)

    const raw = minted?.result?.value
    let parsed
    try {
      parsed = JSON.parse(String(raw))
    } catch {
      throw new Error(`captcha 结果无法解析（${String(raw).slice(0, 160)}）`)
    }
    if (parsed.stage !== 'success' || typeof parsed.param !== 'string') {
      throw new Error(
        `captcha 产出失败（stage=${parsed.stage ?? '?'}${parsed.err !== undefined ? `, err=${parsed.err}` : ''}）`,
      )
    }
    const verdict = validateCaptchaParam(parsed.param)
    if (!verdict.ok) throw new Error(`captcha param 不可用（${verdict.reason ?? '未知'}）`)
    return { param: parsed.param, interactive: parsed.interactive === true }
  }

  /**
   * 完整准备一个帧（stealth → 重置 DOM → 注入 SDK）。
   * ⚠ 只应在**新文档**上调用；同一文档上重复准备会造出 F001（见文件头）。
   * ⚠ OOPIF 上不支持 `Page.addScriptToEvaluateOnNewDocument`，故 stealth 只能直接求值。
   */
  async #prepareFrame(host, sessionId) {
    await host.sendToSession(sessionId, 'Runtime.evaluate', {
      expression: `${STEALTH_PATCH}; 'patched'`,
      returnByValue: true,
    })
    await host.sendToSession(sessionId, 'Runtime.evaluate', {
      expression: buildDomExpression(),
      returnByValue: true,
    })
    const injected = await host.sendToSession(sessionId, 'Runtime.evaluate', {
      expression: buildSdkInjectExpression(),
      awaitPromise: true,
      returnByValue: true,
    })
    const injectedType = injected?.result?.value
    if (injectedType !== 'function' && injectedType !== 'already') {
      throw new Error(`阿里云 captcha SDK 未加载（${String(injectedType)}）`)
    }
  }

  /** 帧是否仍然就绪（元素与 SDK 都还在）；探测失败一律按「不就绪」处理。 */
  async #frameStillUsable(host, sessionId) {
    try {
      const result = await host.sendToSession(sessionId, 'Runtime.evaluate', {
        expression: buildFrameProbeExpression(),
        returnByValue: true,
      }, 5_000)
      const parsed = JSON.parse(String(result?.result?.value))
      return parsed.sdk === 'function' && parsed.el === true && parsed.btn === true
    } catch {
      return false
    }
  }

  async #acquireFrame(forceFresh = false) {
    const deadline = this.#now() + this.#pageWaitTimeoutMs
    while (this.#pageBusy) {
      if (this.#now() >= deadline) {
        throw new Error(`captcha 页面被占用超过 ${this.#pageWaitTimeoutMs}ms（疑似上一次 mint 未归还）`)
      }
      await this.#sleep(50)
    }
    this.#pageBusy = true

    try {
      const existing = this.#reusableFrame
      if (existing !== undefined) {
        /** 严格小于：`idleReuseMs = 0` 的语义才是「每次都新建帧」。 */
        const idle = this.#now() - existing.lastUsedAt
        if (!forceFresh && idle < this.#idleReuseMs) return existing
        await this.#discardFrame(existing)
      }
      return await this.#createFrame()
    } catch (error) {
      this.#pageBusy = false
      throw error
    }
  }

  async #createFrame() {
    const host = await this.#ensureHost()
    const frameId = `${this.#frameIdPrefix}${Math.random().toString(36).slice(2, 8)}`

    const created = await host.send('Runtime.evaluate', {
      expression: buildFrameCreateExpression(frameId, this.#origin),
      returnByValue: true,
    })
    if (created?.result?.value !== 'created') {
      throw new Error(`无法在宿主 renderer 里创建 captcha iframe（${String(created?.result?.value)}）`)
    }

    const sessionId = await host.waitForIframeSession(this.#frameAttachTimeoutMs)
    if (sessionId === undefined) {
      await this.#removeFrameElement(frameId)
      throw new Error('没有等到 captcha iframe 被 CDP 附加（可能是站点隔离未生效）')
    }

    try {
      await this.#waitForFrameReady(host, sessionId)
    } catch (error) {
      await this.#removeFrameElement(frameId)
      throw error instanceof Error ? error : new Error(String(error))
    }

    const frame = { frameId, sessionId, prepared: false, lastUsedAt: this.#now() }
    this.#reusableFrame = frame
    return frame
  }

  /** 轮询 iframe 文档直到可用（OOPIF 上不能用 Page.* 域）。 */
  async #waitForFrameReady(host, sessionId) {
    const deadline = this.#now() + this.#frameAttachTimeoutMs
    for (;;) {
      try {
        const result = await host.sendToSession(sessionId, 'Runtime.evaluate', {
          expression: 'document.readyState',
          returnByValue: true,
        }, 3_000)
        const state = result?.result?.value
        if (typeof state === 'string' && state !== 'loading') return
      } catch {
        // 文档可能还在初始化，重试。
      }
      if (this.#now() >= deadline) {
        throw new Error(`captcha iframe 文档未在 ${this.#frameAttachTimeoutMs}ms 内就绪`)
      }
      await this.#sleep(150)
    }
  }

  async #discardFrame(frame) {
    if (this.#reusableFrame === frame) this.#reusableFrame = undefined
    await this.#removeFrameElement(frame.frameId)
  }

  async #removeFrameElement(frameId) {
    const host = this.#host
    if (host === undefined) return
    try {
      await host.send('Runtime.evaluate', {
        expression: `document.getElementById(${JSON.stringify(frameId)})?.remove(); 'removed'`,
        returnByValue: true,
      })
    } catch {
      // 宿主页面可能已重载/关闭。
    }
  }

  /** 释放资源：**只**移除我们自己的 iframe 并关闭我们自己的连接。 */
  dispose() {
    const frame = this.#reusableFrame
    this.#reusableFrame = undefined
    this.#pageBusy = false
    if (frame !== undefined) void this.#removeFrameElement(frame.frameId)
    try {
      this.#host?.close()
    } catch {
      // 已关闭。
    }
    this.#host = undefined
  }

  /**
   * 用宿主的 Electron 直接打开一个可见窗口（**登录 / 粘贴凭据用**）。
   *
   * DSH 是 Electron 宿主：`Target.createTarget` 不被支持，但 `window.open` 在
   * renderer 里可用（会开出新 BrowserWindow）。返回是否成功；失败时调用方
   * 应当回退到「让用户在系统浏览器里打开链接」。用完即关（传入 closeAfterMs）。
   */
  async openWindow(url, options = {}) {
    const host = await this.#ensureHost()
    const host_ = await host.send('Runtime.evaluate', {
      expression: `(() => { const w = window.open(${JSON.stringify(url)}, '_blank'); return w ? 'opened' : 'blocked'; })()`,
      returnByValue: true,
    })
    const opened = host_?.result?.value === 'opened'
    this.#log(`[captcha] openWindow(${url}) → ${opened ? 'opened' : 'blocked'}`)
    if (opened && typeof options.closeAfterMs === 'number' && options.closeAfterMs > 0) {
      setTimeout(() => {
        void host.send('Runtime.evaluate', { expression: 'window.close()', returnByValue: true }).catch(() => {})
      }, options.closeAfterMs).unref?.()
    }
    return opened
  }
}

/** 反检测补丁（必须最先求值：SDK 的请求特征取决于它被加载时读到的值）。 */
export const STEALTH_PATCH = `
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
Object.defineProperty(navigator, 'plugins', {
  get: () => [{ name: 'PDF Viewer' }, { name: 'Chrome PDF Viewer' }, { name: 'Chromium PDF Viewer' }],
});
Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
window.chrome = window.chrome ?? { runtime: {}, loadTimes: () => {}, csi: () => {} };
try {
  const originalGetParameter = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function (parameter) {
    if (parameter === 37445) return 'Intel Inc.';
    if (parameter === 37446) return 'Intel Iris OpenGL Engine';
    return originalGetParameter.call(this, parameter);
  };
} catch (error) { /* 内核无 WebGL 时忽略 */ }
`

/** 构造请求体里那段「建 DOM」的表达式。 */
export function buildDomExpression() {
  return `document.body.innerHTML =
    '<div id="${CAPTCHA_CONTAINER_ID}" aria-hidden="true">' +
    '<div id="${CAPTCHA_ELEMENT_ID}"></div>' +
    '<button id="${CAPTCHA_BUTTON_ID}">verify</button></div>'; 'ok'`
}

/** 构造注入 SDK 的表达式（用 `<script src>`，简单可靠）。 */
export function buildSdkInjectExpression() {
  return `new Promise((resolve) => {
    if (typeof window.initAliyunCaptcha === 'function') { resolve('already'); return; }
    const script = document.createElement('script');
    script.src = ${JSON.stringify(CAPTCHA_SDK_URL)};
    script.async = true;
    script.onload = () => resolve(typeof window.initAliyunCaptcha);
    script.onerror = () => resolve('onerror');
    document.head.appendChild(script);
    setTimeout(() => resolve('timeout'), 25000);
  })`
}

/** 构造「帧是否仍然就绪」的探测表达式。 */
export function buildFrameProbeExpression() {
  return `JSON.stringify({
    sdk: typeof window.initAliyunCaptcha,
    el: !!document.getElementById(${JSON.stringify(CAPTCHA_ELEMENT_ID)}),
    btn: !!document.getElementById(${JSON.stringify(CAPTCHA_BUTTON_ID)}),
  })`
}

/**
 * 构造「触发无感验证并等 param」的表达式。
 *
 * 降级检测：我们调的是无感验证，但阿里云若判设备风险会**静默弹交互式验证**，
 * 官方不给回调 ⇒ 只能自己轮询 DOM（用「曾经出现过」而非「此刻存在」）。
 */
export function buildMintExpression(config) {
  return `new Promise((resolve) => {
    const done = (payload) => resolve(JSON.stringify(payload));
    let sawInteractive = false;
    const detectInteractive = () => {
      try {
        if (sawInteractive) return;
        if (document.querySelector('#aliyunCaptcha-window-popup')
          || document.querySelector('#aliyunCaptcha-sliding-slider')
          || document.querySelector('#aliyunCaptcha-puzzle')) {
          sawInteractive = true;
        }
      } catch (error) { /* 检测失败不影响产出 */ }
    };
    const pollTimer = setInterval(detectInteractive, 200);
    try {
      window.AliyunCaptchaConfig = ${JSON.stringify({ region: config.region, prefix: config.prefix })};
    } catch (error) { done({ stage: 'cfg-throw', err: String(error) }); }
    try {
      initAliyunCaptcha({
        SceneId: ${JSON.stringify(config.sceneId)},
        mode: 'popup',
        element: '#${CAPTCHA_ELEMENT_ID}',
        button: document.getElementById('${CAPTCHA_BUTTON_ID}'),
        getInstance: (instance) => {
          try {
            if (typeof instance.startTracelessVerification === 'function') {
              instance.startTracelessVerification();
            } else if (typeof instance.show === 'function') {
              sawInteractive = true;
              instance.show();
            }
          } catch (error) {
            done({ stage: 'call-throw', err: String((error && error.message) || error) });
          }
        },
        success: (param) => {
          detectInteractive();
          clearInterval(pollTimer);
          done({ stage: 'success', param, interactive: sawInteractive });
        },
        fail: (error) => {
          clearInterval(pollTimer);
          done({ stage: 'fail', err: String((error && error.message) || JSON.stringify(error)), interactive: sawInteractive });
        },
        onError: (error) => {
          clearInterval(pollTimer);
          done({ stage: 'onError', err: String((error && error.message) || JSON.stringify(error)), interactive: sawInteractive });
        },
      });
    } catch (error) {
      clearInterval(pollTimer);
      done({ stage: 'init-throw', err: String((error && error.message) || error) });
    }
    setTimeout(() => {
      clearInterval(pollTimer);
      done({ stage: 'timeout', interactive: sawInteractive });
    }, 60000);
  })`
}

/** SDK 需要的 DOM id（与官方 `zcode-aliyun-captcha-*` 一致）。 */
export const CAPTCHA_CONTAINER_ID = 'zcode-aliyun-captcha-container'
export const CAPTCHA_ELEMENT_ID = 'zcode-aliyun-captcha-element'
export const CAPTCHA_BUTTON_ID = 'zcode-aliyun-captcha-button'

/**
 * captcha param 的合法判据（三条全中才算合法）。
 * 任一条不中即判为降级 —— **不发请求**，省一次注定 3007 的往返。
 */
export function validateCaptchaParam(param) {
  if (typeof param !== 'string' || param.length === 0) return { ok: false, reason: 'captcha param 缺失' }
  if (param.length < 200) {
    return { ok: false, reason: `captcha param 长度 ${param.length} < 200（疑似 SDK 降级输出，发了必 3007）` }
  }
  let decoded
  try {
    decoded = Buffer.from(param, 'base64').toString('utf8')
  } catch {
    return { ok: false, reason: 'captcha param 不是合法 base64' }
  }
  let parsed
  try {
    parsed = JSON.parse(decoded)
  } catch {
    return { ok: false, reason: 'captcha param 解出的不是 JSON' }
  }
  if (typeof parsed.certifyId !== 'string' || parsed.certifyId.length === 0) {
    return { ok: false, reason: 'captcha param 缺 certifyId' }
  }
  if (typeof parsed.securityToken !== 'string' || parsed.securityToken.length < 50) {
    return { ok: false, reason: 'securityToken 缺失或过短（< 50）' }
  }
  return { ok: true }
}
