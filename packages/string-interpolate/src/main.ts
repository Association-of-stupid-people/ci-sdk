import * as core from '@actions/core'
import { input, readInputs } from '../../sdk/src/index.js'

export function run(): void {
  const cfg = readInputs({
    // Not required: an empty value is a valid result (e.g. an optional var).
    value: input.string({ default: '' }),
    mask: input.boolean({ default: false })
  })
  if (cfg.mask && cfg.value) core.setSecret(cfg.value)
  core.setOutput('value', cfg.value)
}
