import { readFileSync } from 'node:fs'

/** Typed view of the CI environment (GitHub Actions default variables). */
export interface CiContext {
  /** `CI=true` is set (any provider). */
  isCI: boolean
  /** Running inside GitHub Actions. */
  isGitHubActions: boolean
  /** Step debug logging enabled (`ACTIONS_STEP_DEBUG` / `RUNNER_DEBUG`). */
  isDebug: boolean
  repository: { owner: string; repo: string; fullName: string } | undefined
  serverUrl: string
  apiUrl: string
  eventName: string | undefined
  eventPath: string | undefined
  sha: string | undefined
  ref: string | undefined
  refName: string | undefined
  refType: 'branch' | 'tag' | undefined
  /** PR base/head branch; set only for pull_request(_target) events. */
  baseRef: string | undefined
  headRef: string | undefined
  /**
   * Branch being built: the PR head branch for pull requests, otherwise the
   * pushed branch. `undefined` for tag pushes.
   */
  branch: string | undefined
  isPullRequest: boolean
  /** Parsed from `refs/pull/<n>/merge`. */
  pullRequestNumber: number | undefined
  workflow: string | undefined
  job: string | undefined
  actor: string | undefined
  runId: string | undefined
  runAttempt: number | undefined
  runNumber: number | undefined
  /** Link to the workflow run, when enough variables are set. */
  runUrl: string | undefined
  workspace: string | undefined
  runner: {
    os: string | undefined
    arch: string | undefined
    name: string | undefined
    temp: string | undefined
    toolCache: string | undefined
  }
  /**
   * Name that is unique per run attempt, e.g. for containers, volumes or
   * temp dirs on shared self-hosted runners: `<prefix>-<runId>-<attempt>`.
   */
  uniqueName(prefix: string): string
}

type Env = Readonly<Record<string, string | undefined>>

const nonEmpty = (v: string | undefined): string | undefined => (v ? v : undefined)
const toInt = (v: string | undefined): number | undefined => {
  const n = v ? Number.parseInt(v, 10) : NaN
  return Number.isNaN(n) ? undefined : n
}

/** Build the CI context from environment variables (default `process.env`). */
export function getCiContext(env: Env = process.env): CiContext {
  const serverUrl = env.GITHUB_SERVER_URL || 'https://github.com'
  const fullName = nonEmpty(env.GITHUB_REPOSITORY)
  const [owner, repo] = fullName?.split('/') ?? []
  const repository = owner && repo ? { owner, repo, fullName: `${owner}/${repo}` } : undefined
  const ref = nonEmpty(env.GITHUB_REF)
  const eventName = nonEmpty(env.GITHUB_EVENT_NAME)
  const prMatch = ref ? /^refs\/pull\/(\d+)\//.exec(ref) : null
  const runId = nonEmpty(env.GITHUB_RUN_ID)
  const runAttempt = toInt(env.GITHUB_RUN_ATTEMPT)
  const refType =
    env.GITHUB_REF_TYPE === 'branch' || env.GITHUB_REF_TYPE === 'tag'
      ? env.GITHUB_REF_TYPE
      : undefined

  return {
    isCI: env.CI === 'true' || env.CI === '1',
    isGitHubActions: env.GITHUB_ACTIONS === 'true',
    isDebug: env.RUNNER_DEBUG === '1' || env.ACTIONS_STEP_DEBUG === 'true',
    repository,
    serverUrl,
    apiUrl: env.GITHUB_API_URL || 'https://api.github.com',
    eventName,
    eventPath: nonEmpty(env.GITHUB_EVENT_PATH),
    sha: nonEmpty(env.GITHUB_SHA),
    ref,
    refName: nonEmpty(env.GITHUB_REF_NAME),
    refType,
    baseRef: nonEmpty(env.GITHUB_BASE_REF),
    headRef: nonEmpty(env.GITHUB_HEAD_REF),
    branch:
      nonEmpty(env.GITHUB_HEAD_REF) ??
      (ref?.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : undefined),
    isPullRequest:
      eventName === 'pull_request' || eventName === 'pull_request_target' || prMatch !== null,
    pullRequestNumber: prMatch ? Number(prMatch[1]) : undefined,
    workflow: nonEmpty(env.GITHUB_WORKFLOW),
    job: nonEmpty(env.GITHUB_JOB),
    actor: nonEmpty(env.GITHUB_ACTOR),
    runId,
    runAttempt,
    runNumber: toInt(env.GITHUB_RUN_NUMBER),
    runUrl:
      repository && runId ? `${serverUrl}/${repository.fullName}/actions/runs/${runId}` : undefined,
    workspace: nonEmpty(env.GITHUB_WORKSPACE),
    runner: {
      os: nonEmpty(env.RUNNER_OS),
      arch: nonEmpty(env.RUNNER_ARCH),
      name: nonEmpty(env.RUNNER_NAME),
      temp: nonEmpty(env.RUNNER_TEMP),
      toolCache: nonEmpty(env.RUNNER_TOOL_CACHE)
    },
    uniqueName(prefix: string): string {
      const id = runId ?? `local${process.pid}`
      return `${prefix}-${id}-${runAttempt ?? 1}`
    }
  }
}

/**
 * Read the webhook payload that triggered the run (`GITHUB_EVENT_PATH`).
 * Returns `undefined` outside Actions. The payload contains attacker-controlled
 * text (PR titles, branch names, comments): never interpolate it into shell
 * commands; pass it as a separate argv element or env variable.
 */
export function readEventPayload<T = Record<string, unknown>>(
  ctx: Pick<CiContext, 'eventPath'> = getCiContext()
): T | undefined {
  if (!ctx.eventPath) return undefined
  return JSON.parse(readFileSync(ctx.eventPath, 'utf8')) as T
}
