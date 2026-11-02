/**
 * ci-sdk: building blocks for reliable CI steps and GitHub Actions.
 *
 * - `readInputs` / `input`: typed, validated action inputs (all errors at once)
 * - `getCiContext`: typed GitHub Actions environment
 * - `retry`, `withTimeout`, `sleep`: resilience primitives with AbortSignal support
 * - `exec`: shell-free process runner with timeout, cancellation and output capture
 * - `Pipeline`: ordered steps with retry/timeout/continue-on-error/always + report
 * - `writeJobSummary`, `group`, `mask`, `annotate`: reporting helpers
 * - `runAction`: safe entrypoint wrapper
 */
export * from './errors.js'
export { parseDuration, formatDuration } from './duration.js'
export { sleep, throwIfAborted } from './abort.js'
export { withTimeout, type TimeoutOptions } from './timeout.js'
export { retry, backoffDelay, type RetryOptions, type AttemptInfo } from './retry.js'
export {
  input,
  readInputs,
  type InputSpec,
  type InputSpecs,
  type InputValues,
  type InputValue,
  type ReadInputsOptions
} from './inputs.js'
export { getCiContext, readEventPayload, type CiContext } from './context.js'
export { exec, formatCommand, parseCommandLine, type ExecOptions, type ExecResult } from './exec.js'
export {
  Pipeline,
  type PipelineOptions,
  type PipelineReport,
  type PipelineStatus,
  type StepContext,
  type StepOptions,
  type StepResult,
  type StepStatus,
  type ConditionContext
} from './pipeline.js'
export { reportToMarkdown, writeJobSummary } from './summary.js'
export {
  group,
  mask,
  annotate,
  printUntrusted,
  withoutCommands,
  type AnnotationLocation
} from './log.js'
export { runAction } from './action.js'
export {
  GitHubClient,
  GitHubApiError,
  nextLink,
  type GitHubClientOptions,
  type GitHubRequestOptions,
  type GitHubResponse,
  type Query
} from './github.js'
