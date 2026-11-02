import * as core from '@actions/core'
import { input, readInputs } from '../../sdk/src/index.js'
import { getSerialFromLicense } from './serial.js'

export function run(): void {
  const { license } = readInputs({ license: input.string({ required: true, secret: true }) })
  const serial = getSerialFromLicense(license)
  // Mask before it can appear anywhere (v1 masked the literal word "serial", leaking the key).
  core.setSecret(serial)
  core.setOutput('serial', serial)
}
