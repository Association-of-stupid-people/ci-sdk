import * as core from '@actions/core'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  CiError,
  InputError,
  exec,
  getCiContext,
  input,
  readInputs,
  removeWrittenKeystore,
  resolveKeystore,
  type ResolvedKeystore
} from '../../sdk/src/index.js'
import { PINNED_BUNDLETOOL, ensureBundletool } from './bundletool.js'
import { findJava } from './java.js'
import { extractZipEntry, listZip } from './zip.js'

export interface Signing {
  path: string
  alias: string
  password: string
  aliasPassword: string
}

export interface ConvertOptions {
  aab: string
  output: string
  java: string
  jar: string
  /** Omitted: bundletool signs with ~/.android/debug.keystore if it exists. */
  signing?: Signing
  /** Scratch dir for the .apks and the password files; removed afterwards. */
  workDir: string
  timeout: number | string
  exec?: typeof exec
}

/** The bundletool command line; passwords are referenced as files, never put in argv. */
export function bundletoolArgs(
  o: Pick<ConvertOptions, 'aab' | 'jar'>,
  apks: string,
  passFiles?: { alias: string; ks: string; storePass: string; keyPass: string }
): string[] {
  const args = [
    '-jar',
    o.jar,
    'build-apks',
    `--bundle=${o.aab}`,
    `--output=${apks}`,
    '--mode=universal',
    '--overwrite'
  ]
  if (passFiles) {
    args.push(
      `--ks=${passFiles.ks}`,
      `--ks-key-alias=${passFiles.alias}`,
      `--ks-pass=file:${passFiles.storePass}`,
      `--key-pass=file:${passFiles.keyPass}`
    )
  }
  return args
}

/** bundletool build-apks --mode=universal, then universal.apk out of the .apks. */
export async function convert(o: ConvertOptions): Promise<{ apk: string; size: number }> {
  const run = o.exec ?? exec
  const work = path.join(o.workDir, randomUUID())
  await mkdir(work, { recursive: true, mode: 0o700 })
  try {
    const apks = path.join(work, 'universal.apks')
    let passFiles: Parameters<typeof bundletoolArgs>[2]
    if (o.signing) {
      const storePass = path.join(work, 'ks.pass')
      const keyPass = path.join(work, 'key.pass')
      await writeFile(storePass, o.signing.password, { mode: 0o600 })
      await writeFile(keyPass, o.signing.aliasPassword, { mode: 0o600 })
      passFiles = { alias: o.signing.alias, ks: o.signing.path, storePass, keyPass }
    }
    await run(o.java, bundletoolArgs(o, apks, passFiles), { timeout: o.timeout })
    if (!existsSync(apks)) throw new CiError('E_BUNDLETOOL', `bundletool wrote no ${apks}`)
    const entries = await listZip(apks)
    if (!entries.includes('universal.apk')) {
      throw new CiError(
        'E_BUNDLETOOL',
        `${path.basename(apks)} has no universal.apk (entries: ${entries.join(', ')})`
      )
    }
    await mkdir(path.dirname(o.output), { recursive: true })
    const size = await extractZipEntry(apks, 'universal.apk', o.output)
    return { apk: o.output, size }
  } finally {
    // The folder holds the password files. Windows may hold a file for a moment (antivirus).
    await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
      (err: unknown) => {
        core.warning(
          `Could not delete ${work}: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    )
  }
}

/** `x.aab` -> `x.apk` next to it. */
export const defaultOutput = (aab: string): string =>
  path.join(path.dirname(aab), `${path.basename(aab, path.extname(aab))}.apk`)

/** The jar to use: the pinned release, or another version with its sha256. */
export function bundletoolRelease(
  version: string,
  sha256: string
): { version: string; sha256: string } {
  const v = version || PINNED_BUNDLETOOL.version
  if (sha256) {
    if (!/^[0-9a-f]{64}$/i.test(sha256)) {
      throw new InputError([{ input: 'bundletool-sha256', message: 'must be 64 hex characters' }])
    }
    return { version: v, sha256: sha256.toLowerCase() }
  }
  if (v === PINNED_BUNDLETOOL.version) return PINNED_BUNDLETOOL
  throw new InputError([
    {
      input: 'bundletool-sha256',
      message: `is required with bundletool-version ${v} (only ${PINNED_BUNDLETOOL.version} is pinned)`
    }
  ])
}

export async function run(): Promise<void> {
  const cfg = readInputs({
    aab: input.string({ required: true }),
    output: input.string(),
    projectPath: input.string({ name: 'project-path', default: '.' }),
    signing: input.string({ default: 'release' }),
    keystoreBase64: input.string({ name: 'keystore-base64', secret: true }),
    keystorePassword: input.string({ name: 'keystore-password', secret: true }),
    keystoreAlias: input.string({ name: 'keystore-alias', secret: true }),
    keystoreAliasPassword: input.string({ name: 'keystore-alias-password', secret: true }),
    keystoreName: input.string({ name: 'keystore-name' }),
    javaPath: input.string({ name: 'java-path' }),
    editorPath: input.string({ name: 'editor-path' }),
    bundletoolVersion: input.string({ name: 'bundletool-version' }),
    bundletoolSha256: input.string({ name: 'bundletool-sha256' }),
    timeout: input.duration({ default: '20m' })
  })
  const signing = cfg.signing.trim().toLowerCase()
  if (signing !== 'release' && signing !== 'debug') {
    throw new InputError([{ input: 'signing', message: 'must be one of release, debug' }])
  }
  const release = bundletoolRelease(cfg.bundletoolVersion ?? '', cfg.bundletoolSha256 ?? '')

  const aab = path.resolve(cfg.aab)
  const aabStat = await stat(aab).catch(() => undefined)
  if (!aabStat?.isFile()) throw new CiError('E_AAB', `No AAB at ${aab}`)
  const output = path.resolve(cfg.output || defaultOutput(aab))
  if (output === aab) throw new InputError([{ input: 'output', message: 'must not be the .aab' }])

  const ctx = getCiContext()
  const work = path.join(ctx.runner.temp ?? os.tmpdir(), 'ci-sdk-aab-to-apk')

  // Fail on the keystore before any download.
  let keystore: ResolvedKeystore | undefined
  if (signing === 'release') {
    keystore = await resolveKeystore({
      projectPath: path.resolve(cfg.projectPath),
      tempDir: path.join(work, 'keys'),
      inputs: {
        base64: cfg.keystoreBase64,
        password: cfg.keystorePassword,
        alias: cfg.keystoreAlias,
        aliasPassword: cfg.keystoreAliasPassword
      },
      // The same file the build used when the project root holds several (unity-android-build-script).
      preferredName:
        cfg.keystoreName || process.env['GITHUB_REPOSITORY']?.split('/')[1] || undefined
    })
  }
  try {
    const java = findJava({
      javaPath: cfg.javaPath || undefined,
      javaHome: process.env.JAVA_HOME,
      editorPath: cfg.editorPath || undefined,
      platform: process.platform,
      exists: existsSync
    })
    core.info(`java: ${java.path} (${java.source})`)
    const jar = await ensureBundletool({
      ...release,
      toolCache: ctx.runner.toolCache,
      log: core.info
    })
    core.info(
      keystore
        ? `Signing with ${keystore.source === 'explicit' ? 'the keystore inputs' : `${keystore.projectRelativePath ?? keystore.path} (${keystore.source}, alias ${keystore.alias})`}`
        : 'Signing with the bundletool debug key'
    )
    const { apk, size } = await convert({
      aab,
      output,
      java: java.path,
      jar,
      signing: keystore,
      workDir: work,
      timeout: cfg.timeout
    })
    core.info(`Universal APK: ${apk} (${(size / 1024 / 1024).toFixed(1)} MiB)`)
    core.setOutput('apk-path', apk)
    core.setOutput('size', String(size))
    core.setOutput('java', java.path)
    core.setOutput('bundletool', jar)
  } finally {
    // A keystore that cannot be deleted must not fail a step whose APK exists: RUNNER_TEMP is
    // emptied when the next job starts.
    if (keystore) {
      await removeWrittenKeystore(keystore).catch((err: unknown) => {
        core.warning(
          `Could not delete the keystore written from the secrets (${keystore.path}): ${err instanceof Error ? err.message : String(err)}`
        )
      })
    }
  }
}
