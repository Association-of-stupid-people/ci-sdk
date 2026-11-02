import { readFileSync } from 'node:fs'
import * as core from '@actions/core'
import {
  CiError,
  GitHubApiError,
  GitHubClient,
  errorMessage,
  getCiContext,
  input,
  readEventPayload,
  readInputs,
  sleep
} from '../../sdk/src/index.js'
import {
  checkTag,
  decide,
  describeRun,
  fixHint,
  parseVersion,
  parseWorkflowRef,
  type WorkflowRun
} from './logic.js'

export interface RunOptions {
  /** Injectable for tests. Default: global `fetch`. */
  fetch?: typeof fetch
  /** Retry backoff of the API client; lower it in tests. */
  minDelay?: number | string
}

const isTransient = (status: number): boolean => status === 408 || status === 429 || status >= 500

/** 429, or a 403 that is a primary/secondary rate limit rather than missing permissions. */
function isRateLimited(err: GitHubApiError): boolean {
  if (err.status === 429) return true
  if (err.status !== 403) return false
  return (
    err.headers.get('x-ratelimit-remaining') === '0' ||
    err.headers.has('retry-after') ||
    /rate limit/i.test(err.body)
  )
}

/** Milliseconds to wait per `retry-after` (seconds) or `x-ratelimit-reset` (epoch seconds). */
function rateLimitWait(headers: Headers | undefined): number {
  const retryAfter = Number(headers?.get('retry-after'))
  if (headers?.get('retry-after') && Number.isFinite(retryAfter)) return retryAfter * 1000
  const reset = Number(headers?.get('x-ratelimit-reset'))
  if (headers?.get('x-ratelimit-reset') && Number.isFinite(reset)) {
    return Math.max(0, reset * 1000 - Date.now())
  }
  return 0
}

function resolveTag(configured: string | undefined): string {
  if (configured) return configured
  const ctx = getCiContext()
  const payload = readEventPayload<{ release?: { tag_name?: string } }>(ctx)
  const tag = payload?.release?.tag_name ?? (ctx.refType === 'tag' ? ctx.refName : undefined)
  if (!tag) throw new CiError('E_TAG', 'No release tag: set the "tag" input')
  return tag
}

/** Wait for a green CI run of the commit and/or verify the tag against the project version. */
export async function run(options: RunOptions = {}): Promise<void> {
  const cfg = readInputs({
    token: input.string({ secret: true }),
    workflow: input.string(),
    sha: input.string(),
    events: input.list({ default: ['push', 'workflow_dispatch'] }),
    timeout: input.duration({ default: '60m' }),
    noRunGrace: input.duration({ name: 'no-run-grace', default: '5m' }),
    pollInterval: input.duration({ name: 'poll-interval', default: '30s', min: 1 }),
    versionFile: input.string({ name: 'version-file' }),
    tag: input.string(),
    tagPrefix: input.string({ name: 'tag-prefix', default: 'v' }),
    skipCiCheck: input.boolean({ name: 'skip-ci-check', default: false })
  })
  const ctx = getCiContext()

  if (cfg.versionFile) {
    const version = parseVersion(cfg.versionFile, readFileSync(cfg.versionFile, 'utf8'))
    const tag = resolveTag(cfg.tag)
    checkTag(tag, cfg.tagPrefix, version)
    core.info(`Tag ${tag} matches version ${version} from ${cfg.versionFile}`)
    core.setOutput('version', version)
  }
  if (cfg.skipCiCheck) return

  const workflow = cfg.workflow ?? parseWorkflowRef(process.env.GITHUB_WORKFLOW_REF)
  if (!workflow) {
    throw new CiError('E_WORKFLOW', 'Set the "workflow" input (GITHUB_WORKFLOW_REF is not set)')
  }
  const sha = cfg.sha ?? ctx.sha
  if (!sha) throw new CiError('E_SHA', 'Set the "sha" input (GITHUB_SHA is not set)')
  if (!ctx.repository) throw new CiError('E_REPO', 'GITHUB_REPOSITORY is not set')
  if (!cfg.token) throw new CiError('E_GITHUB_TOKEN', 'The "token" input is required')

  const { owner, repo } = ctx.repository
  const gh = new GitHubClient({
    token: cfg.token,
    fetch: options.fetch,
    minDelay: options.minDelay
  })
  const path = `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs`
  const hint = fixHint(sha, workflow)
  const start = Date.now()
  const deadline = start + cfg.timeout
  const graceEnd = start + Math.min(cfg.noRunGrace, cfg.timeout)

  for (;;) {
    let runs: WorkflowRun[]
    try {
      runs = await gh.paginate<WorkflowRun>(path, { head_sha: sha }, 'workflow_runs')
    } catch (err) {
      const limited = err instanceof GitHubApiError && isRateLimited(err)
      if (err instanceof GitHubApiError && !limited && !isTransient(err.status)) {
        const why =
          err.status === 403
            ? ' (the job needs `permissions: actions: read`)'
            : err.status === 404
              ? ' (workflow or repository not found)'
              : err.status === 401
                ? ' (bad token)'
                : ''
        throw new CiError(
          'E_GITHUB_API',
          `Cannot list runs of ${workflow}: HTTP ${err.status}${why}`,
          {
            cause: err
          }
        )
      }
      core.warning(`Listing runs failed, will retry: ${errorMessage(err)}`)
      if (Date.now() >= deadline) {
        throw new CiError(
          'E_CI_TIMEOUT',
          `Timed out waiting for CI of ${sha}; the GitHub API kept failing. ${hint}`
        )
      }
      const pause = limited
        ? Math.max(
            cfg.pollInterval,
            rateLimitWait(err instanceof GitHubApiError ? err.headers : undefined)
          )
        : cfg.pollInterval
      await sleep(Math.min(pause, deadline - Date.now()))
      continue
    }
    const decision = decide(runs, ctx.runId, cfg.events)

    if (decision.kind === 'pass') {
      core.info(`CI is green: ${describeRun(decision.run)}`)
      core.setOutput('run-id', String(decision.run.id))
      core.setOutput('run-url', decision.run.html_url ?? '')
      return
    }
    if (decision.kind === 'fail') {
      const seen = decision.seen.map(describeRun).join(', ') || 'none'
      throw new CiError(
        'E_CI_NOT_GREEN',
        `No green ${cfg.events.join('/')} run of ${workflow} for ${sha}; seen: ${seen}. ${hint}`
      )
    }

    if (decision.kind === 'none') {
      if (Date.now() >= graceEnd) {
        throw new CiError(
          'E_CI_NOT_GREEN',
          `No ${cfg.events.join('/')} run of ${workflow} found for ${sha}; seen: none. ${hint}`
        )
      }
      core.info('No CI run listed yet, waiting')
      await sleep(Math.min(cfg.pollInterval, graceEnd - Date.now()))
      continue
    }

    const list = decision.pending.map(describeRun).join(', ')
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new CiError(
        'E_CI_TIMEOUT',
        `Timed out waiting for CI of ${sha}; still pending: ${list}. ${hint}`
      )
    }
    core.info(`Waiting for CI: ${list}`)
    await sleep(Math.min(cfg.pollInterval, remaining))
  }
}
