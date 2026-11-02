import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import crossSpawn from 'cross-spawn'
import { sleep, throwIfAborted, toAbortError } from './abort.js'
import { parseDuration } from './duration.js'
import { CiError, ExecError, TimeoutError } from './errors.js'

export interface ExecOptions {
  cwd?: string
  /** Extra variables merged over `process.env` (set `inheritEnv: false` to start empty). */
  env?: Record<string, string | undefined>
  inheritEnv?: boolean
  /** Written to stdin, then stdin is closed. Prefer this over argv for secrets. */
  input?: string
  /** Cancels the process (process tree is killed). */
  signal?: AbortSignal
  /** Kill the process after this long (ms or duration string). 0 = no limit. */
  timeout?: number | string
  /** Grace period between SIGTERM and SIGKILL. Default 5s. */
  killGrace?: number | string
  /** Do not echo output to the job log. Output is still captured. */
  silent?: boolean
  /** Resolve instead of throwing on a non-zero exit code. */
  allowFailure?: boolean
  /** Max characters kept per stream (the tail is kept). Default 1 MiB. */
  maxBuffer?: number
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
}

export interface ExecResult {
  command: string
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  durationMs: number
}

const DEFAULT_MAX_BUFFER = 1024 * 1024
/** How long to wait for stdout/stderr to close after the direct child exits. */
const PIPE_DRAIN_MS = 1_000

/**
 * Render a command for logs (not for passing to a shell). Arguments are quoted
 * but never escaped, so a secret inside an argument stays byte-identical and
 * the runner's log masker still recognises it.
 */
export function formatCommand(command: string, args: readonly string[] = []): string {
  return [command, ...args]
    .map(a => (/^[\w./:=@%+-]+$/.test(a) ? a : a.includes("'") ? `"${a}"` : `'${a}'`))
    .join(' ')
}

class TailBuffer {
  private text = ''
  constructor(private readonly max: number) {}
  push(chunk: string): void {
    this.text += chunk
    if (this.text.length > this.max) this.text = this.text.slice(this.text.length - this.max)
  }
  toString(): string {
    return this.text
  }
}

/** Overlay `extra` on `base`; on Windows env keys are case-insensitive (`Path` vs `PATH`). */
function mergeEnv(
  base: NodeJS.ProcessEnv | Record<string, never>,
  extra: Record<string, string | undefined> = {}
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base }
  if (process.platform === 'win32') {
    const overridden = new Set(Object.keys(extra).map(k => k.toLowerCase()))
    for (const key of Object.keys(env)) if (overridden.has(key.toLowerCase())) delete env[key]
  }
  return { ...env, ...extra }
}

/**
 * Kill the child's whole process tree.
 * POSIX: the child leads its own process group (spawned detached), so the group
 * is signalled even after the leader exited, reaching background grandchildren
 * (`cmd &`, daemons) that still hold the output pipes.
 * Windows: `taskkill /T` walks the tree from the leader; once the leader has
 * exited its orphans cannot be found (documented limitation).
 */
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid
  if (pid === undefined) return
  if (process.platform === 'win32') {
    if (child.exitCode !== null || child.signalCode !== null) return
    nodeSpawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true
    }).on('error', () => child.kill())
    return
  }
  try {
    process.kill(-pid, signal)
  } catch {
    // ESRCH: the group is already gone.
    if (child.exitCode === null && child.signalCode === null) child.kill(signal)
  }
}

/** POSIX: wait until the process group is gone, SIGKILL it after `graceMs`. */
async function reapGroup(child: ChildProcess, graceMs: number): Promise<void> {
  const pid = child.pid
  if (pid === undefined || process.platform === 'win32') return
  const alive = (): boolean => {
    try {
      process.kill(-pid, 0)
      return true
    } catch {
      return false
    }
  }
  const deadline = performance.now() + graceMs
  while (alive() && performance.now() < deadline) await sleep(100)
  if (alive()) killTree(child, 'SIGKILL')
}

/**
 * Run a program **without a shell**: arguments are passed as-is, so values
 * from PR titles, branch names or inputs cannot inject commands.
 *
 * - Output streams to the log live and is captured (tail-capped).
 * - `timeout` and `signal` kill the whole process tree (SIGTERM, then SIGKILL).
 * - Resolves shortly after the direct child exits, even if a background
 *   process it started keeps the output pipes open (same as a `run:` step).
 * - Windows `.cmd`/`.bat` shims (npm, npx, yarn) resolve via cross-spawn.
 *
 * @throws {ExecError} on a non-zero exit (unless `allowFailure`).
 * @throws {TimeoutError | AbortError} when timed out or cancelled.
 */
export async function exec(
  command: string,
  args: readonly string[] = [],
  options: ExecOptions = {}
): Promise<ExecResult> {
  throwIfAborted(options.signal)
  const display = formatCommand(command, args)
  const timeoutMs = parseDuration(options.timeout ?? 0)
  const killGraceMs = parseDuration(options.killGrace ?? 5_000)
  const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER
  const env = mergeEnv(options.inheritEnv === false ? {} : process.env, options.env)
  const started = performance.now()

  const child = crossSpawn(command, [...args], {
    cwd: options.cwd,
    env,
    stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true
  })

  const stdout = new TailBuffer(maxBuffer)
  const stderr = new TailBuffer(maxBuffer)
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
    stdout.push(chunk)
    options.onStdout?.(chunk)
    if (!options.silent) process.stdout.write(chunk)
  })
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    stderr.push(chunk)
    options.onStderr?.(chunk)
    if (!options.silent) process.stderr.write(chunk)
  })
  if (options.input !== undefined && child.stdin) {
    child.stdin.on('error', () => undefined) // EPIPE if the child exits early
    child.stdin.end(options.input)
  }

  let stopReason: Error | undefined
  // Set once the direct child exited: a timeout/cancel during the pipe-drain
  // window must not turn a finished command into a failure.
  let childExited = false
  let graceTimer: NodeJS.Timeout | undefined
  const stop = (reason: Error): void => {
    if (stopReason || childExited) return
    stopReason = reason
    killTree(child, 'SIGTERM')
    graceTimer = setTimeout(() => killTree(child, 'SIGKILL'), killGraceMs)
    graceTimer.unref()
  }
  const onAbort = (): void => stop(toAbortError(options.signal))
  options.signal?.addEventListener('abort', onAbort, { once: true })
  const timeoutTimer =
    timeoutMs > 0
      ? setTimeout(
          () =>
            stop(new TimeoutError(timeoutMs, `Command timed out after ${timeoutMs}ms: ${command}`)),
          timeoutMs
        )
      : undefined
  let drainTimer: NodeJS.Timeout | undefined

  try {
    const { exitCode, signal } = await new Promise<{
      exitCode: number | null
      signal: NodeJS.Signals | null
    }>((resolve, reject) => {
      let exited: { exitCode: number | null; signal: NodeJS.Signals | null } | undefined
      child.once('error', err =>
        reject(
          new CiError('E_EXEC_SPAWN', `Failed to start ${command}: ${err.message}`, { cause: err })
        )
      )
      child.once('exit', (code, sig) => {
        exited = { exitCode: code, signal: sig }
        childExited = true
        // A background grandchild may hold the pipes open forever; stop waiting.
        drainTimer = setTimeout(() => {
          child.stdout?.destroy()
          child.stderr?.destroy()
          resolve(exited ?? { exitCode: code, signal: sig })
        }, PIPE_DRAIN_MS)
      })
      child.once('close', (code, sig) => resolve(exited ?? { exitCode: code, signal: sig }))
    })

    if (stopReason) {
      await reapGroup(child, killGraceMs)
      throw stopReason
    }
    const result: ExecResult = {
      command: display,
      exitCode,
      signal,
      stdout: stdout.toString(),
      stderr: stderr.toString(),
      durationMs: Math.round(performance.now() - started)
    }
    if ((exitCode !== 0 || signal !== null) && !options.allowFailure) {
      throw new ExecError(result)
    }
    return result
  } finally {
    clearTimeout(timeoutTimer)
    clearTimeout(graceTimer)
    clearTimeout(drainTimer)
    options.signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * Split a command line into argv without invoking a shell.
 * Supports 'single' and "double" quotes and backslash escapes of quotes,
 * backslashes and spaces; any other backslash is literal (Windows paths work).
 * Shell features (pipes, `&&`, globs, `$VAR`) are intentionally not supported.
 *
 * @throws {CiError} on an unterminated quote or an empty command.
 */
export function parseCommandLine(line: string): string[] {
  const args: string[] = []
  let current = ''
  let hasToken = false
  let quote: '"' | "'" | undefined

  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string
    const next = line[i + 1]
    if (quote === "'") {
      if (ch === "'") quote = undefined
      else current += ch
    } else if (quote === '"') {
      if (ch === '"') quote = undefined
      else if (ch === '\\' && (next === '"' || next === '\\')) current += line[++i]
      else current += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      hasToken = true
    } else if (ch === '\\' && next !== undefined && /["'\\ ]/.test(next)) {
      current += line[++i]
      hasToken = true
    } else if (/\s/.test(ch)) {
      if (hasToken) args.push(current)
      current = ''
      hasToken = false
    } else {
      current += ch
      hasToken = true
    }
  }
  if (quote) throw new CiError('E_PARSE', `Unterminated ${quote} quote in: ${line}`)
  if (hasToken) args.push(current)
  if (args.length === 0) throw new CiError('E_PARSE', 'Empty command line')
  return args
}
