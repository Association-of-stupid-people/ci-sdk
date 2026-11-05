import { InputError } from '../../sdk/src/index.js'

/** One file a run produced (or failed to produce). */
export interface Build {
  /** Row label, e.g. `Normal`, a segment name, `AAB (store)`. */
  name: string
  /** `segment` builds are extras: when only they fail the card is a warning, not an error. */
  kind: 'normal' | 'segment' | 'aab' | 'apk'
  /** `planned` in a START message; `cancelled` when the run was cancelled before it finished. */
  status: 'success' | 'failure' | 'skipped' | 'cancelled' | 'planned'
  /** Segment campaign; `''` = organic. */
  campaign?: string
  country?: string
  /** Download link (Drive, or the GitHub artifact). */
  link?: string
  /** Size in bytes of the linked file. */
  size?: number
  /** The link is the GitHub artifact fallback, not Drive. */
  fallback?: boolean
  failedStep?: string
  logUrl?: string
}

export interface Change {
  sha: string
  subject: string
  author?: string
  url?: string
}

/**
 * What a CI run did, assembled by the workflow from its job results. Every string can be
 * untrusted (branch names, commit subjects, actor): the payload builder escapes it.
 */
export interface Report {
  /** Short name for the first line and the header, e.g. the repository name. */
  name: string
  kind: 'debug' | 'release'
  /**
   * `start`: posted when the build starts (planned builds). `end` (default): the result. A
   * webhook message cannot be edited, so a run posts one of each.
   */
  phase?: 'start' | 'end'
  /**
   * Overall result (end). Results in `jobs` win: any `cancelled` job makes the run cancelled,
   * any `failure` job makes it failed. Default `success`.
   */
  status?: 'success' | 'failure' | 'cancelled'
  /** Job name -> result (`needs.<job>.result`: success, failure, cancelled, skipped). */
  jobs?: Record<string, string>
  /** What failed (failure), or the stage the run was in (cancelled). */
  failedStep?: string
  /** A cancelled run that a newer run of the same concurrency group replaced. */
  supersededBy?: { number: number | string; url?: string }
  /** Event that started the run (`push`, `pull_request`, `workflow_dispatch`...). */
  event?: string
  runner?: string
  /** When the build started, already formatted for people (e.g. `05/11/2026 14:30 (UTC+7)`). */
  startedAt?: string
  /** Product name, when it differs from `name`. */
  game?: string
  platform?: string
  /** A build without caches. */
  clean?: boolean
  project?: { name: string; url?: string }
  run: { url: string; number: number | string }
  ref?: { type: 'branch' | 'tag' | 'pr'; name: string; url?: string; title?: string }
  commit?: { sha: string; url?: string; subject?: string }
  actor?: string
  durationSeconds?: number
  version?: { name?: string; code?: string | number }
  builds: Build[]
  /** Oldest first. */
  changelog?: Change[]
  warnings?: string[]
  logUrl?: string
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Check the shape of a report (unknown keys are ignored).
 * @throws {InputError} listing every problem.
 */
export function parseReport(raw: string): Report {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (err) {
    throw new InputError([
      {
        input: 'report',
        message: `is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
      }
    ])
  }
  const issues: string[] = []
  const str = (v: unknown, where: string, required = false): void => {
    if (v === undefined || v === null) {
      if (required) issues.push(`${where} is required`)
    } else if (typeof v !== 'string') issues.push(`${where} must be a string`)
    else if (required && !v.trim()) issues.push(`${where} is empty`)
  }
  const numOrStr = (v: unknown, where: string, required = false): void => {
    if (v === undefined || v === null) {
      if (required) issues.push(`${where} is required`)
    } else if (typeof v !== 'string' && !(typeof v === 'number' && Number.isFinite(v))) {
      issues.push(`${where} must be a number or a string`)
    }
  }
  const oneOf = (v: unknown, where: string, values: string[]): void => {
    if (typeof v !== 'string' || !values.includes(v))
      issues.push(`${where} must be one of ${values.join(', ')}`)
  }
  if (!isObject(value)) {
    throw new InputError([{ input: 'report', message: 'must be a JSON object' }])
  }
  const r = value
  str(r.name, 'name', true)
  oneOf(r.kind, 'kind', ['debug', 'release'])
  if (r.status !== undefined) oneOf(r.status, 'status', ['success', 'failure', 'cancelled'])
  if (r.phase !== undefined) oneOf(r.phase, 'phase', ['start', 'end'])
  str(r.event, 'event')
  str(r.runner, 'runner')
  str(r.startedAt, 'startedAt')
  if (
    r.jobs !== undefined &&
    (!isObject(r.jobs) || Object.values(r.jobs).some(v => typeof v !== 'string'))
  ) {
    issues.push('jobs must map job names to result strings')
  }
  if (r.supersededBy !== undefined) {
    if (!isObject(r.supersededBy)) issues.push('supersededBy must be { number, url? }')
    else {
      numOrStr(r.supersededBy.number, 'supersededBy.number', true)
      str(r.supersededBy.url, 'supersededBy.url')
    }
  }
  str(r.failedStep, 'failedStep')
  str(r.game, 'game')
  str(r.platform, 'platform')
  str(r.actor, 'actor')
  str(r.logUrl, 'logUrl')
  if (!isObject(r.run)) issues.push('run is required ({ url, number })')
  else {
    str(r.run.url, 'run.url', true)
    numOrStr(r.run.number, 'run.number', true)
  }
  if (r.ref !== undefined) {
    if (!isObject(r.ref)) issues.push('ref must be an object')
    else {
      oneOf(r.ref.type, 'ref.type', ['branch', 'tag', 'pr'])
      str(r.ref.name, 'ref.name', true)
      str(r.ref.url, 'ref.url')
      str(r.ref.title, 'ref.title')
    }
  }
  if (r.commit !== undefined) {
    if (!isObject(r.commit)) issues.push('commit must be { sha, url?, subject? }')
    else {
      str(r.commit.sha, 'commit.sha', true)
      str(r.commit.url, 'commit.url')
      str(r.commit.subject, 'commit.subject')
    }
  }
  if (r.project !== undefined) {
    if (!isObject(r.project)) issues.push('project must be { name, url? }')
    else {
      str(r.project.name, 'project.name', true)
      str(r.project.url, 'project.url')
    }
  }
  if (r.version !== undefined) {
    if (!isObject(r.version)) issues.push('version must be { name?, code? }')
    else {
      str(r.version.name, 'version.name')
      numOrStr(r.version.code, 'version.code')
    }
  }
  if (r.durationSeconds !== undefined && typeof r.durationSeconds !== 'number') {
    issues.push('durationSeconds must be a number')
  }
  if (!Array.isArray(r.builds)) issues.push('builds must be an array')
  else {
    r.builds.forEach((b: unknown, i) => {
      if (!isObject(b)) return issues.push(`builds[${i}] must be an object`)
      str(b.name, `builds[${i}].name`, true)
      oneOf(b.kind, `builds[${i}].kind`, ['normal', 'segment', 'aab', 'apk'])
      oneOf(b.status, `builds[${i}].status`, [
        'success',
        'failure',
        'skipped',
        'cancelled',
        'planned'
      ])
      if (b.size !== undefined && typeof b.size !== 'number')
        issues.push(`builds[${i}].size must be a number`)
      for (const key of ['campaign', 'country', 'link', 'failedStep', 'logUrl'] as const)
        str(b[key], `builds[${i}].${key}`)
      return undefined
    })
  }
  if (r.changelog !== undefined) {
    if (!Array.isArray(r.changelog)) issues.push('changelog must be an array')
    else {
      r.changelog.forEach((c: unknown, i) => {
        if (!isObject(c)) return issues.push(`changelog[${i}] must be an object`)
        str(c.sha, `changelog[${i}].sha`, true)
        str(c.subject, `changelog[${i}].subject`)
        str(c.author, `changelog[${i}].author`)
        str(c.url, `changelog[${i}].url`)
        return undefined
      })
    }
  }
  if (r.warnings !== undefined && !Array.isArray(r.warnings))
    issues.push('warnings must be an array')
  if (issues.length > 0) {
    throw new InputError(issues.map(message => ({ input: 'report', message })))
  }
  return r as unknown as Report
}
