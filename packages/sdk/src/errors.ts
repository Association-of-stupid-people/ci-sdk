/** Base class for every error raised by the SDK. `code` is stable and safe to branch on. */
export class CiError extends Error {
  readonly code: string

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = new.target.name
    this.code = code
  }
}

export interface InputIssue {
  /** Input name as declared in action.yml. */
  input: string
  message: string
}

/** One or more action inputs are missing or malformed. Lists every issue, not just the first. */
export class InputError extends CiError {
  readonly issues: readonly InputIssue[]

  constructor(issues: readonly InputIssue[]) {
    const lines = issues.map(i => `  - ${i.input}: ${i.message}`).join('\n')
    super('E_INPUT', `Invalid action inputs:\n${lines}`)
    this.issues = issues
  }
}

/** An operation exceeded its time budget. */
export class TimeoutError extends CiError {
  readonly timeoutMs: number

  constructor(timeoutMs: number, message?: string) {
    super('E_TIMEOUT', message ?? `Operation timed out after ${timeoutMs}ms`)
    this.timeoutMs = timeoutMs
  }
}

/** The operation was cancelled (workflow cancelled, SIGINT/SIGTERM, or a parent AbortSignal). */
export class AbortError extends CiError {
  constructor(message = 'Operation was cancelled', options?: ErrorOptions) {
    super('E_ABORTED', message, options)
  }
}

/** All retry attempts failed. `cause` holds the last error. */
export class RetryError extends CiError {
  readonly attempts: number
  readonly errors: readonly unknown[]

  constructor(attempts: number, errors: readonly unknown[]) {
    const last = errors.at(-1)
    super('E_RETRY_EXHAUSTED', `Failed after ${attempts} attempt(s): ${errorMessage(last)}`, {
      cause: last
    })
    this.attempts = attempts
    this.errors = errors
  }
}

/** A child process exited with a non-zero code or was killed by a signal. */
export class ExecError extends CiError {
  readonly command: string
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string

  constructor(init: {
    command: string
    exitCode: number | null
    signal: NodeJS.Signals | null
    stdout: string
    stderr: string
  }) {
    const how = init.signal ? `was killed by ${init.signal}` : `exited with code ${init.exitCode}`
    super('E_EXEC', `Command ${how}: ${init.command}`)
    this.command = init.command
    this.exitCode = init.exitCode
    this.signal = init.signal
    this.stdout = init.stdout
    this.stderr = init.stderr
  }
}

/** Human-readable message for any thrown value. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err) ?? String(err)
  } catch {
    return String(err)
  }
}

/** True when `err` is a cancellation (SDK AbortError or a DOM-style AbortError). */
export function isAbortError(err: unknown): boolean {
  return err instanceof AbortError || (err instanceof Error && err.name === 'AbortError')
}
