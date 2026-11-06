import type { Build, Report } from './report.js'

/**
 * Limits of the team chat webhook (Slack Block Kit subset). The server keeps at most 50 blocks and
 * 16 kB of blocks after normalising them, dropping blocks from the end: the payload stays under
 * `blocksBytes` to leave room for that normalisation. The compact card uses only two blocks.
 */
export const LIMITS = {
  blocks: 50,
  blocksBytes: 14_000,
  alertText: 3_000,
  /** The one-line `text` (push notification). */
  text: 300
}

export type TextObject = { type: 'mrkdwn' | 'plain_text'; text: string }
export type AlertLevel = 'default' | 'info' | 'warning' | 'error' | 'success'
/** The compact card: one `alert` (3 short lines) and one `context` block per message (ADDENDUM 4). */
export type Block =
  | { type: 'alert'; level: AlertLevel; text: TextObject }
  | { type: 'context'; elements: TextObject[] }

export interface Payload {
  text: string
  blocks: Block[]
}

/** Escape text for mrkdwn: no link, mention (`<!channel>`, `<@U1>`) or entity can be injected. */
export const escapeMrkdwn = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** U+2060 WORD JOINER: invisible, and it breaks the chat's plain-URL and `@name` detection. */
const WJ = String.fromCharCode(0x2060)

/**
 * Stop the chat from turning untrusted text into links or mentions: the server links plain URLs
 * (`https://x`, `x.com/path`). A word joiner goes into `://`, after a `.` followed by a letter and
 * after `@`; the text looks the same.
 */
export const defang = (s: string): string =>
  s
    .replace(/:\/\//g, `:${WJ}//`)
    .replace(/\.(?=\p{L})/gu, `.${WJ}`)
    .replace(/@/g, `@${WJ}`)

/** One line, no control characters (C0, C1, line and paragraph separators). */
export function oneLine(value: string | number | undefined | null): string {
  const s =
    typeof value === 'string'
      ? value
      : typeof value === 'number' && Number.isFinite(value)
        ? String(value)
        : ''
  let out = ''
  for (const ch of s) {
    const c = ch.codePointAt(0)!
    const control = c <= 0x1f || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029
    out += control ? ' ' : ch
  }
  return out.replace(/ {2,}/g, ' ').trim()
}

/**
 * Cut to `max` UTF-16 units (the unit of the chat limits), ending with an ellipsis; a surrogate
 * pair (emoji) is never split.
 */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  if (max <= 0) return ''
  let out = ''
  for (const ch of s) {
    if (out.length + ch.length > max - 1) break
    out += ch
  }
  return `${out}…`
}

/** Untrusted text as mrkdwn: one line, defanged, cut, then escaped (an entity is never cut). */
export const untrusted = (s: string | number | undefined | null, max: number): string =>
  escapeMrkdwn(truncate(defang(oneLine(s)), max))

/** An http(s) URL safe inside `<url|label>`, or undefined. */
export function safeUrl(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined
    const href = u.href.replace(/[|<> ]/g, c => encodeURIComponent(c))
    return href.length <= 500 ? href : undefined
  } catch {
    return undefined
  }
}

/** mrkdwn link; the label is escaped (labels never hold untrusted text with `|`). */
export function mrkdwnLink(url: string | undefined, label: string): string {
  const href = safeUrl(url)
  const text = escapeMrkdwn(defang(label.replace(/\|/g, '/')))
  return href ? `<${href}|${text}>` : text
}

/** `12m34s`, `1h05m`, `45s`. */
export function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return ''
  const s = Math.round(seconds)
  if (s >= 3600)
    return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
  if (s >= 60) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
  return `${s}s`
}

/** Whole minutes only, e.g. `35m`, for the push text; falls back to `formatDuration` under a minute. */
function durationMinutes(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 60)
    return formatDuration(seconds)
  return `${Math.floor(seconds / 60)}m`
}

/** `160.0 MB`, or '' when the size is unknown. */
const formatSize = (bytes: number | undefined): string =>
  bytes === undefined || !Number.isFinite(bytes) ? '' : `${(bytes / 1048576).toFixed(1)} MB`

const short = (sha: string | number | undefined): string => oneLine(sha).slice(0, 7)

/** The run number, as text. */
const runNumber = (r: Report): string => truncate(oneLine(r.run.number), 20)

/** `1.0.2 (10002)`, or '' without a version. */
function versionLabel(r: Report): string {
  const name = oneLine(r.version?.name)
  const code = truncate(oneLine(r.version?.code), 20)
  if (!name && !code) return ''
  return name ? `${truncate(name, 60)}${code ? ` (${code})` : ''}` : `code ${code}`
}

/** `Release v1.0.2 (10002)` / `Debug #128`: the title with the version code (the card's first line). */
function titleFull(r: Report): string {
  if (r.kind === 'release') {
    const tag = r.ref?.type === 'tag' ? oneLine(r.ref.name) : ''
    const code = truncate(oneLine(r.version?.code), 20)
    const name = truncate(tag || oneLine(r.version?.name), 60) || `#${runNumber(r)}`
    return `Release ${name}${code ? ` (${code})` : ''}`
  }
  return `Debug #${runNumber(r)}`
}

/** `Release v1.0.2` / `Debug #128`: the title without the code (the short push text). */
function titleShort(r: Report): string {
  if (r.kind === 'release') {
    const tag = r.ref?.type === 'tag' ? oneLine(r.ref.name) : ''
    const name = truncate(tag || oneLine(r.version?.name), 60) || `#${runNumber(r)}`
    return `Release ${name}`
  }
  return `Debug #${runNumber(r)}`
}

/** The product name shown on the card (Unity productName), falling back to the repo name. */
const productName = (r: Report): string => oneLine(r.game) || oneLine(r.name)

/** START, or the END variant. */
export type Variant = 'start' | 'success' | 'partial' | 'failure' | 'cancelled'

/** The run result: a cancelled job wins over a failed one, which wins over success. */
export function runStatus(r: Report): 'success' | 'failure' | 'cancelled' {
  const results = Object.values(r.jobs ?? {})
  if (r.status === 'cancelled' || results.includes('cancelled')) return 'cancelled'
  if (r.status === 'failure' || results.includes('failure')) return 'failure'
  return 'success'
}

/**
 * Which message this report is: `start`, or for the end `success`, `partial` (the run failed but
 * every main build exists: only segments, or an upload, failed), `failure` or `cancelled`.
 */
export function messageVariant(r: Report): Variant {
  if (r.phase === 'start') return 'start'
  const status = runStatus(r)
  if (status !== 'failure') return status
  const mainMissing =
    r.builds.length === 0 || r.builds.some(b => b.kind !== 'segment' && b.status !== 'success')
  return mainMissing ? 'failure' : 'partial'
}

interface Summary {
  variant: Variant
  ok: number
  total: number
  emoji: string
}

function summarize(r: Report): Summary {
  const variant = messageVariant(r)
  const built = r.builds.filter(b => b.status !== 'skipped')
  const emoji = {
    start: '🛠️',
    success: r.kind === 'release' ? '🚀' : '✅',
    partial: '⚠️',
    failure: '❌',
    cancelled: '🚫'
  }[variant]
  return {
    variant,
    ok: built.filter(b => b.status === 'success').length,
    total: built.length,
    emoji
  }
}

/** The notification line: short (~40 chars), one line, escaped, no links (ADDENDUM 4). */
export function summaryText(r: Report, s: Summary = summarize(r)): string {
  const product = productName(r)
  const t = titleShort(r)
  const count = `${s.ok}/${s.total} OK`
  const step = truncate(oneLine(r.failedStep) || 'unknown step', 80)
  let parts: string[]
  switch (s.variant) {
    case 'start':
      parts = [product, `Đang build ${t}`]
      break
    case 'cancelled':
      parts = [product, `${t} cancelled`]
      break
    case 'success':
      parts =
        r.kind === 'release'
          ? [product, `${t} ready`]
          : [product, t, count, durationMinutes(r.durationSeconds)]
      break
    case 'partial':
      parts = r.kind === 'release' ? [product, `${t} · ${step} failed`] : [product, t, count]
      break
    default:
      parts = r.kind === 'release' ? [product, `${t} failed: ${step}`] : [product, t, count]
  }
  // Not defanged: with blocks, `text` is only the push notification and the search text.
  const line = `${s.emoji} ${parts.filter(Boolean).join(' · ')}`
  // Cut before escaping, so an entity is never cut in half.
  let max = LIMITS.text
  let text = escapeMrkdwn(truncate(line, max))
  while (text.length > LIMITS.text) text = escapeMrkdwn(truncate(line, (max -= 10)))
  return text
}

const ALERT_LEVEL: Record<Variant, AlertLevel> = {
  start: 'info',
  success: 'success',
  partial: 'warning',
  failure: 'error',
  cancelled: 'default'
}

/** The first line's result label after the title. */
function resultLabel(r: Report, s: Summary): string {
  if (s.variant === 'cancelled') return 'cancelled'
  if (r.kind === 'release')
    return s.variant === 'success' ? '' : s.variant === 'partial' ? 'built' : 'failed'
  return `${s.ok}/${s.total} OK`
}

/** `❌ <name>: <step> (<log>)` for a failed build (release uses the overall step, no name). */
function failedFact(r: Report): string {
  if (r.kind === 'release') {
    const step = oneLine(r.failedStep) ? untrusted(r.failedStep, 120) : 'unknown step'
    const log = safeUrl(r.logUrl) ? ` (${mrkdwnLink(r.logUrl, 'log')})` : ''
    return `❌ ${step}${log}`
  }
  const failed = r.builds.filter(b => b.status === 'failure')
  const shown = failed.slice(0, 2).map(b => {
    const step = oneLine(b.failedStep) ? untrusted(b.failedStep, 80) : 'failed'
    const log = safeUrl(b.logUrl) ? ` (${mrkdwnLink(b.logUrl, 'log')})` : ''
    return `❌ ${untrusted(b.name, 60)}: ${step}${log}`
  })
  if (failed.length > 2) shown.push(`+${failed.length - 2} more`)
  return shown.join(' · ')
}

/** The second line's key fact, after the time (ADDENDUM 4). */
function keyFact(r: Report, s: Summary): string {
  if (s.variant === 'start' || s.variant === 'success') {
    if (r.kind === 'release') return r.keystore ? `🔑 ${untrusted(r.keystore, 120)}` : ''
    const v = versionLabel(r)
    return v ? escapeMrkdwn(defang(v)) : ''
  }
  if (s.variant === 'cancelled') {
    const parts: string[] = []
    if (oneLine(r.failedStep)) parts.push(`during ${untrusted(r.failedStep, 120)}`)
    if (r.supersededBy) {
      const n = truncate(oneLine(r.supersededBy.number), 20)
      parts.push(`superseded by ${mrkdwnLink(r.supersededBy.url, `#${n}`)}`)
    }
    return parts.join(' · ')
  }
  return failedFact(r)
}

/** `<url|Name (81.2 MB)>` for each finished build, capped by count and chars then `+N more`. */
function downloadLine(builds: Build[]): string {
  const parts: string[] = []
  let used = 0
  let shown = 0
  for (const b of builds) {
    const size = formatSize(b.size)
    const label = `${truncate(oneLine(b.name), 60)}${size ? ` (${size})` : ''}`
    const piece = mrkdwnLink(b.link, label)
    if (shown >= 30 || used + piece.length + 3 > 2400) break
    parts.push(piece)
    used += piece.length + 3
    shown++
  }
  const more = builds.length - shown
  if (more > 0) parts.push(`+${more} more`)
  return parts.join(' · ')
}

/** Escaped build names joined by `sep`, capped by count and chars then `+N more`. */
function nameList(builds: Build[], sep: string, budget: number): string {
  const parts: string[] = []
  let used = 0
  for (const b of builds) {
    const n = untrusted(b.name, 60)
    if (parts.length >= 30 || used + n.length + sep.length > budget) break
    parts.push(n)
    used += n.length + sep.length
  }
  const more = builds.length - parts.length
  return `${parts.join(sep)}${more > 0 ? `${parts.length ? sep : ''}+${more} more` : ''}`
}

/** START line 3: `🎯 Normal + 6 segment: <names>` or `🎯 AAB + APK (universal)`. */
function plannedLine(r: Report): string {
  if (r.builds.length === 0) return ''
  const segments = r.builds.filter(b => b.kind === 'segment')
  if (segments.length === 0) return `🎯 ${nameList(r.builds, ' + ', 2600)}`
  const mains = r.builds.filter(b => b.kind !== 'segment')
  const head = mains.length ? `${nameList(mains, ', ', 600)} + ` : ''
  return `🎯 ${head}${segments.length} segment: ${nameList(segments, ' · ', 2000)}`
}

/** The single `alert` block: exactly three short mrkdwn lines (ADDENDUM 4). */
function alertBlock(r: Report, s: Summary): Block {
  const emoji = s.emoji
  const product = untrusted(productName(r), 120)
  const t = untrusted(titleFull(r), 120)
  const lines: string[] = []

  // Line 1: the headline.
  if (s.variant === 'start') {
    lines.push(`*${emoji} ${product} · Đang build ${t}*`)
  } else {
    const res = resultLabel(r, s)
    lines.push(`*${emoji} ${product} · ${t}${res ? ` · ${res}` : ''}*`)
  }

  // Line 2: ⏱ time · one key fact.
  const time =
    s.variant === 'start'
      ? r.eta
        ? `ETA ${untrusted(r.eta, 60)}`
        : ''
      : formatDuration(r.durationSeconds)
  const line2 = [time, keyFact(r, s)].filter(Boolean)
  if (line2.length) lines.push(`⏱ ${line2.join(' · ')}`)

  // Line 3: 🎯 planned (START) or 📦 the finished downloads with sizes.
  if (s.variant === 'start') {
    const planned = plannedLine(r)
    if (planned) lines.push(planned)
  } else {
    const finished = r.builds.filter(b => b.status === 'success' && safeUrl(b.link))
    if (finished.length) lines.push(`📦 ${downloadLine(finished)}`)
  }

  // Whole lines only (never split a link); keep at least the first line, within the alert limit.
  while (lines.length > 1 && lines.join('\n').length > LIMITS.alertText) lines.pop()
  let text = lines.join('\n')
  if (text.length > LIMITS.alertText) text = truncate(text, LIMITS.alertText)
  return { type: 'alert', level: ALERT_LEVEL[s.variant], text: { type: 'mrkdwn', text } }
}

/** The single grey `context` line: ref · commit · actor · Drive folder · run (ADDENDUM 4). */
function contextBlock(r: Report): Block {
  const parts: string[] = []
  if (r.ref && oneLine(r.ref.name)) parts.push(untrusted(r.ref.name, 120))
  if (r.commit && oneLine(r.commit.sha)) {
    const sha = mrkdwnLink(r.commit.url, short(r.commit.sha))
    const subject = oneLine(r.commit.subject) ? ` ${untrusted(r.commit.subject, 120)}` : ''
    parts.push(`${sha}${subject}`)
  }
  if (oneLine(r.actor)) parts.push(untrusted(r.actor, 80))
  if (safeUrl(r.driveFolderUrl)) parts.push(mrkdwnLink(r.driveFolderUrl, 'Drive'))
  parts.push(mrkdwnLink(r.run.url, `Run #${runNumber(r)}`))
  return { type: 'context', elements: [{ type: 'mrkdwn', text: parts.join(' · ') }] }
}

const blocksBytes = (blocks: Block[]): number => Buffer.byteLength(JSON.stringify(blocks), 'utf8')

/**
 * The webhook body: a one-line `text` (the push notification) and exactly two blocks — an `alert`
 * with three short lines and a grey `context` line. `phase: start` lists the planned builds; the
 * end message is success, partial, failure or cancelled (`messageVariant`).
 */
export function buildPayload(report: Report): Payload {
  const s = summarize(report)
  return { text: summaryText(report, s), blocks: [alertBlock(report, s), contextBlock(report)] }
}

/** Every limit the payload must keep; empty when it is valid. */
export function checkLimits(payload: Payload): string[] {
  const problems: string[] = []
  const { blocks } = payload
  if (!payload.text || payload.text.includes('\n')) problems.push('text must be one non-empty line')
  if (payload.text.length > LIMITS.text) problems.push(`text is ${payload.text.length} chars`)
  if (blocks.length > LIMITS.blocks) problems.push(`${blocks.length} blocks`)
  const bytes = blocksBytes(blocks)
  if (bytes > LIMITS.blocksBytes) problems.push(`blocks are ${bytes} bytes`)
  for (const b of blocks) {
    if (b.type === 'alert' && b.text.text.length > LIMITS.alertText) problems.push('alert too long')
  }
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > 512 * 1024)
    problems.push('body over 512 kB')
  return problems
}
