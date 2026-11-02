import { AbortError, CiError } from './errors.js'

/** Resolve after `ms`, or reject with AbortError as soon as `signal` aborts. */
export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal)
  if (ms <= 0) return
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(toAbortError(signal))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Throw if the signal has fired (see {@link toAbortError}). */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw toAbortError(signal)
}

/**
 * Error to throw for an aborted signal. An SDK error used as the abort reason
 * (e.g. TimeoutError) is returned as-is so callers can tell a timeout from a
 * cancellation; anything else becomes an AbortError with the reason as `cause`.
 */
export function toAbortError(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason
  if (reason instanceof CiError) return reason
  return new AbortError('Operation was cancelled', { cause: reason })
}
