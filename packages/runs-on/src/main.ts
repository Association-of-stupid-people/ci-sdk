import * as core from '@actions/core'
import { CiError, getCiContext, input, readInputs } from '../../sdk/src/index.js'
import { isBranchAllowed } from './branch.js'

export function run(): void {
  const cfg = readInputs({
    // Comma-separated; supports globs (`develop*`, `release/**`) and `!exclusions`.
    branch: input.list({ required: true }),
    silent: input.boolean({ default: false })
  })
  const ci = getCiContext()
  const current = ci.branch
  const label = current ? `branch "${current}"` : `ref "${ci.ref ?? 'unknown'}" (not a branch)`

  core.info(`Allowed branches: ${cfg.branch.join(', ')} (silent: ${cfg.silent})`)
  core.info(`Current: ${label}`)

  const allowed = current !== undefined && isBranchAllowed(current, cfg.branch)
  core.setOutput('allowed', String(allowed))
  if (allowed) return

  if (cfg.silent) {
    core.notice(`Not allowed to run on ${label}; later steps should check outputs.allowed`)
    return
  }
  throw new CiError('E_BRANCH', `Not allowed to run on ${label}`)
}
