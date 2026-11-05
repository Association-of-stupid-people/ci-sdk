import { oneLine } from './payload.js'

export type Fetch = typeof fetch

export interface SendOptions {
  /** Tries in all (only 429 and 5xx are retried). Default 3. */
  attempts?: number
  /** Waits before the 2nd, 3rd... try after a 5xx. Default 5 s, 30 s. */
  backoffMs?: number[]
  /** Longest `Retry-After` honoured. Default 2 min. */
  maxRetryAfterMs?: number
  /** Per request. Default 30 s. */
  timeoutMs?: number
  fetchImpl?: Fetch
  sleep?: (ms: number) => Promise<void>
  log?: (message: string) => void
}

export interface SendResult {
  ok: boolean
  attempts: number
  /** Last HTTP status (none after a network error). */
  status?: number
  /** Why it was not posted (status + response body, or the network error). */
  error?: string
}

/** The webhook's `ma=` key (its secret), or ''. */
export function webhookKey(url: string): string {
  try {
    return new URL(url).searchParams.get('ma') ?? ''
  } catch {
    return ''
  }
}

/** Every spelling of the key a message could hold: decoded, and as written in the URL. */
export function webhookKeyForms(url: string): string[] {
  const raw = /[?&]ma=([^&#]*)/.exec(url)?.[1] ?? ''
  return [...new Set([webhookKey(url), raw])].filter(k => k.length >= 8)
}

/** What a log may show of a webhook: at most the first 12 characters of its `ma=` key. */
export function webhookLabel(url: string): string {
  try {
    const key = new URL(url).searchParams.get('ma')
    // At most 12 characters, and never more than half of the key.
    return key
      ? `ma=${key.slice(0, Math.min(12, Math.floor(key.length / 2)))}…`
      : 'webhook (no ma= key)'
  } catch {
    return 'webhook (not a URL)'
  }
}

const sleepFor = async (ms: number): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, ms)
  })

/** Seconds (or an HTTP date) from a Retry-After header, in ms. */
function retryAfterMs(header: string | null, fallback: number, max: number): number {
  if (header) {
    const seconds = Number(header)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, max)
    const date = Date.parse(header)
    if (!Number.isNaN(date)) return Math.min(Math.max(0, date - Date.now()), max)
  }
  return Math.min(fallback, max)
}

/**
 * POST the payload as UTF-8 JSON. 429 waits for `Retry-After`, 5xx backs off (5 s, 30 s); any
 * other status (a redirect too: it is not followed), or a network error, stops at once (a POST
 * that may have arrived is not sent twice). Never throws, and never puts the URL or its key in a
 * message.
 */
export async function sendPayload(
  url: string,
  payload: unknown,
  options: SendOptions = {}
): Promise<SendResult> {
  const attempts = Math.max(1, options.attempts ?? 3)
  const backoff = options.backoffMs ?? [5_000, 30_000]
  const maxRetryAfter = options.maxRetryAfterMs ?? 120_000
  const doFetch = options.fetchImpl ?? fetch
  const sleep = options.sleep ?? sleepFor
  const log = options.log ?? (() => undefined)
  const body = JSON.stringify(payload)
  const label = webhookLabel(url)
  const keys = webhookKeyForms(url)
  const redact = (s: string): string =>
    keys.reduce((out, key) => out.split(key).join(label), s.split(url).join(label))

  for (let attempt = 1; ; attempt++) {
    let res: Response
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000)
      })
    } catch (err) {
      const cause =
        err instanceof Error && err.cause instanceof Error ? `: ${err.cause.message}` : ''
      return {
        ok: false,
        attempts: attempt,
        error: redact(`${err instanceof Error ? err.message : String(err)}${cause}`)
      }
    }
    if (res.ok) return { ok: true, attempts: attempt, status: res.status }
    // One line: the body goes into the log, where a line starting with `::` is a command.
    const text = oneLine(redact(await res.text().catch(() => ''))).slice(0, 200)
    const error = `HTTP ${res.status}${text ? ` ${text}` : ''}`
    const retryable = res.status === 429 || res.status >= 500
    if (!retryable || attempt >= attempts)
      return { ok: false, attempts: attempt, status: res.status, error }
    const wait =
      res.status === 429
        ? retryAfterMs(res.headers.get('retry-after'), backoff[0] ?? 5_000, maxRetryAfter)
        : (backoff[attempt - 1] ?? backoff.at(-1) ?? 5_000)
    log(
      `Chat webhook answered ${error}; retrying in ${Math.round(wait / 1000)}s (try ${attempt + 1}/${attempts})`
    )
    await sleep(wait)
  }
}
