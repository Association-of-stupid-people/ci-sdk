import * as core from '@actions/core'
import { getCiContext, type CiContext } from './context.js'
import { formatDuration, parseDuration } from './duration.js'
import { AbortError, RetryError, TimeoutError, errorMessage } from './errors.js'
import { exec, type ExecOptions, type ExecResult } from './exec.js'
import { group } from './log.js'
import { retry, type RetryOptions } from './retry.js'
import { withTimeout } from './timeout.js'

export type StepStatus = 'success' | 'failure' | 'soft-failure' | 'skipped' | 'cancelled'
export type PipelineStatus = 'success' | 'failure' | 'cancelled'

export interface StepContext<S> {
  /** Step name. */
  name: string
  /** 1-based attempt (greater than 1 when retrying). */
  attempt: number
  /** Fires on step timeout, pipeline timeout or cancellation. Pass it to I/O calls. */
  signal: AbortSignal
  /** Mutable state shared by all steps (e.g. a version computed by one step and used by the next). */
  state: S
  ci: CiContext
  /** `exec` bound to this step's signal, so a timeout or cancel kills the process. */
  exec(command: string, args?: readonly string[], options?: ExecOptions): Promise<ExecResult>
}

export interface ConditionContext<S> {
  state: S
  ci: CiContext
  /** Status of the pipeline so far. */
  status: PipelineStatus
  results: readonly StepResult[]
}

export interface StepOptions<S> {
  /** Retries for flaky steps: a number of attempts or full retry options. Default 1 attempt. */
  retry?: number | Omit<RetryOptions, 'signal'>
  /** Time budget per attempt (ms or duration string). */
  timeout?: number | string
  /** A failure is reported but does not fail the pipeline. */
  continueOnError?: boolean
  /** Skip the step when this returns false. */
  if?: (ctx: ConditionContext<S>) => boolean
  /**
   * Run even after an earlier failure or cancellation (cleanup, log upload).
   * Never receives the cancellation signal; once the pipeline is cancelled or
   * times out it gets `cleanupTimeout` to finish.
   */
  always?: boolean
}

export interface StepResult {
  name: string
  status: StepStatus
  attempts: number
  durationMs: number
  error?: string
}

export interface PipelineReport {
  name: string
  status: PipelineStatus
  durationMs: number
  steps: StepResult[]
}

export interface PipelineOptions<S> {
  name?: string
  /** Initial shared state. */
  state?: S
  /** Budget for the whole pipeline; `always` steps still run after it expires. */
  timeout?: number | string
  /** External cancellation. */
  signal?: AbortSignal
  /** Cancel on SIGINT/SIGTERM (what the runner sends when a run is cancelled). Default true. */
  handleSignals?: boolean
  /** Override the CI context (tests, non-GitHub CI). */
  ci?: CiContext
  /** Time `always` steps get to finish once the pipeline is cancelled or timed out. Default 60s. */
  cleanupTimeout?: number | string
}

type StepFn<S> = (ctx: StepContext<S>) => Promise<unknown>

interface StepDef<S> {
  name: string
  fn: StepFn<S>
  options: StepOptions<S>
}

/**
 * Ordered CI steps with GitHub-Actions-like semantics and built-in resilience:
 *
 * - a failed step skips the following steps, `always` steps still run;
 * - per-step retry with backoff, per-attempt timeout, `continueOnError`, `if`;
 * - a pipeline timeout and SIGINT/SIGTERM cancel the running step and kill its processes;
 * - each step runs in a log group with its duration; `run()` returns a report
 *   (see `writeJobSummary`) instead of throwing.
 *
 * ```ts
 * const report = await new Pipeline({ name: 'build' })
 *   .step('install', ctx => ctx.exec('npm', ['ci']), { retry: 3, timeout: '10m' })
 *   .step('test', ctx => ctx.exec('npm', ['test']))
 *   .always('cleanup', ctx => ctx.exec('docker', ['compose', 'down']))
 *   .run()
 * ```
 */
export class Pipeline<S extends object = Record<string, unknown>> {
  private readonly steps: StepDef<S>[] = []
  private readonly options: PipelineOptions<S>

  constructor(options: PipelineOptions<S> = {}) {
    this.options = options
  }

  step(name: string, fn: StepFn<S>, options: StepOptions<S> = {}): this {
    this.steps.push({ name, fn, options })
    return this
  }

  /** Shorthand for `step(name, fn, { ...options, always: true })`. */
  always(name: string, fn: StepFn<S>, options: StepOptions<S> = {}): this {
    return this.step(name, fn, { ...options, always: true })
  }

  async run(): Promise<PipelineReport> {
    const name = this.options.name ?? 'pipeline'
    const ci = this.options.ci ?? getCiContext()
    const state = (this.options.state ?? {}) as S
    const started = performance.now()
    const results: StepResult[] = []
    const cleanupTimeout = parseDuration(this.options.cleanupTimeout ?? 60_000)

    const controller = new AbortController()
    const disposers: (() => void)[] = []
    const cancel = (reason: Error): void => {
      if (!controller.signal.aborted) controller.abort(reason)
    }

    const parent = this.options.signal
    if (parent) {
      if (parent.aborted) cancel(new AbortError('Pipeline cancelled before start'))
      const onParent = (): void => cancel(new AbortError('Pipeline cancelled'))
      parent.addEventListener('abort', onParent, { once: true })
      disposers.push(() => parent.removeEventListener('abort', onParent))
    }
    if (this.options.handleSignals ?? true) {
      for (const sig of ['SIGINT', 'SIGTERM'] as const) {
        const onSignal = (): void => {
          core.warning(`Received ${sig}, cancelling "${name}" (cleanup steps still run)`)
          cancel(new AbortError(`Received ${sig}`))
        }
        process.once(sig, onSignal)
        disposers.push(() => process.removeListener(sig, onSignal))
      }
    }
    const pipelineTimeout = parseDuration(this.options.timeout ?? 0)
    if (pipelineTimeout > 0) {
      const t = setTimeout(
        () => cancel(new TimeoutError(pipelineTimeout, `Pipeline "${name}" timed out`)),
        pipelineTimeout
      )
      disposers.push(() => clearTimeout(t))
    }

    let failed = false
    try {
      for (const def of this.steps) {
        const cancelled = controller.signal.aborted
        const status: PipelineStatus = cancelled ? 'cancelled' : failed ? 'failure' : 'success'

        if ((cancelled || failed) && !def.options.always) {
          results.push(skip(def.name, cancelled ? 'cancelled' : 'skipped'))
          continue
        }
        if (def.options.if && !safeCondition(def, { state, ci, status, results })) {
          results.push(skip(def.name, 'skipped'))
          continue
        }

        const timeout = def.options.timeout !== undefined ? parseDuration(def.options.timeout) : 0
        const result = def.options.always
          ? await this.runCleanupStep(def, {
              state,
              ci,
              timeout,
              cancel: controller.signal,
              cleanupTimeout
            })
          : await this.runStep(def, { state, ci, signal: controller.signal, timeout })
        results.push(result)
        if (result.status === 'failure') failed = true
      }
    } finally {
      for (const dispose of disposers) dispose()
    }

    const status: PipelineStatus = controller.signal.aborted
      ? controller.signal.reason instanceof TimeoutError
        ? 'failure'
        : 'cancelled'
      : failed
        ? 'failure'
        : 'success'
    const durationMs = Math.round(performance.now() - started)
    core.info(`Pipeline "${name}" finished: ${status} in ${formatDuration(durationMs)}`)
    return { name, status, durationMs, steps: results }
  }

  /**
   * `always` steps never share the cancellation signal: a cancel (or pipeline
   * timeout) that happens before or during them only arms a `cleanupTimeout`
   * budget, so cleanup gets a bounded chance to finish instead of being killed.
   */
  private async runCleanupStep(
    def: StepDef<S>,
    env: { state: S; ci: CiContext; timeout: number; cancel: AbortSignal; cleanupTimeout: number }
  ): Promise<StepResult> {
    const own = new AbortController()
    let budget: NodeJS.Timeout | undefined
    const arm = (): void => {
      budget = setTimeout(
        () =>
          own.abort(
            new TimeoutError(
              env.cleanupTimeout,
              `Step "${def.name}" exceeded the ${formatDuration(env.cleanupTimeout)} cleanup budget after cancellation`
            )
          ),
        env.cleanupTimeout
      )
    }
    if (env.cancel.aborted) arm()
    else env.cancel.addEventListener('abort', arm, { once: true })
    try {
      return await this.runStep(def, {
        state: env.state,
        ci: env.ci,
        signal: own.signal,
        timeout: env.timeout
      })
    } finally {
      clearTimeout(budget)
      env.cancel.removeEventListener('abort', arm)
    }
  }

  private async runStep(
    def: StepDef<S>,
    env: { state: S; ci: CiContext; signal: AbortSignal; timeout: number }
  ): Promise<StepResult> {
    const started = performance.now()
    const retryOpts: Omit<RetryOptions, 'signal'> =
      typeof def.options.retry === 'number'
        ? { attempts: def.options.retry }
        : (def.options.retry ?? { attempts: 1 })
    let attempts = 0

    try {
      await group(def.name, async () =>
        retry(
          async ({ attempt }) => {
            attempts = attempt
            return withTimeout(
              async signal =>
                def.fn({
                  name: def.name,
                  attempt,
                  signal,
                  state: env.state,
                  ci: env.ci,
                  exec: async (command, args, options) =>
                    exec(command, args, {
                      ...options,
                      // Keep the step signal: a caller signal must not disable the step timeout.
                      signal: options?.signal ? AbortSignal.any([signal, options.signal]) : signal
                    })
                }),
              env.timeout,
              {
                signal: env.signal,
                message: `Step "${def.name}" timed out after ${formatDuration(env.timeout)}`,
                // Wait for killed processes to exit before a retry/next step starts.
                settle: STOP_SETTLE_MS
              }
            )
          },
          {
            ...retryOpts,
            signal: env.signal,
            onRetry: (error, attempt, delayMs) => {
              core.warning(
                `Step "${def.name}" attempt ${attempt} failed: ${errorMessage(error)}; retrying in ${formatDuration(delayMs)}`
              )
              retryOpts.onRetry?.(error, attempt, delayMs)
            }
          }
        )
      )
      return { name: def.name, status: 'success', attempts, durationMs: elapsed(started) }
    } catch (err) {
      const cause = err instanceof RetryError ? err.cause : err
      const message = errorMessage(cause)
      // Cancelled only if *our* signal fired for a reason other than a timeout;
      // an AbortError thrown by the step itself (e.g. its own fetch) is a failure.
      const cancelled =
        env.signal.aborted &&
        !(env.signal.reason instanceof TimeoutError) &&
        !(err instanceof TimeoutError)
      const status: StepStatus = cancelled
        ? 'cancelled'
        : def.options.continueOnError
          ? 'soft-failure'
          : 'failure'
      if (status === 'soft-failure')
        core.warning(`Step "${def.name}" failed (continue-on-error): ${message}`)
      else if (status === 'failure')
        core.error(`Step "${def.name}" failed: ${message}`, { title: def.name })
      return {
        name: def.name,
        status,
        attempts,
        durationMs: elapsed(started),
        error: message
      }
    }
  }
}

function skip(name: string, status: 'skipped' | 'cancelled'): StepResult {
  core.info(`○ ${name} (${status})`)
  return { name, status, attempts: 0, durationMs: 0 }
}

function safeCondition<S>(def: StepDef<S>, ctx: ConditionContext<S>): boolean {
  try {
    return def.options.if?.(ctx) ?? true
  } catch (err) {
    core.warning(`Condition of step "${def.name}" threw, skipping: ${errorMessage(err)}`)
    return false
  }
}

/** Max wait for an aborted step to finish (exec SIGTERM->SIGKILL grace is 5s). */
const STOP_SETTLE_MS = 7_000

const elapsed = (started: number): number => Math.round(performance.now() - started)
