import * as core from '@actions/core'
import { getCiContext, input, readEventPayload, readInputs } from '../../sdk/src/index.js'
import { evaluate } from './eval.js'

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Event payload, or {} when unavailable (like @actions/github in v1). */
function safePayload(ci: ReturnType<typeof getCiContext>): unknown {
  try {
    return readEventPayload(ci) ?? {}
  } catch (err) {
    core.debug(`eval: cannot read event payload: ${String(err)}`)
    return {}
  }
}

/**
 * `github` context exposed to templates. Includes the v1 keys (shape of
 * `@actions/github`'s `context`: `eventName`, `payload`, `repo.owner`, `runId`...)
 * so existing templates keep working, plus workflow-style snake_case aliases.
 */
function githubContext(): Record<string, unknown> {
  const ci = getCiContext()
  const payload = safePayload(ci)
  return {
    // v1 (@actions/github context) keys
    payload,
    eventName: ci.eventName,
    sha: ci.sha,
    ref: ci.ref,
    workflow: ci.workflow,
    action: process.env.GITHUB_ACTION,
    actor: ci.actor,
    job: ci.job,
    runId: ci.runId === undefined ? undefined : Number(ci.runId),
    runNumber: ci.runNumber,
    runAttempt: ci.runAttempt,
    apiUrl: ci.apiUrl,
    serverUrl: ci.serverUrl,
    graphqlUrl: process.env.GITHUB_GRAPHQL_URL || 'https://api.github.com/graphql',
    repo: ci.repository && { owner: ci.repository.owner, repo: ci.repository.repo },
    // workflow-expression style aliases
    repository: ci.repository?.fullName,
    repository_owner: ci.repository?.owner,
    event_name: ci.eventName,
    ref_name: ci.refName,
    head_ref: ci.headRef,
    base_ref: ci.baseRef,
    run_id: ci.runId,
    run_number: ci.runNumber,
    run_attempt: ci.runAttempt,
    server_url: ci.serverUrl,
    event: payload
  }
}

export function run(): void {
  const cfg = readInputs({
    // Empty is valid: workflows pass optional inputs (e.g. `submodules: ""`) straight through.
    template: input.string({ default: '' }),
    secrets: input.json({ default: {}, validate: isRecord }),
    vars: input.json({ default: {}, validate: isRecord })
  })

  // Values from toJSON(secrets) are already masked by the runner; re-register
  // them so derived logs stay masked even if the runner's masker misses one.
  for (const v of Object.values(cfg.secrets)) if (typeof v === 'string' && v) core.setSecret(v)

  const result = evaluate(cfg.template, {
    github: githubContext(),
    vars: cfg.vars,
    secrets: cfg.secrets
  })
  for (const placeholder of result.unresolved) {
    core.warning(`eval: ${placeholder} is not set, left unchanged`)
  }
  core.setOutput('value', result.value)
}
