import * as core from '@actions/core'
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { CiError, TimeoutError, exec, formatDuration } from '../../sdk/src/index.js'
import { UnityLogScanner, classifyFailure, type UnityIssue } from './log-scan.js'

export type FailureKind = 'license' | 'build' | 'timeout' | 'hang'

export interface UnityRunResult {
  exitCode: number | null
  durationMs: number
  issues: UnityIssue[]
  totalIssues: number
}

/** A Unity run failed; `kind` decides whether it is retried (only `license` is). */
export class UnityBuildError extends CiError {
  constructor(
    readonly kind: FailureKind,
    message: string,
    readonly result: UnityRunResult
  ) {
    super(`E_UNITY_${kind.toUpperCase()}`, message)
  }
}

export interface UnityRunOptions {
  command: string
  args: readonly string[]
  cwd?: string
  /** Full child environment (not merged with process.env). */
  env: Record<string, string | undefined>
  /** Hard limit for the whole run; the process tree is killed. 0 = none. */
  timeoutMs: number
  /** Kill Unity when it prints nothing for this long (hung editor). 0 = off. */
  idleTimeoutMs: number
  /** The full log is written here (appended for attempts > 1). */
  logFile: string
  attempt: number
  signal?: AbortSignal
  licensePatterns?: readonly RegExp[]
  maxIssues?: number
  /** Values replaced with *** in `logFile` (the runner only masks the job log, not files). */
  secrets?: readonly string[]
  /** Called when Unity was killed (timeout/hang/cancel), e.g. to stop a container. */
  onKilled?: (reason: 'timeout' | 'hang' | 'cancel') => Promise<void>
}

/**
 * Line-buffered writer that redacts secrets, so a secret split across two
 * output chunks is still caught. Write errors are reported once, never thrown.
 */
class RedactingLog {
  private rest = ''
  private readonly stream: ReturnType<typeof createWriteStream>
  private readonly secrets: string[]
  failed: Error | undefined

  constructor(file: string, append: boolean, secrets: readonly string[]) {
    this.stream = createWriteStream(file, { flags: append ? 'a' : 'w' })
    this.stream.on('error', err => (this.failed ??= err))
    // Longest first, so a secret containing another one is replaced whole.
    this.secrets = [...new Set(secrets.filter(s => s.length >= 3))].sort(
      (a, b) => b.length - a.length
    )
  }

  private redact(text: string): string {
    let out = text
    for (const s of this.secrets) out = out.split(s).join('***')
    return out
  }

  write(chunk: string): void {
    const text = this.rest + chunk
    const cut = text.lastIndexOf('\n') + 1
    this.rest = text.slice(cut)
    if (this.rest.length > 64 * 1024) {
      this.stream.write(this.redact(this.rest))
      this.rest = ''
    }
    if (cut > 0) this.stream.write(this.redact(text.slice(0, cut)))
  }

  async end(): Promise<void> {
    if (this.rest) this.stream.write(this.redact(this.rest))
    this.rest = ''
    if (this.failed) return
    await new Promise<void>(resolve => {
      this.stream.once('error', () => resolve())
      this.stream.end(resolve)
    })
  }
}

/**
 * Run Unity once: stream its log to the job log and `logFile`, scan it for
 * errors, and kill it on timeout or when it stops printing (hung editor).
 *
 * @throws {UnityBuildError} on any failure of the build itself.
 * @throws {AbortError} when the run is cancelled.
 */
export async function runUnity(o: UnityRunOptions): Promise<UnityRunResult> {
  await mkdir(path.dirname(o.logFile), { recursive: true })
  const log = new RedactingLog(o.logFile, o.attempt > 1, o.secrets ?? [])
  if (o.attempt > 1) log.write(`\n===== ci-sdk unity-build: attempt ${o.attempt} =====\n`)
  const scanner = new UnityLogScanner(o.maxIssues, o.licensePatterns)

  const idle = new AbortController()
  const idleError = new TimeoutError(
    o.idleTimeoutMs,
    `Unity printed nothing for ${formatDuration(o.idleTimeoutMs)}; treated as hung and killed`
  )
  let idleTimer: NodeJS.Timeout | undefined
  const armIdle = (): void => {
    if (o.idleTimeoutMs <= 0) return
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => idle.abort(idleError), o.idleTimeoutMs)
  }
  const onChunk = (chunk: string): void => {
    log.write(chunk)
    scanner.push(chunk)
    armIdle()
  }

  const started = performance.now()
  const result = (exitCode: number | null): UnityRunResult => ({
    exitCode,
    durationMs: Math.round(performance.now() - started),
    issues: scanner.issues,
    totalIssues: scanner.total
  })

  let killed: { kind: 'timeout' | 'hang'; message: string } | undefined
  let exitCode: number | null = null
  armIdle()
  try {
    const res = await exec(o.command, o.args, {
      cwd: o.cwd,
      env: o.env,
      inheritEnv: false,
      signal: o.signal ? AbortSignal.any([o.signal, idle.signal]) : idle.signal,
      timeout: o.timeoutMs,
      allowFailure: true,
      maxBuffer: 64 * 1024, // the full log goes to logFile
      onStdout: onChunk,
      onStderr: onChunk
    })
    exitCode = res.exitCode
  } catch (err) {
    if (err === idleError) killed = { kind: 'hang', message: idleError.message }
    else if (err instanceof TimeoutError)
      killed = {
        kind: 'timeout',
        message: `Unity exceeded the ${formatDuration(o.timeoutMs)} timeout and was killed`
      }
    else {
      await o.onKilled?.('cancel').catch(() => undefined)
      throw err // cancelled, or the editor could not be started
    }
  } finally {
    clearTimeout(idleTimer)
    scanner.end()
    await log.end()
  }
  if (log.failed) core.warning(`Could not write ${o.logFile}: ${log.failed.message}`)

  if (killed) {
    await o.onKilled?.(killed.kind).catch(() => undefined)
    throw new UnityBuildError(killed.kind, killed.message, result(null))
  }
  if (exitCode !== 0 || scanner.buildResultFailure) {
    const kind = classifyFailure(scanner)
    const first = (['compile', 'build', 'license', 'exception'] as const)
      .map(k => scanner.issues.find(i => i.kind === k))
      .find(Boolean)
    const how =
      exitCode === 0 ? 'reported "Build Finished, Result: Failure"' : `exited with code ${exitCode}`
    const message = `Unity ${how}${kind === 'license' ? ' (license error)' : ''}${first ? `: ${first.message}` : ''}`
    throw new UnityBuildError(kind, message, result(exitCode))
  }
  return result(exitCode)
}
