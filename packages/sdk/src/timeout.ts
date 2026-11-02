import { toAbortError } from './abort.js'
import { TimeoutError } from './errors.js'

export interface TimeoutOptions {
  /** Parent signal; aborting it cancels the operation too. */
  signal?: AbortSignal
  /** Message for the TimeoutError. */
  message?: string
  /**
   * After a timeout/abort, wait up to this many ms for `fn` to settle before
   * rejecting, so cleanup finishes before the caller moves on. Default 0.
   */
  settle?: number
}

/** Resolve when `promise` settles or after `ms`, whichever comes first. */
async function settled(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  await Promise.race([
    promise.then(
      () => undefined,
      () => undefined
    ),
    new Promise<void>(resolve => {
      timer = setTimeout(resolve, ms)
    })
  ])
  clearTimeout(timer)
}

/**
 * Run `fn` with a time budget. `fn` receives an AbortSignal that fires on
 * timeout or when the parent signal aborts; pass it on (fetch, exec, sleep) so
 * the work actually stops instead of leaking in the background.
 *
 * A `timeoutMs` of 0, a negative value or Infinity disables the timeout.
 *
 * @throws {TimeoutError} when the budget is exceeded.
 * @throws {AbortError} when the parent signal aborts.
 */
export async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  options: TimeoutOptions = {}
): Promise<T> {
  const { signal: parent } = options
  if (parent?.aborted) throw toAbortError(parent)

  const controller = new AbortController()
  const onParentAbort = (): void => controller.abort(parent?.reason)
  parent?.addEventListener('abort', onParentAbort, { once: true })

  let timer: NodeJS.Timeout | undefined
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(toAbortError(controller.signal))
    controller.signal.addEventListener('abort', onAbort, { once: true })
  })
  if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
    timer = setTimeout(
      () => controller.abort(new TimeoutError(timeoutMs, options.message)),
      timeoutMs
    )
  }

  // Deferred call: a synchronous throw from `fn` becomes a rejection handled
  // below, so the timer and listeners are always cleaned up.
  const work = Promise.resolve().then(async () => fn(controller.signal))
  try {
    return await Promise.race([work, aborted])
  } catch (err) {
    // Give the aborted work time to actually stop (e.g. a killed process tree)
    // so a retry or cleanup step does not overlap with it.
    const settleMs = options.settle ?? 0
    if (controller.signal.aborted && settleMs > 0) await settled(work, settleMs)
    throw err
  } finally {
    clearTimeout(timer)
    parent?.removeEventListener('abort', onParentAbort)
    if (onAbort) controller.signal.removeEventListener('abort', onAbort)
  }
}
