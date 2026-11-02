import { sleep, throwIfAborted } from './abort.js'
import { parseDuration } from './duration.js'
import { RetryError, isAbortError } from './errors.js'

export interface RetryOptions {
  /** Total attempts including the first one. Default 3. */
  attempts?: number
  /** Delay before the 2nd attempt (ms or duration string). Default 1s. */
  minDelay?: number | string
  /** Upper bound for any single delay. Default 30s. */
  maxDelay?: number | string
  /** Exponential growth factor between attempts. Default 2. */
  factor?: number
  /** Full jitter (random delay in [0, computed]) to avoid thundering herds. Default true. */
  jitter?: boolean
  /**
   * Return false to stop retrying for this error (e.g. HTTP 4xx, lint failure).
   * Default: retry everything except cancellation and timeouts of the whole run.
   */
  retryIf?: (error: unknown, attempt: number) => boolean
  /** Called before sleeping; use it to log. */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void
  /** Stops waiting/retrying when aborted. */
  signal?: AbortSignal
  /** Injectable RNG for deterministic tests. */
  random?: () => number
}

export interface AttemptInfo {
  /** 1-based attempt number. */
  attempt: number
  signal: AbortSignal | undefined
}

/** Delay before attempt `attempt + 1`, without jitter. */
export function backoffDelay(
  attempt: number,
  minDelayMs: number,
  maxDelayMs: number,
  factor: number
): number {
  return Math.min(maxDelayMs, minDelayMs * factor ** (attempt - 1))
}

/**
 * Run `fn` until it succeeds or attempts run out, with exponential backoff.
 *
 * Use it around known-flaky operations only (package installs, registry
 * pushes, API calls) and keep `attempts` small: retrying deterministic
 * failures only makes CI slower.
 *
 * @throws {RetryError} carrying every error once attempts (> 1) are exhausted.
 * @throws the original error when `retryIf` returns false or the run is cancelled.
 */
export async function retry<T>(
  fn: (info: AttemptInfo) => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const requested = options.attempts ?? 3
  if (!Number.isFinite(requested)) throw new RangeError(`retry: invalid attempts ${requested}`)
  const attempts = Math.max(1, Math.floor(requested))
  const minDelay = parseDuration(options.minDelay ?? 1_000)
  const maxDelay = parseDuration(options.maxDelay ?? 30_000)
  const factor = options.factor ?? 2
  const jitter = options.jitter ?? true
  const random = options.random ?? Math.random
  const { signal } = options
  const errors: unknown[] = []

  for (let attempt = 1; ; attempt++) {
    throwIfAborted(signal)
    try {
      return await fn({ attempt, signal })
    } catch (error) {
      // Stop on cancellation: our own signal, or (without one) an AbortError.
      if (signal?.aborted || (!signal && isAbortError(error))) throw error
      errors.push(error)
      if (options.retryIf && !options.retryIf(error, attempt)) throw error
      if (attempts === 1) throw error // no retry configured: keep the original error
      if (attempt >= attempts) throw new RetryError(attempt, errors)

      const base = backoffDelay(attempt, minDelay, maxDelay, factor)
      const delay = Math.round(jitter ? random() * base : base)
      options.onRetry?.(error, attempt, delay)
      await sleep(delay, signal)
    }
  }
}
