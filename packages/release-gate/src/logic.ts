import { CiError } from '../../sdk/src/index.js'

export interface WorkflowRun {
  id: number
  run_number?: number
  event: string
  status: string | null
  conclusion: string | null
  html_url?: string
}

export type Decision =
  | { kind: 'pass'; run: WorkflowRun }
  | { kind: 'wait'; pending: WorkflowRun[] }
  /** No matching run listed (yet). */
  | { kind: 'none' }
  | { kind: 'fail'; seen: WorkflowRun[] }

/** `owner/repo/.github/workflows/ci.yml@refs/tags/v1` -> `ci.yml`. */
export function parseWorkflowRef(ref: string | undefined): string | undefined {
  const match = /^[^/]+\/[^/]+\/\.github\/workflows\/([^@]+)@/.exec(ref ?? '')
  return match?.[1]
}

/** Describe a run as `#12 push=failure` (or `#12 push=in_progress`). */
export function describeRun(run: WorkflowRun): string {
  const state = run.status === 'completed' ? run.conclusion : run.status
  return `#${run.run_number ?? run.id} ${run.event}=${state ?? 'unknown'}`
}

/** Pick the outcome from the runs of one commit, ignoring the current run and other events. */
export function decide(
  runs: readonly WorkflowRun[],
  currentRunId: string | undefined,
  events: readonly string[]
): Decision {
  const seen = runs.filter(r => String(r.id) !== currentRunId && events.includes(r.event))
  const green = seen.find(r => r.status === 'completed' && r.conclusion === 'success')
  if (green) return { kind: 'pass', run: green }
  if (seen.length === 0) return { kind: 'none' }
  const pending = seen.filter(r => r.status !== 'completed')
  if (pending.length > 0) return { kind: 'wait', pending }
  return { kind: 'fail', seen }
}

const SECTIONS: Record<string, readonly string[]> = {
  'Cargo.toml': ['package', 'workspace.package'],
  'pyproject.toml': ['project', 'tool.poetry']
}

/** Version from the first wanted `[section]` that has a literal `version = "..."`. */
export function parseTomlVersion(text: string, sections: readonly string[]): string | undefined {
  let section = ''
  for (const line of text.split(/\r?\n/)) {
    // Covers `[table]` and `[[array.table]]`: both end the previous section.
    const header = /^\s*\[\[?([^\][]+)\]\]?\s*(?:#.*)?$/.exec(line)
    if (header) {
      section = (header[1] as string).trim()
      continue
    }
    if (!sections.includes(section)) continue
    const match = /^\s*version\s*=\s*(["'])(.*?)\1/.exec(line)
    if (match) return match[2]
  }
  return undefined
}

/** Project version from the contents of `file` (parser chosen by its base name). */
export function parseVersion(file: string, text: string): string {
  const base = file.split(/[\\/]/).pop() ?? file
  const sections = SECTIONS[base]
  let version: unknown
  if (base === 'package.json') {
    try {
      version = (JSON.parse(text) as { version?: unknown }).version
    } catch {
      throw new CiError('E_VERSION_FILE', `${file} is not valid JSON`)
    }
  } else if (sections) {
    version = parseTomlVersion(text, sections)
  } else {
    throw new CiError(
      'E_VERSION_FILE',
      `Unsupported version-file ${file} (use Cargo.toml, package.json or pyproject.toml)`
    )
  }
  if (typeof version !== 'string' || version === '') {
    throw new CiError('E_VERSION_FILE', `No version found in ${file}`)
  }
  return version
}

/** Throw unless `tag` equals `prefix + version`. */
export function checkTag(tag: string, prefix: string, version: string): void {
  const expected = `${prefix}${version}`
  if (tag !== expected) {
    throw new CiError(
      'E_TAG_MISMATCH',
      `Release tag "${tag}" does not match the project version: expected "${expected}" ` +
        `(prefix "${prefix}" + version "${version}")`
    )
  }
}

export function fixHint(sha: string, workflow: string): string {
  return (
    `To fix: run ${workflow} via workflow_dispatch on the release tag (same SHA ${sha}), ` +
    'then re-run the failed release jobs.'
  )
}
