import type { Build, Report } from './report.js'

/**
 * Limits of the team chat webhook (Slack Block Kit subset). The server keeps at most 50 blocks and
 * 16 kB of blocks after normalising them, dropping blocks from the end: the payload stays under
 * `blocksBytes` to leave room for that normalisation.
 */
export const LIMITS = {
  blocks: 50,
  blocksBytes: 14_000,
  header: 150,
  sectionText: 3_000,
  fieldText: 2_000,
  fields: 10,
  alertText: 3_000,
  tableRows: 100,
  tableChars: 10_000,
  /** The one-line `text` (push notification). */
  text: 300,
  changelog: 10
}

export type TextObject = { type: 'mrkdwn' | 'plain_text'; text: string }
export type RichElement =
  | { type: 'text'; text: string; style?: { bold?: boolean; italic?: boolean; code?: boolean } }
  | { type: 'link'; url: string; text: string }
export type RichSection = { type: 'rich_text_section'; elements: RichElement[] }
export type TableCell =
  { type: 'raw_text'; text: string } | { type: 'rich_text'; elements: RichSection[] }
export type Block =
  | { type: 'header'; text: TextObject }
  | { type: 'section'; text?: TextObject; fields?: TextObject[] }
  | { type: 'divider' }
  | { type: 'context'; elements: TextObject[] }
  | { type: 'alert'; level: 'default' | 'info' | 'warning' | 'error' | 'success'; text: TextObject }
  | { type: 'table'; rows: TableCell[][] }
  | {
      type: 'rich_text'
      elements: (
        | RichSection
        | { type: 'rich_text_list'; style: 'bullet' | 'ordered'; elements: RichSection[] }
      )[]
    }

export interface Payload {
  text: string
  blocks: Block[]
}

export interface PayloadOptions {
  /** ci-sdk version for the footer. */
  sdkVersion?: string
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

/** `Release v1.0.2 (10002)` / `Debug #128`. */
function title(r: Report): string {
  if (r.kind === 'release') {
    const tag = r.ref?.type === 'tag' ? oneLine(r.ref.name) : ''
    const code = truncate(oneLine(r.version?.code), 20)
    const name = truncate(tag || oneLine(r.version?.name), 60) || `#${runNumber(r)}`
    return `Release ${name}${code ? ` (${code})` : ''}`
  }
  return `Debug #${runNumber(r)}`
}

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
  fallback: Build[]
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
    fallback: r.builds.filter(b => b.status === 'success' && b.fallback),
    emoji
  }
}

/** `7 bản (normal + 6 segment)`. */
function plannedCount(r: Report): string {
  const segments = r.builds.filter(b => b.kind === 'segment').length
  const main = r.builds.filter(b => b.kind === 'normal').length
  return `${r.builds.length} bản${segments && main ? ` (normal + ${segments} segment)` : ''}`
}

/** The notification line: the whole story in one line (mrkdwn, escaped, no links). */
export function summaryText(r: Report, s: Summary = summarize(r)): string {
  const name = oneLine(r.name)
  const step = truncate(oneLine(r.failedStep) || 'unknown step', 120)
  const count = `${s.ok}/${s.total} builds OK`
  const duration = formatDuration(r.durationSeconds)
  let parts: string[]
  switch (s.variant) {
    case 'start':
      parts = [
        name,
        `Đang build ${title(r)}`,
        r.kind === 'release' || r.builds.length === 0 ? '' : plannedCount(r)
      ]
      break
    case 'cancelled':
      parts = [
        name,
        `${title(r)} cancelled${duration ? ` after ${duration}` : ''}`,
        r.failedStep ? `during ${step}` : '',
        r.supersededBy ? `superseded by run #${truncate(oneLine(r.supersededBy.number), 20)}` : ''
      ]
      break
    case 'success':
      parts = r.kind === 'release' ? [name, `${title(r)} ready`] : [name, title(r), count, duration]
      break
    case 'partial':
      parts =
        r.kind === 'release'
          ? [name, `${title(r)} built`, `${step} failed`]
          : [name, `${title(r)} failed at ${step}`, count, duration]
      break
    default:
      parts =
        r.kind === 'release'
          ? [name, `${title(r)} failed at ${step}`]
          : [name, `${title(r)} failed at ${step}`, count, duration]
  }
  // Not defanged: with blocks, `text` is only the push notification and the search text.
  const line = `${s.emoji} ${parts.filter(Boolean).join(' · ')}`
  // Cut before escaping, so an entity is never cut in half.
  let max = LIMITS.text
  let text = escapeMrkdwn(truncate(line, max))
  while (text.length > LIMITS.text) text = escapeMrkdwn(truncate(line, (max -= 10)))
  return text
}

const EVENTS: Record<string, string> = {
  push: 'push',
  pull_request: 'pull request',
  workflow_dispatch: 'manual run',
  schedule: 'schedule'
}

function fields(r: Report, variant: Variant): TextObject[] {
  const out: TextObject[] = []
  // Untrusted values are cut before escaping, so an entity or a link is never cut in half.
  const add = (label: string, mrkdwnValue: string): void => {
    if (mrkdwnValue) out.push({ type: 'mrkdwn', text: `*${label}*\n${mrkdwnValue}` })
  }
  const plain = (s: string | number | undefined, max = 200): string => untrusted(s, max)

  if (r.ref) {
    const label = { branch: 'Branch', tag: 'Tag', pr: 'Pull request' }[r.ref.type]
    const name =
      r.ref.type === 'pr'
        ? mrkdwnLink(r.ref.url, truncate(oneLine(r.ref.name), 40))
        : plain(r.ref.name, 120)
    add(label, r.ref.title ? `${name} ${plain(r.ref.title, 300)}` : name)
  }
  if (r.commit) {
    const sha = mrkdwnLink(r.commit.url, short(r.commit.sha))
    add('Commit', r.commit.subject ? `${sha} ${plain(r.commit.subject, 300)}` : sha)
  }
  add('Version', plain(versionLabel(r), 100))
  if (variant !== 'start') add('Duration', formatDuration(r.durationSeconds))
  add('Game', plain(r.game))
  const kind = [
    defang(truncate(oneLine(r.platform), 40)),
    r.kind === 'release' ? 'Release' : 'Debug',
    r.clean ? 'clean (no caches)' : ''
  ]
  add('Build', escapeMrkdwn(kind.filter(Boolean).join(' · ')))
  add('Triggered by', plain(r.actor, 80))
  const event = oneLine(r.event)
  add('Event', EVENTS[event] ?? plain(event, 40))
  add('Runner', plain(r.runner, 80))
  add('Started', plain(r.startedAt, 60))
  return out.slice(0, LIMITS.fields)
}

/** A cell with our own text. */
const raw = (text: string): TableCell => ({ type: 'raw_text', text })
/**
 * A cell with untrusted text: a rich_text `text` element is literal, and defanged in case the
 * server links plain URLs or `@name` there too.
 */
const textCell = (text: string): TableCell => ({
  type: 'rich_text',
  elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: defang(text) }] }]
})
const linkCell = (url: string, text: string): TableCell => ({
  type: 'rich_text',
  elements: [{ type: 'rich_text_section', elements: [{ type: 'link', url, text }] }]
})
const cellChars = (c: TableCell): number =>
  c.type === 'raw_text'
    ? c.text.length
    : c.elements.reduce(
        (n, s) =>
          n +
          s.elements.reduce(
            (m, e) => m + e.text.length + (e.type === 'link' ? e.url.length : 0),
            0
          ),
        0
      )

function resultCell(b: Build, start: boolean): TableCell {
  if (start || b.status === 'planned') return raw('⏳ planned')
  switch (b.status) {
    case 'success':
      return raw('✅')
    case 'skipped':
      return raw('— skipped')
    case 'cancelled':
      return raw('🚫 cancelled')
    default:
      return textCell(`❌ ${truncate(oneLine(b.failedStep) || 'failed', 60)}`)
  }
}

function buildRow(b: Build, segmentColumns: boolean, start: boolean): TableCell[] {
  const row: TableCell[] = [textCell(truncate(oneLine(b.name), 60))]
  if (segmentColumns) {
    const campaign = truncate(oneLine(b.campaign), 60)
    row.push(b.campaign === undefined ? raw('—') : campaign ? textCell(campaign) : raw('(organic)'))
    const country = truncate(oneLine(b.country), 10)
    row.push(country ? textCell(country) : raw('—'))
  }
  row.push(resultCell(b, start))
  if (start) return row
  const link = safeUrl(b.link)
  const log = safeUrl(b.logUrl)
  if (b.status === 'success' && link) {
    const size = formatSize(b.size)
    row.push(linkCell(link, b.fallback ? 'GitHub artifact' : `Drive${size ? ` · ${size}` : ''}`))
  } else if (b.status === 'failure' && log) row.push(linkCell(log, 'Unity log'))
  else row.push(raw('—'))
  return row
}

/**
 * One row per build (at most `maxRows`), main builds and failures first when cut. A START
 * message lists the planned builds, without the result links.
 */
function table(r: Report, maxRows: number, start: boolean): Block | undefined {
  if (r.builds.length === 0 || maxRows <= 0) return undefined
  const segmentColumns = r.builds.some(b => b.campaign !== undefined || b.country !== undefined)
  const header = [
    raw('Build'),
    ...(segmentColumns ? [raw('Campaign'), raw('Country')] : []),
    raw(start ? 'Status' : 'Result'),
    ...(start ? [] : [raw('Link')])
  ]
  let builds = r.builds
  const room = Math.min(maxRows, LIMITS.tableRows - 1)
  const cut = builds.length > room
  if (cut) {
    const primary = builds.filter(b => b.kind !== 'segment')
    const failed = builds.filter(b => b.kind === 'segment' && b.status === 'failure')
    const rest = builds.filter(b => b.kind === 'segment' && b.status !== 'failure')
    builds = [...primary, ...failed, ...rest]
  }
  const rows: TableCell[][] = [header]
  let chars = header.reduce((n, c) => n + cellChars(c), 0)
  const moreRow = (n: number): TableCell[] => {
    const row = [raw(`+${n} more (see the run)`)]
    while (row.length < header.length) row.push(raw('—'))
    return row
  }
  let shown = 0
  for (const b of builds) {
    if (shown >= (cut ? room - 1 : room)) break
    const row = buildRow(b, segmentColumns, start)
    const n = row.reduce((m, c) => m + cellChars(c), 0)
    if (chars + n > LIMITS.tableChars - 100) break
    rows.push(row)
    chars += n
    shown++
  }
  if (shown < builds.length) rows.push(moreRow(builds.length - shown))
  return { type: 'table', rows }
}

function alerts(r: Report, s: Summary): Block[] {
  const out: Block[] = []
  const alert = (
    level: 'default' | 'info' | 'warning' | 'error' | 'success',
    text: string
  ): void => {
    out.push({ type: 'alert', level, text: { type: 'mrkdwn', text } })
  }
  // Worst case after escaping: step 150 x 5, links 2 x ~520, a name list <= 900.
  const step = oneLine(r.failedStep) ? untrusted(r.failedStep, 150) : 'unknown step'
  const runLink = mrkdwnLink(r.run.url, `Run #${runNumber(r)}`)
  const logLink = safeUrl(r.logUrl) ? ` · ${mrkdwnLink(r.logUrl, 'Unity log')}` : ''
  /** Escaped build names, whole names only, with "+N more" past `budget` chars. */
  const names = (builds: Build[], budget = 900): string => {
    const shown: string[] = []
    let used = 0
    for (const b of builds) {
      const name = untrusted(b.name, 60)
      if (shown.length >= 10 || used + name.length + 2 > budget) break
      shown.push(name)
      used += name.length + 2
    }
    const more = builds.length - shown.length
    return `${shown.join(', ')}${more > 0 ? `${shown.length ? ', ' : ''}+${more} more` : ''}`
  }
  const finished = r.builds.filter(b => b.status === 'success')

  switch (s.variant) {
    case 'start': {
      const runner = oneLine(r.runner) ? ` on ${untrusted(r.runner, 80)}` : ''
      const what = r.builds.length
        ? `${r.builds.length} build${r.builds.length > 1 ? 's' : ''}`
        : 'the build'
      alert(
        'info',
        `Building ${what}${runner}. A second message follows with the result and the download links · ${runLink}`
      )
      return out
    }
    case 'success':
      alert(
        'success',
        r.kind === 'release'
          ? `${untrusted(title(r), 120)} is ready${finished.length ? `: ${names(finished)}` : ''}.`
          : `All ${s.total} build${s.total === 1 ? '' : 's'} OK.`
      )
      break
    case 'failure':
      alert('error', `*Failed at* ${step}${logLink} · ${runLink}`)
      break
    case 'cancelled': {
      const duration = formatDuration(r.durationSeconds)
      const parts = [
        `*Cancelled*${duration ? ` after ${duration}` : ''}${r.failedStep ? `, during ${step}` : ''}.`
      ]
      if (r.supersededBy) {
        const n = truncate(oneLine(r.supersededBy.number), 20)
        parts.push(`Superseded by ${mrkdwnLink(r.supersededBy.url, `Run #${n}`)}.`)
      }
      parts.push(
        finished.length
          ? `Finished before the cancel: ${names(finished)}.`
          : 'Nothing finished before the cancel.'
      )
      alert('default', `${parts.join(' ')} · ${runLink}`)
      break
    }
    default:
      break
  }
  const warnings: string[] = []
  if (s.variant === 'partial') warnings.push(`*Failed:* ${step}${logLink} · ${runLink}`)
  if (s.fallback.length > 0) {
    warnings.push(`Not on Drive, GitHub artifact instead: ${names(s.fallback)}`)
  }
  for (const w of r.warnings ?? []) {
    if (typeof w === 'string' && oneLine(w)) warnings.push(untrusted(w, 300))
  }
  if (warnings.length > 0) {
    // Whole lines only (a cut line could break a link), at most 8, within the alert limit.
    const shown: string[] = []
    let used = 0
    for (const w of warnings) {
      if (shown.length >= 8 || used + w.length + 1 > LIMITS.alertText - 50) break
      shown.push(w)
      used += w.length + 1
    }
    if (warnings.length > shown.length) shown.push(`+${warnings.length - shown.length} more`)
    alert('warning', shown.join('\n'))
  }
  return out
}

/** Newest `max` changes as a bullet list, with "+N earlier". */
function changelog(r: Report, max: number): Block | undefined {
  const changes = (r.changelog ?? []).filter(c => c && typeof c.subject === 'string')
  if (changes.length === 0 || max <= 0) return undefined
  const shown = changes.slice(-max)
  const items: RichSection[] = shown.map(c => {
    const url = safeUrl(c.url)
    const sha = short(c.sha)
    return {
      type: 'rich_text_section',
      elements: [
        { type: 'text', text: `${defang(truncate(oneLine(c.subject), 200)) || '(no subject)'} (` },
        url ? { type: 'link', url, text: sha } : { type: 'text', text: defang(sha) },
        { type: 'text', text: c.author ? ` by ${defang(truncate(oneLine(c.author), 60))})` : ')' }
      ]
    }
  })
  const earlier = changes.length - shown.length
  if (earlier > 0) {
    items.push({
      type: 'rich_text_section',
      elements: [{ type: 'text', text: `+${earlier} earlier`, style: { italic: true } }]
    })
  }
  return {
    type: 'rich_text',
    elements: [
      {
        type: 'rich_text_section',
        elements: [{ type: 'text', text: 'Changelog', style: { bold: true } }]
      },
      { type: 'rich_text_list', style: 'bullet', elements: items }
    ]
  }
}

function footer(r: Report, options: PayloadOptions): Block {
  const parts = ['GitHub Actions']
  if (r.project) parts.push(mrkdwnLink(r.project.url, truncate(oneLine(r.project.name), 100)))
  parts.push(mrkdwnLink(r.run.url, `Run #${runNumber(r)}`))
  if (options.sdkVersion) parts.push(escapeMrkdwn(`ci-sdk v${options.sdkVersion}`))
  return { type: 'context', elements: [{ type: 'mrkdwn', text: parts.join(' · ') }] }
}

const blocksBytes = (blocks: Block[]): number => Buffer.byteLength(JSON.stringify(blocks), 'utf8')

/**
 * The webhook body: a one-line `text` (the push notification; only the blocks show in the
 * channel) and the blocks: header, fields, one table row per build, alerts, changelog, footer.
 * `phase: start` posts the planned builds; the end message is success, partial, failure or
 * cancelled (`messageVariant`). Cut to the webhook limits: the changelog first, then table rows,
 * then the table.
 */
export function buildPayload(report: Report, options: PayloadOptions = {}): Payload {
  const s = summarize(report)
  const start = s.variant === 'start'
  const head: Block = {
    type: 'header',
    text: {
      type: 'plain_text',
      text: truncate(
        defang(
          oneLine(`${s.emoji} ${report.name} · ${start ? 'Đang build ' : ''}${title(report)}`)
        ),
        LIMITS.header
      )
    }
  }
  const info = fields(report, s.variant)
  const assemble = (maxRows: number, maxChanges: number): Block[] => {
    const blocks: Block[] = [head]
    if (info.length > 0) blocks.push({ type: 'section', fields: info })
    const t = table(report, maxRows, start)
    if (t) blocks.push({ type: 'divider' }, t)
    blocks.push(...alerts(report, s))
    const c = changelog(report, maxChanges)
    if (c) blocks.push({ type: 'divider' }, c)
    blocks.push(footer(report, options))
    return blocks.slice(0, LIMITS.blocks)
  }
  const plans: [number, number][] = [
    [LIMITS.tableRows, LIMITS.changelog],
    [LIMITS.tableRows, 5],
    [LIMITS.tableRows, 0],
    [40, 0],
    [20, 0],
    [10, 0],
    [5, 0],
    [0, 0]
  ]
  let blocks: Block[] = []
  for (const [rows, changes] of plans) {
    blocks = assemble(rows, changes)
    if (blocksBytes(blocks) <= LIMITS.blocksBytes) break
  }
  return { text: summaryText(report, s), blocks }
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
    if (b.type === 'header' && b.text.text.length > LIMITS.header) problems.push('header too long')
    if (b.type === 'section') {
      if (b.text && b.text.text.length > LIMITS.sectionText) problems.push('section text too long')
      if ((b.fields?.length ?? 0) > LIMITS.fields) problems.push('too many fields')
      for (const f of b.fields ?? [])
        if (f.text.length > LIMITS.fieldText) problems.push('field too long')
    }
    if (b.type === 'alert' && b.text.text.length > LIMITS.alertText) problems.push('alert too long')
    if (b.type === 'table') {
      if (b.rows.length > LIMITS.tableRows) problems.push(`table has ${b.rows.length} rows`)
      const chars = b.rows.flat().reduce((n, c) => n + cellChars(c), 0)
      if (chars > LIMITS.tableChars) problems.push(`table has ${chars} chars`)
      if (b.rows.some(row => row.length > 20)) problems.push('table row has more than 20 cells')
    }
  }
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > 512 * 1024)
    problems.push('body over 512 kB')
  return problems
}
