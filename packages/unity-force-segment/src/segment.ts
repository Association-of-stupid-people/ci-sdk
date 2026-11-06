import { parse } from 'yaml'
import { InputError, errorMessage, type InputIssue } from '../../sdk/src/index.js'

export interface Segment {
  name: string
  campaign: string
  network: string
  adgroup: string
  creative: string
  trackerName: string
  /** Upper-case ISO 3166-1 alpha-2, or undefined when the IP country is left alone. */
  country: string | undefined
  /**
   * The segment wants a development build. The action only reports it (`debug` output); the
   * workflow's build step decides what it changes. Default false.
   */
  debug: boolean
}

export interface SegmentFile {
  segments: Segment[]
}

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/
const COUNTRY = /^[A-Za-z]{2}$/
const MAX_LENGTH = 200
// C0/C1 controls plus the Unicode line separators: none may reach a C# string literal.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/
const KEYS = new Set([
  'name',
  'campaign',
  'network',
  'adgroup',
  'creative',
  'tracker-name',
  'country',
  'debug'
])
// Reserved: they are the special values of the `segment` input.
const RESERVED = new Set(['all', 'none'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Escape a value for the inside of a C# regular string literal. */
export function csString(value: string): string {
  if (CONTROL.test(value)) throw new Error('control characters cannot go in a C# string')
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

/**
 * Parse and strictly validate the segment file. No segment is valid: an empty file (or only
 * comments), no `segments` key, `segments:` with nothing under it and `segments: []` all give
 * `{ segments: [] }`.
 * @throws {InputError} listing every problem found.
 */
export function parseSegmentFile(text: string, source = 'segment file'): SegmentFile {
  const issues: InputIssue[] = []
  const fail = (message: string): void => {
    issues.push({ input: 'config', message: `${source}: ${message}` })
  }

  let doc: unknown
  try {
    doc = parse(text)
  } catch (err) {
    throw new InputError([
      { input: 'config', message: `${source}: invalid YAML: ${errorMessage(err)}` }
    ])
  }
  // An empty document (every segment commented out, `segments:` included) is no segment.
  if (doc === null || doc === undefined) return { segments: [] }
  if (!isRecord(doc)) {
    throw new InputError([{ input: 'config', message: `${source}: must be a YAML mapping` }])
  }
  for (const key of Object.keys(doc)) {
    if (key !== 'segments') fail(`unknown top-level key "${key}"`)
  }

  const segments: Segment[] = []
  const rawSegments = doc['segments']
  if (rawSegments === undefined || rawSegments === null) {
    // `segments:` with every entry commented out: no segment.
  } else if (!Array.isArray(rawSegments)) {
    fail('"segments" must be a list')
  } else {
    const seen = new Set<string>()
    rawSegments.forEach((raw: unknown, index) => {
      const segment = parseSegment(raw, index, seen, fail)
      if (segment) segments.push(segment)
    })
  }

  if (issues.length > 0) throw new InputError(issues)
  return { segments }
}

function parseSegment(
  raw: unknown,
  index: number,
  seen: Set<string>,
  fail: (message: string) => void
): Segment | undefined {
  const at = (field: string): string => `segments[${index}].${field}`
  if (!isRecord(raw)) {
    fail(`segments[${index}] must be a mapping`)
    return undefined
  }
  let ok = true
  const bad = (message: string): void => {
    ok = false
    fail(message)
  }
  for (const key of Object.keys(raw)) {
    if (!KEYS.has(key)) bad(`segments[${index}]: unknown key "${key}"`)
  }

  const text = (field: string, fallback: string | undefined): string => {
    const value = raw[field]
    if (value === undefined || value === null) {
      if (fallback === undefined) bad(`${at(field)} is required`)
      return fallback ?? ''
    }
    if (typeof value !== 'string') {
      bad(`${at(field)} must be a string`)
      return ''
    }
    if (value.length > MAX_LENGTH) bad(`${at(field)} must be at most ${MAX_LENGTH} characters`)
    if (CONTROL.test(value)) bad(`${at(field)} must not contain control characters or newlines`)
    return value
  }

  const name = text('name', undefined)
  // An empty name is a string too: it must fail the pattern, not slip through as "none".
  if (typeof raw['name'] === 'string' && !NAME.test(name))
    bad(`${at('name')} "${name}" must match ${String(NAME)}`)
  else if (RESERVED.has(name)) bad(`${at('name')} "${name}" is reserved`)
  else if (seen.has(name)) bad(`${at('name')} "${name}" is duplicated`)
  seen.add(name)

  // `campaign` must be present as a key, but may be empty (organic).
  const campaign = text('campaign', undefined)
  const network = text('network', 'ForcedSegment')
  const adgroup = text('adgroup', '')
  const creative = text('creative', '')
  const trackerName = text('tracker-name', `${network}::${campaign}`)

  let country: string | undefined
  const countryRaw = raw['country']
  if (countryRaw !== undefined && countryRaw !== null && countryRaw !== '') {
    if (typeof countryRaw === 'string' && COUNTRY.test(countryRaw)) {
      country = countryRaw.toUpperCase()
    } else {
      bad(`${at('country')} must be an ISO 3166-1 alpha-2 code such as "US"`)
    }
  }

  const debugRaw = raw['debug']
  let debug = false
  if (debugRaw !== undefined && debugRaw !== null) {
    if (typeof debugRaw === 'boolean') debug = debugRaw
    else bad(`${at('debug')} must be true or false`)
  }

  return ok
    ? { name, campaign, network, adgroup, creative, trackerName, country, debug }
    : undefined
}

/**
 * Pick the segment a `segment` input asks for. `undefined` means "nothing to apply"
 * (none/empty). Anything else must be the name of a segment.
 * @throws {InputError} for an unknown name.
 */
export function resolveSegment(file: SegmentFile, selector: string): Segment | undefined {
  const wanted = selector.trim()
  if (wanted === '' || wanted.toLowerCase() === 'none') return undefined
  return findSegment(file, wanted)
}

function findSegment(file: SegmentFile, name: string): Segment {
  const found = file.segments.find(s => s.name === name)
  if (!found) {
    const known = file.segments.length
      ? `known: ${file.segments.map(s => s.name).join(', ')}`
      : 'the file has no segments'
    throw new InputError([{ input: 'segment', message: `unknown segment "${name}" (${known})` }])
  }
  return found
}

/**
 * Names for `mode: list`, in file order. `filter`: empty or `all` = every segment, `none` = no
 * segment, otherwise a comma-separated list of names that must all exist.
 * @throws {InputError} for an unknown name.
 */
export function listSegments(file: SegmentFile, filter: string): string[] {
  const wanted = filter.trim()
  const key = wanted.toLowerCase()
  if (key === '' || key === 'all') return file.segments.map(s => s.name)
  if (key === 'none') return []
  const names = wanted
    .split(',')
    .map(n => n.trim())
    .filter(n => n !== '')
  if (names.length === 0) {
    throw new InputError([{ input: 'segment', message: `no segment name in "${filter}"` }])
  }
  for (const name of names) findSegment(file, name)
  // File order, not the order the filter was written in, and no duplicates.
  return file.segments.map(s => s.name).filter(n => names.includes(n))
}
