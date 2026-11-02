import * as core from '@actions/core'
import {
  InputError,
  Pipeline,
  input,
  parseCommandLine,
  readInputs,
  writeJobSummary,
  type PipelineReport
} from '../../sdk/src/index.js'

const SHELLS = ['none', 'bash', 'sh', 'pwsh'] as const
type Shell = (typeof SHELLS)[number]

/** argv for one line of the `run` input. `none` = no shell (safe argv parsing). */
export function toArgv(line: string, shell: Shell): [string, string[]] {
  switch (shell) {
    case 'bash':
      return ['bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', line]]
    case 'sh':
      return ['sh', ['-e', '-c', line]]
    case 'pwsh':
      // Same wrapper GitHub uses for `shell: pwsh`, so a failing command mid-line fails the step.
      return [
        'pwsh',
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          // Newline-joined so a trailing `# comment` in the line cannot swallow the exit check.
          [
            "$ErrorActionPreference = 'stop'",
            '$PSNativeCommandUseErrorActionPreference = $true',
            line,
            'if ((Test-Path -LiteralPath variable:\\LASTEXITCODE)) { exit $LASTEXITCODE }'
          ].join('\n')
        ]
      ]
    case 'none': {
      const [command, ...args] = parseCommandLine(line)
      return [command as string, args]
    }
  }
}

/**
 * Example action built on the SDK: runs each line of `run` as a step with
 * retries, a per-attempt timeout and a job summary.
 */
export async function run(): Promise<PipelineReport> {
  const cfg = readInputs({
    name: input.string({ default: 'ci-sdk' }),
    run: input.lines({ required: true }),
    shell: input.oneOf(SHELLS, { default: 'none' }),
    workingDirectory: input.string({ name: 'working-directory' }),
    retries: input.number({ default: 0, min: 0, max: 10, integer: true }),
    retryDelay: input.duration({ name: 'retry-delay', default: '2s' }),
    timeout: input.duration({ default: 0 }),
    continueOnError: input.boolean({ name: 'continue-on-error', default: false }),
    summary: input.boolean({ default: true })
  })

  // Parse every line up front so a typo fails fast, before any command runs.
  if (cfg.run.length === 0) {
    throw new InputError([
      { input: 'run', message: 'contains no commands (only blank lines or comments)' }
    ])
  }
  const commands = cfg.run.map(line => ({ line, argv: toArgv(line, cfg.shell) }))

  const pipeline = new Pipeline({ name: cfg.name })
  for (const { line, argv } of commands) {
    const [command, args] = argv
    pipeline.step(
      // Full line, never truncated: a cut could leave part of a secret unmasked.
      line,
      async ctx => ctx.exec(command, args, { cwd: cfg.workingDirectory }),
      {
        retry: { attempts: cfg.retries + 1, minDelay: cfg.retryDelay },
        timeout: cfg.timeout,
        continueOnError: cfg.continueOnError
      }
    )
  }

  const report = await pipeline.run()

  core.setOutput('status', report.status)
  core.setOutput('duration-ms', String(report.durationMs))
  core.setOutput(
    'failed-steps',
    JSON.stringify(report.steps.filter(s => s.status === 'failure').map(s => s.name))
  )
  core.setOutput('report', JSON.stringify(report))
  if (cfg.summary) await writeJobSummary(report)

  if (report.status !== 'success') {
    core.setFailed(`Pipeline ${report.status}`)
  }
  return report
}
