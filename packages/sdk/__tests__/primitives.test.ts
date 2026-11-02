import { describe, expect, it, vi } from 'vitest'
import {
  AbortError,
  RetryError,
  TimeoutError,
  backoffDelay,
  formatDuration,
  parseDuration,
  retry,
  sleep,
  withTimeout
} from '../src/index.js'

describe('parseDuration', () => {
  it.each([
    ['500', 500],
    ['500ms', 500],
    ['30s', 30_000],
    ['1.5s', 1_500],
    ['5m', 300_000],
    ['1h30m', 5_400_000],
    ['1m 30s', 90_000],
    [' 2 S ', 2_000],
    [250, 250]
  ])('%s -> %d', (input, expected) => {
    expect(parseDuration(input)).toBe(expected)
  })

  it.each(['', 'abc', '5x', '1h foo', '-1s'])('rejects %j', input => {
    expect(() => parseDuration(input)).toThrow(RangeError)
  })

  it('rejects negative numbers', () => {
    expect(() => parseDuration(-1)).toThrow(RangeError)
  })
})

describe('formatDuration', () => {
  it.each([
    [850, '850ms'],
    [12_300, '12.3s'],
    [245_000, '4m 05s'],
    [3_720_000, '1h 02m']
  ])('%d -> %s', (ms, text) => {
    expect(formatDuration(ms)).toBe(text)
  })
})

describe('retry', () => {
  it('returns the first success', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('flaky')).mockResolvedValue('ok')
    const onRetry = vi.fn()
    await expect(retry(fn, { attempts: 3, minDelay: 1, onRetry })).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
    expect(onRetry).toHaveBeenCalledWith(expect.any(Error), 1, expect.any(Number))
  })

  it('throws RetryError with every error when attempts run out', async () => {
    let n = 0
    const err = await retry(
      async () => {
        throw new Error(`boom ${++n}`)
      },
      { attempts: 3, minDelay: 0 }
    ).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RetryError)
    expect((err as RetryError).attempts).toBe(3)
    expect((err as RetryError).errors).toHaveLength(3)
    expect((err as RetryError).message).toContain('boom 3')
  })

  it('rethrows the original error when only one attempt is configured', async () => {
    const original = new Error('once')
    await expect(retry(() => Promise.reject(original), { attempts: 1 })).rejects.toBe(original)
  })

  it('stops immediately when retryIf returns false', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('4xx'))
    await expect(retry(fn, { attempts: 5, minDelay: 0, retryIf: () => false })).rejects.toThrow(
      '4xx'
    )
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('does not retry cancellation', async () => {
    const fn = vi.fn().mockRejectedValue(new AbortError())
    await expect(retry(fn, { attempts: 5, minDelay: 0 })).rejects.toBeInstanceOf(AbortError)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('uses exponential backoff capped by maxDelay, with injectable jitter', async () => {
    expect([1, 2, 3, 4, 5].map(a => backoffDelay(a, 100, 1_000, 2))).toEqual([
      100, 200, 400, 800, 1_000
    ])
    const delays: number[] = []
    await retry(() => Promise.reject(new Error('x')), {
      attempts: 4,
      minDelay: 1,
      maxDelay: 3,
      random: () => 0.5,
      onRetry: (_e, _a, d) => delays.push(d)
    }).catch(() => undefined)
    expect(delays).toEqual([1, 1, 2]) // round(0.5*1), round(0.5*2), round(0.5*3)
  })

  it('rejects a non-finite attempts value instead of retrying forever', async () => {
    await expect(retry(async () => 1, { attempts: Number.NaN })).rejects.toThrow(RangeError)
  })

  it('retries an AbortError thrown by fn when its own signal did not fire', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('x'), { name: 'AbortError' }))
      .mockResolvedValue('ok')
    const signal = new AbortController().signal
    await expect(retry(fn, { attempts: 2, minDelay: 0, signal })).resolves.toBe('ok')
  })

  it('aborts while waiting between attempts', async () => {
    const controller = new AbortController()
    const p = retry(() => Promise.reject(new Error('x')), {
      attempts: 5,
      minDelay: 10_000,
      jitter: false,
      signal: controller.signal,
      onRetry: () => controller.abort()
    })
    await expect(p).rejects.toBeInstanceOf(AbortError)
  })
})

describe('withTimeout', () => {
  it('resolves when fast enough', async () => {
    await expect(withTimeout(async () => 'done', 1_000)).resolves.toBe('done')
  })

  it('rejects with TimeoutError and aborts the inner signal', async () => {
    let inner: AbortSignal | undefined
    const err = await withTimeout(async signal => {
      inner = signal
      await sleep(5_000, signal)
    }, 20).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TimeoutError)
    expect(inner?.aborted).toBe(true)
  })

  it('propagates parent cancellation as AbortError', async () => {
    const parent = new AbortController()
    const p = withTimeout(async signal => sleep(5_000, signal), 0, { signal: parent.signal })
    parent.abort()
    await expect(p).rejects.toBeInstanceOf(AbortError)
  })

  it('cleans up when fn throws synchronously (no late unhandled TimeoutError)', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      await expect(
        withTimeout(() => {
          throw new Error('boom')
        }, 30)
      ).rejects.toThrow('boom')
      await sleep(80)
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('treats 0 as no timeout', async () => {
    await expect(withTimeout(async () => sleep(30).then(() => 1), 0)).resolves.toBe(1)
  })
})
