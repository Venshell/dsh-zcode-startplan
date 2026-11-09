/**
 * 「上游黑洞」测试夹具：一个**永不产出、也永不结束**的响应流。
 *
 * 复刻 issue #4 的真实形态 —— 额度用尽后上游对该账号不再出流：
 * HTTP 200 已经回来了，但 body 里一个字节都没有。谁在等它，就必须有自己的超时，
 * 否则最终只会被宿主 ~300s 的超时收成一句笼统的 `PROVIDER_ERROR`。
 *
 * 用法：
 * ```js
 * const hanging = new HangingStream()
 * ... body: hanging.stream ...
 * t.after(() => hanging.release())   // 让挂起的读操作优雅退出，别把测试进程吊死
 * ```
 */
export class HangingStream {
  /** @type {ReadableStream<Uint8Array>} */
  stream
  #controllers = []
  #released = false

  constructor() {
    let captured
    this.stream = new ReadableStream({
      start: (controller) => {
        captured = controller
        this.#controllers.push(controller)
      },
      cancel: () => {
        /** 被消费者取消（超时后 `decoder.cancel()`）—— 标记已释放，避免后续写报错。 */
        this.#released = true
      },
    })
    this.#controller = captured
  }

  #controller

  /** 主动结束这条流（测试收尾用；读操作会以 `done` 退出）。 */
  release() {
    if (this.#released) return
    this.#released = true
    try {
      this.#controller?.close()
    } catch {
      /** 已经被取消：无需再关。 */
    }
  }
}
