import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CiError } from '../../sdk/src/index.js'

/** Pinned release: https://github.com/google/bundletool/releases/tag/1.18.3 (GitHub asset digest). */
export const PINNED_BUNDLETOOL = {
  version: '1.18.3',
  sha256: 'a099cfa1543f55593bc2ed16a70a7c67fe54b1747bb7301f37fdfd6d91028e29'
}

export type Fetch = typeof fetch

export const bundletoolUrl = (version: string): string =>
  `https://github.com/google/bundletool/releases/download/${version}/bundletool-all-${version}.jar`

export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

export interface BundletoolOptions {
  version: string
  sha256: string
  /** RUNNER_TOOL_CACHE (default: the OS temp dir). */
  toolCache: string | undefined
  fetchImpl?: Fetch
  log?: (message: string) => void
}

/**
 * The bundletool jar from the tool cache, downloaded once per version. Its sha256 is checked on
 * download and again on every use (a persistent runner's cache could have been changed).
 * @returns the jar path.
 */
export async function ensureBundletool(options: BundletoolOptions): Promise<string> {
  const { version } = options
  const expected = options.sha256.toLowerCase()
  const log = options.log ?? (() => undefined)
  const dir = path.join(
    options.toolCache || path.join(os.tmpdir(), 'ci-sdk-tool-cache'),
    'bundletool',
    version
  )
  const jar = path.join(dir, `bundletool-all-${version}.jar`)

  try {
    await stat(jar)
    if ((await sha256File(jar)) === expected) return jar
    log(`Cached ${jar} does not match its sha256: downloading it again`)
    await rm(jar, { force: true })
  } catch {
    // not cached yet
  }

  const url = bundletoolUrl(version)
  log(`Download ${url}`)
  // A stalled download must not hang the release job until the workflow's hard timeout.
  let bytes: Buffer
  try {
    const res = await (options.fetchImpl ?? fetch)(url, { signal: AbortSignal.timeout(5 * 60_000) })
    if (!res.ok)
      throw new CiError('E_BUNDLETOOL', `bundletool download failed: ${res.status} ${url}`)
    bytes = Buffer.from(await res.arrayBuffer())
  } catch (err) {
    if (err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new CiError('E_BUNDLETOOL', `bundletool download timed out after 5 minutes: ${url}`)
    }
    throw err
  }
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== expected) {
    throw new CiError(
      'E_BUNDLETOOL',
      `bundletool ${version} sha256 mismatch: expected ${expected}, got ${actual} (${url})`
    )
  }
  await mkdir(dir, { recursive: true })
  const part = `${jar}.${process.pid}.part`
  await writeFile(part, bytes)
  await rename(part, jar)
  return jar
}
