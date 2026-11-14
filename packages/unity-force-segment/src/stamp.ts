import { existsSync, readdirSync } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CiError, appendStoredZipEntry, exec, storedEntryOffsets } from '../../sdk/src/index.js'
import { SEGMENT_ENTRY, segmentFileText } from './runtime.js'
import type { Segment } from './segment.js'

/** Unity's debug keystore (what a Unity build without a custom keystore signs with). */
export interface Keystore {
  file: string
  password: string
  alias: string
  keyPassword: string
}

/**
 * The debug keystore where the Android tools keep it: ANDROID_USER_HOME, else
 * ANDROID_SDK_HOME/.android, else ~/.android (the first that has one; else the last).
 */
export function defaultDebugKeystore(
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
  exists: (file: string) => boolean = existsSync
): Keystore {
  const candidates = [
    env['ANDROID_USER_HOME'] ? path.join(env['ANDROID_USER_HOME'], 'debug.keystore') : undefined,
    env['ANDROID_PREFS_ROOT']
      ? path.join(env['ANDROID_PREFS_ROOT'], '.android', 'debug.keystore')
      : undefined,
    env['ANDROID_SDK_HOME']
      ? path.join(env['ANDROID_SDK_HOME'], '.android', 'debug.keystore')
      : undefined,
    path.join(home, '.android', 'debug.keystore')
  ].filter((f): f is string => !!f)
  return {
    file: candidates.find(f => exists(f)) ?? candidates[candidates.length - 1]!,
    password: 'android',
    alias: 'androiddebugkey',
    keyPassword: 'android'
  }
}

export interface SdkLookup {
  /** The `android-sdk` input. */
  androidSdk: string | undefined
  env: NodeJS.ProcessEnv
  /** Unity editor executable (unity-build `editor-path`), for the SDK of its Android module. */
  editorPath: string | undefined
  platform: NodeJS.Platform
  exists: (file: string) => boolean
  list: (dir: string) => string[]
}

/** The Android SDK of the Unity editor's Android module (same layout as its OpenJDK). */
export function unitySdk(editorPath: string, platform: NodeJS.Platform): string {
  const p = platform === 'win32' ? path.win32 : path.posix
  const dir = p.dirname(editorPath)
  const engines =
    platform === 'darwin'
      ? p.join(p.dirname(dir), 'PlaybackEngines')
      : p.join(dir, 'Data', 'PlaybackEngines')
  return p.join(engines, 'AndroidPlayer', 'SDK')
}

const MIN_BUILD_TOOLS = 30
const versionKey = (name: string): number[] => name.split(/[.-]/).map(n => Number(n) || 0)
const newerFirst = (a: string, b: string): number => {
  const x = versionKey(a)
  const y = versionKey(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (y[i] ?? 0) - (x[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/**
 * apksigner.jar of the newest build-tools found under the `android-sdk` input, ANDROID_HOME,
 * ANDROID_SDK_ROOT and the Unity editor's Android SDK (the earlier root wins a tie). Build-tools
 * older than 30 are skipped: their apksigner lacks options the stamp passes.
 */
export function findApksigner(lookup: SdkLookup): string {
  const p = lookup.platform === 'win32' ? path.win32 : path.posix
  const roots = [
    lookup.androidSdk,
    lookup.env['ANDROID_HOME'],
    lookup.env['ANDROID_SDK_ROOT'],
    lookup.editorPath ? unitySdk(lookup.editorPath, lookup.platform) : undefined
  ].filter((r): r is string => !!r)
  const found: { version: string; jar: string }[] = []
  for (const root of roots) {
    const tools = p.join(root, 'build-tools')
    let versions: string[]
    try {
      versions = lookup.list(tools)
    } catch {
      continue
    }
    for (const version of versions) {
      if ((versionKey(version)[0] ?? 0) < MIN_BUILD_TOOLS) continue
      const jar = p.join(tools, version, 'lib', 'apksigner.jar')
      if (lookup.exists(jar)) found.push({ version, jar })
    }
  }
  // Stable sort: equal versions keep the root order.
  const best = found.sort((a, b) => newerFirst(a.version, b.version))[0]
  if (best) return best.jar
  throw new CiError(
    'E_APKSIGNER',
    `apksigner.jar (build-tools ${MIN_BUILD_TOOLS}+) not found under build-tools of ${roots.join(', ') || '(no Android SDK: set android-sdk or editor-path)'}`
  )
}

export function defaultSdkLookup(
  androidSdk: string | undefined,
  editorPath: string | undefined
): SdkLookup {
  return {
    androidSdk,
    env: process.env,
    editorPath,
    platform: process.platform,
    exists: existsSync,
    list: dir => readdirSync(dir)
  }
}

/** SHA-256 digests of the signer certificates (`apksigner verify --print-certs`). */
export function signerDigests(output: string): string[] {
  return [...output.matchAll(/Signer #\d+ certificate SHA-256 digest:\s*([0-9a-fA-F]+)/g)].map(m =>
    m[1]!.toLowerCase()
  )
}

export interface StampOptions {
  /** The normal debug APK (built with the runtime patch). */
  base: string
  output: string
  segment: Segment
  java: string
  apksigner: string
  keystore: Keystore
}

export interface StampResult {
  size: number
  /** Signer certificate digests of the segment APK (the same as the base APK's). */
  signers: string[]
}

async function verifyCerts(java: string, apksigner: string, apk: string): Promise<string[]> {
  const result = await exec(java, ['-jar', apksigner, 'verify', '--print-certs', apk], {
    silent: true,
    allowFailure: true
  })
  if (result.exitCode !== 0) {
    throw new CiError(
      'E_APKSIGNER',
      `apksigner verify failed for ${apk}: ${(result.stderr || result.stdout).trim().slice(0, 500)}`
    )
  }
  return signerDigests(result.stdout)
}

/**
 * The segment APK: a copy of the base APK with the segment file (SEGMENT_ENTRY), signed again with
 * the keystore. Fails when the keystore is not the one that signed the base APK: the segment APK
 * would then not install over the normal one.
 */
export async function stampApk(options: StampOptions): Promise<StampResult> {
  const { base, output, java, apksigner, keystore } = options
  if (!existsSync(base)) throw new CiError('E_STAMP', `Base APK not found: ${base}`)
  if (!existsSync(keystore.file)) {
    throw new CiError('E_STAMP', `Keystore not found: ${keystore.file}`)
  }
  await mkdir(path.dirname(path.resolve(output)), { recursive: true })
  const unsigned = `${output}.unsigned`
  // Signed here, renamed to output only once every check passed: a failed stamp leaves no APK behind.
  const signedApk = `${output}.signed`
  await rm(output, { force: true })
  try {
    await appendStoredZipEntry(
      base,
      unsigned,
      SEGMENT_ENTRY,
      Buffer.from(segmentFileText(options.segment), 'utf8')
    )
    // Passwords through the environment, never on the command line.
    const signed = await exec(
      java,
      [
        '-jar',
        apksigner,
        'sign',
        '--ks',
        keystore.file,
        '--ks-pass',
        'env:CI_SDK_KS_PASS',
        '--ks-key-alias',
        keystore.alias,
        '--key-pass',
        'env:CI_SDK_KEY_PASS',
        // No <apk>.idsig next to the APK (v4, for incremental adb installs only).
        '--v4-signing-enabled',
        'false',
        '--out',
        signedApk,
        unsigned
      ],
      {
        silent: true,
        allowFailure: true,
        env: { CI_SDK_KS_PASS: keystore.password, CI_SDK_KEY_PASS: keystore.keyPassword }
      }
    )
    if (signed.exitCode !== 0) {
      throw new CiError(
        'E_APKSIGNER',
        `apksigner sign failed: ${(signed.stderr || signed.stdout).trim().slice(0, 500)}`
      )
    }
    await rm(unsigned, { force: true })

    // Native libraries are stored page aligned (16 KB since Android 15): the new signature must not
    // move them off it, or 16 KB-page devices refuse the APK.
    const before = await storedEntryOffsets(base)
    const after = await storedEntryOffsets(signedApk)
    for (const [name, offset] of before) {
      if (!name.endsWith('.so')) continue
      for (const page of [16384, 4096]) {
        if (offset % page === 0 && (after.get(name) ?? 1) % page !== 0) {
          throw new CiError(
            'E_STAMP',
            `${name} lost its ${page / 1024} KB alignment in the signed segment APK (apksigner ${apksigner})`
          )
        }
      }
    }

    const [baseSigners, signers] = [
      await verifyCerts(java, apksigner, base),
      await verifyCerts(java, apksigner, signedApk)
    ]
    if (signers.length === 0 || signers.join() !== baseSigners.join()) {
      throw new CiError(
        'E_STAMP',
        `${keystore.file} did not sign ${base} (base ${baseSigners.join(', ') || 'unsigned'}, keystore ${signers.join(', ') || 'none'}): the segment APK would not install over the normal one`
      )
    }
    await rename(signedApk, output)
    return { size: (await stat(output)).size, signers }
  } catch (err) {
    await rm(output, { force: true })
    throw err
  } finally {
    await rm(unsigned, { force: true })
    await rm(signedApk, { force: true })
  }
}
