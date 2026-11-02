import { CiError } from '../../sdk/src/index.js'

const START = '<DeveloperData Value="'
const END = '"/>'

/**
 * Extract the Unity serial from the content of a `.ulf` license file.
 * @see https://github.com/game-ci/unity-test-runner/blob/05a00ef5aced57c6f2d3b8f2a98d2239a1f24c0f/src/model/input.ts#L60
 */
export function getSerialFromLicense(license: string): string {
  const start = license.indexOf(START)
  if (start < 0) {
    throw new CiError('E_LICENSE', 'License file is corrupted: <DeveloperData> not found')
  }
  const from = start + START.length
  const end = license.indexOf(END, from)
  if (end < 0) {
    throw new CiError('E_LICENSE', 'License file is corrupted: <DeveloperData> is not closed')
  }
  const serial = Buffer.from(license.slice(from, end), 'base64').toString('binary').slice(4).trim()
  if (!serial) throw new CiError('E_LICENSE', 'Serial key not found in license')
  return serial
}
