const UNIT_MS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1_000,
  sec: 1_000,
  m: 60_000,
  min: 60_000,
  h: 3_600_000
}

const FULL = /^(?:\d+(?:\.\d+)?\s*(?:ms|sec|min|s|m|h)\s*)+$/
const PART = /(\d+(?:\.\d+)?)\s*(ms|sec|min|s|m|h)/g

/**
 * Parse a human duration into milliseconds.
 *
 * Accepts a plain number (milliseconds) or unit-suffixed parts that may be
 * combined: `500ms`, `30s`, `5m`, `1h30m`, `1.5s`.
 *
 * @throws {RangeError} when the value cannot be parsed.
 */
export function parseDuration(value: string | number): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) throw new RangeError(`Invalid duration: ${value}`)
    return value
  }
  const text = value.trim().toLowerCase()
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text)
  if (!FULL.test(text)) {
    throw new RangeError(`Invalid duration: "${value}" (use e.g. 500ms, 30s, 5m, 1h30m)`)
  }
  let total = 0
  for (const [, amount, unit] of text.matchAll(PART)) {
    total += Number(amount) * (UNIT_MS[unit ?? ''] ?? 0)
  }
  return Math.round(total)
}

/** Format milliseconds for logs: `850ms`, `12.3s`, `4m 05s`, `1h 02m`. */
export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`
  const totalSeconds = Math.round(ms / 1_000)
  const h = Math.floor(totalSeconds / 3_600)
  const m = Math.floor((totalSeconds % 3_600) / 60)
  const s = totalSeconds % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}h ${pad(m)}m` : `${m}m ${pad(s)}s`
}
