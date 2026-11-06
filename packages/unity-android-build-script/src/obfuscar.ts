import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CiError, extractZipEntry } from '../../sdk/src/index.js'

/**
 * Pinned release: https://www.nuget.org/packages/Obfuscar/2.2.38 (the nupkg's sha256). The console
 * exe inside it targets .NET Framework 4.6.2, so Unity's bundled Mono (MonoBleedingEdge) runs it in
 * the build without a separate .NET install.
 */
export const PINNED_OBFUSCAR = {
  version: '2.2.38',
  sha256: 'b4c90a7cba01d2b86b85b2f3b285b63e09731b3030f7e9fe7cfc6297f9b720fa'
}

/** The entry to extract from the nupkg (a zip), and the name it is cached and copied under. */
export const OBFUSCAR_ENTRY = 'tools/Obfuscar.Console.exe'
export const OBFUSCAR_EXE = 'Obfuscar.Console.exe'

export type Fetch = typeof fetch

export const obfuscarUrl = (version: string): string =>
  `https://api.nuget.org/v3-flatcontainer/obfuscar/${version.toLowerCase()}/obfuscar.${version.toLowerCase()}.nupkg`

export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

export interface ObfuscarOptions {
  version: string
  sha256: string
  /** RUNNER_TOOL_CACHE (default: the OS temp dir). */
  toolCache: string | undefined
  fetchImpl?: Fetch
  log?: (message: string) => void
}

/**
 * The Obfuscar console exe from the tool cache, its nupkg downloaded once per version. The nupkg's
 * sha256 is checked on download and again on every reuse (a persistent runner's cache could have
 * been changed), and the exe is always re-extracted from the verified nupkg — so the file that runs
 * under Unity's Mono is never trusted blindly, even if it was tampered with in place. The zip reader
 * verifies the entry's size and CRC-32 on extraction.
 * @returns the exe path.
 */
export async function ensureObfuscar(options: ObfuscarOptions): Promise<string> {
  const { version } = options
  const expected = options.sha256.toLowerCase()
  const log = options.log ?? (() => undefined)
  const dir = path.join(
    options.toolCache || path.join(os.tmpdir(), 'ci-sdk-tool-cache'),
    'obfuscar',
    version
  )
  const nupkg = path.join(dir, `obfuscar.${version}.nupkg`)
  const exe = path.join(dir, OBFUSCAR_EXE)

  // Make sure a nupkg matching the pinned sha256 is cached, downloading it if missing or changed.
  let valid = false
  try {
    await stat(nupkg)
    if ((await sha256File(nupkg)) === expected) valid = true
    else {
      log(`Cached ${nupkg} does not match its sha256: downloading it again`)
      await rm(nupkg, { force: true })
    }
  } catch {
    // not cached yet
  }

  if (!valid) {
    const url = obfuscarUrl(version)
    log(`Download ${url}`)
    // A stalled download must not hang the release job until the workflow's hard timeout.
    let bytes: Buffer
    try {
      const res = await (options.fetchImpl ?? fetch)(url, {
        signal: AbortSignal.timeout(5 * 60_000)
      })
      if (!res.ok) throw new CiError('E_OBFUSCAR', `Obfuscar download failed: ${res.status} ${url}`)
      bytes = Buffer.from(await res.arrayBuffer())
    } catch (err) {
      if (
        err instanceof DOMException &&
        (err.name === 'TimeoutError' || err.name === 'AbortError')
      ) {
        throw new CiError('E_OBFUSCAR', `Obfuscar download timed out after 5 minutes: ${url}`)
      }
      throw err
    }
    const actual = createHash('sha256').update(bytes).digest('hex')
    if (actual !== expected) {
      throw new CiError(
        'E_OBFUSCAR',
        `Obfuscar ${version} sha256 mismatch: expected ${expected}, got ${actual} (${url})`
      )
    }
    await mkdir(dir, { recursive: true })
    const nupkgPart = `${nupkg}.${process.pid}.part`
    try {
      await writeFile(nupkgPart, bytes)
      await rename(nupkgPart, nupkg)
    } catch (err) {
      await rm(nupkgPart, { force: true })
      throw err
    }
  }

  // Always derive the exe from the verified nupkg (write-then-replace, cleaning a partial).
  const part = `${exe}.${process.pid}.part`
  try {
    await extractZipEntry(nupkg, OBFUSCAR_ENTRY, part)
    // Harmless on Windows; lets the file be read as a tool on POSIX runners.
    await chmod(part, 0o755).catch(() => undefined)
    await rm(exe, { force: true })
    await rename(part, exe)
  } catch (err) {
    await rm(part, { force: true })
    throw err
  }
  return exe
}
