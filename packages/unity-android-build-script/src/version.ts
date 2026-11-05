import { CiError } from '../../sdk/src/index.js'

/** Highest version code Google Play accepts. */
export const MAX_VERSION_CODE = 2_100_000_000

export interface ReleaseVersion {
  /** `X.Y.Z` */
  name: string
  /** `X*10000 + Y*100 + Z` */
  code: number
}

/**
 * Version from a release tag `vX.Y.Z` (or `X.Y.Z`): strict semver core, no pre-release or build
 * suffix, no leading zeros. The code `X*10000 + Y*100 + Z` always grows with the version, so Y and
 * Z must stay below 100.
 */
export function parseReleaseVersion(raw: string): ReleaseVersion {
  const value = raw.trim()
  const m = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value)
  if (!m) {
    throw new CiError(
      'E_VERSION',
      `"${value}" is not a release version: use a tag vX.Y.Z (e.g. v1.0.2), digits only, no leading zeros or suffix`
    )
  }
  const [x, y, z] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (y >= 100 || z >= 100) {
    throw new CiError(
      'E_VERSION',
      `"${value}": minor and patch must be below 100, the version code is X*10000 + Y*100 + Z`
    )
  }
  const code = x * 10000 + y * 100 + z
  if (code < 1 || code > MAX_VERSION_CODE) {
    throw new CiError(
      'E_VERSION',
      `"${value}" gives version code ${code}, outside 1..${MAX_VERSION_CODE} (Google Play)`
    )
  }
  return { name: `${x}.${y}.${z}`, code }
}

/** An explicit version code: a whole number in 1..MAX_VERSION_CODE. */
export function parseVersionCode(raw: string): number {
  const value = raw.trim()
  const code = /^[1-9]\d*$/.test(value) ? Number(value) : NaN
  if (!Number.isSafeInteger(code) || code > MAX_VERSION_CODE) {
    throw new CiError(
      'E_VERSION',
      `version-code "${value}" must be a whole number in 1..${MAX_VERSION_CODE}`
    )
  }
  return code
}
