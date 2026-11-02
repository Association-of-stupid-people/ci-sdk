import * as core from '@actions/core'
import { formatDuration } from './duration.js'
import type { PipelineReport, StepStatus } from './pipeline.js'

const ICON: Record<StepStatus | PipelineReport['status'], string> = {
  success: '✅',
  failure: '❌',
  'soft-failure': '⚠️',
  skipped: '⏭️',
  cancelled: '🚫'
}

/** Longest run of `ch` in `text`. */
const longestRun = (text: string, ch: string): number =>
  Math.max(0, ...[...text.matchAll(new RegExp(`\\${ch}+`, 'g'))].map(m => m[0].length))

/**
 * Inline code span that keeps `text` byte-identical (no escaping, no
 * truncation), so the runner's secret masker still matches anything inside.
 */
function code(text: string): string {
  const flat = text.replace(/\r?\n/g, ' ')
  const fence = '`'.repeat(longestRun(flat, '`') + 1)
  const pad = flat.startsWith('`') || flat.endsWith('`') ? ' ' : ''
  return `${fence}${pad}${flat}${pad}${fence}`
}

/** Fenced block, content kept verbatim. */
function block(text: string): string {
  const fence = '~'.repeat(Math.max(3, longestRun(text, '~') + 1))
  return `${fence}\n${text}\n${fence}`
}

/** Render a pipeline report as GitHub-flavoured Markdown (works in any CI that renders Markdown). */
export function reportToMarkdown(report: PipelineReport): string {
  const lines = [
    `### ${ICON[report.status]} ${code(report.name)}: ${report.status} (${formatDuration(report.durationMs)})`,
    ''
  ]
  for (const s of report.steps) {
    const attempts = s.attempts === 1 ? '1 attempt' : `${s.attempts} attempts`
    lines.push(
      `- ${ICON[s.status]} **${s.status}** · ${attempts} · ${formatDuration(s.durationMs)} · ${code(s.name)}`
    )
    if (s.error) lines.push('', indent(block(s.error)), '')
  }
  lines.push('')
  return lines.join('\n')
}

const indent = (text: string): string =>
  text
    .split('\n')
    .map(l => `  ${l}`)
    .join('\n')

/**
 * Append the report to the job summary page (`GITHUB_STEP_SUMMARY`).
 * Returns false and does nothing outside GitHub Actions.
 */
export async function writeJobSummary(report: PipelineReport): Promise<boolean> {
  if (!process.env.GITHUB_STEP_SUMMARY) return false
  await core.summary.addRaw(reportToMarkdown(report), true).write()
  return true
}
