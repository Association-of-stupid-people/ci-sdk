import { formatDuration, reportToMarkdown, type PipelineReport } from '../../sdk/src/index.js'
import type { UnityIssue } from './log-scan.js'
import type { FailureKind } from './unity.js'

export interface BuildSummary {
  report: PipelineReport
  version: string
  mode: 'host' | 'docker'
  /** Editor path (host) or image tag (docker). */
  runtime: string | undefined
  attempts: number
  failureKind: FailureKind | undefined
  issues: readonly UnityIssue[]
  totalIssues: number
  logFile: string
  /** Build label of the BIBG Debug View client in this build (undefined = not injected). */
  debugView?: string
  maxShown?: number
}

const ICON = { success: '✅', failure: '❌', cancelled: '🚫' } as const

const KIND_TEXT: Record<FailureKind, string> = {
  license: 'license error (retried, still failing)',
  build: 'build error',
  timeout: 'timed out (Unity killed)',
  hang: 'hung: no log output (Unity killed)'
}

/** Fenced block that keeps text verbatim (no escaping) so the runner's masker still matches. */
function block(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/~+/g)].map(m => m[0].length))
  const fence = '~'.repeat(Math.max(3, longest + 1))
  return `${fence}\n${text}\n${fence}`
}

export function summaryMarkdown(s: BuildSummary): string {
  const status = s.report.status
  const lines = [
    `### ${ICON[status]} Unity build: ${status} (${formatDuration(s.report.durationMs)})`,
    '',
    '| | |',
    '| --- | --- |',
    `| Unity | \`${s.version}\` (${s.mode}) |`,
    ...(s.runtime ? [`| ${s.mode === 'docker' ? 'Image' : 'Editor'} | \`${s.runtime}\` |`] : []),
    `| Attempts | ${s.attempts} |`,
    ...(s.failureKind ? [`| Failure | ${KIND_TEXT[s.failureKind]} |`] : []),
    ...(s.debugView !== undefined ? [`| BIBG Debug View | on (\`${s.debugView}\`) |`] : []),
    `| Log | \`${s.logFile}\` |`,
    ''
  ]
  const errors = s.issues.filter(i => i.kind !== 'exception')
  const shown = (errors.length ? errors : s.issues).slice(0, s.maxShown ?? 30)
  if (shown.length) {
    const more = s.totalIssues > shown.length ? `, showing ${shown.length} of ${s.totalIssues}` : ''
    lines.push(
      `#### Errors from the Unity log${more}`,
      '',
      block(shown.map(i => i.message).join('\n')),
      ''
    )
  }
  lines.push('<details><summary>Steps</summary>', '', reportToMarkdown(s.report), '</details>', '')
  return lines.join('\n')
}
