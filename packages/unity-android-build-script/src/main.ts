import * as core from '@actions/core'
import path from 'node:path'
import {
  InputError,
  input,
  readInputs,
  removeWrittenKeystore,
  type ResolvedKeystore
} from '../../sdk/src/index.js'
import { setupKeystore, type KeystoreSetup } from './keystore.js'
import { applyPatch, keysDirIn, removeStale, restorePatch, stateFileIn, workDir } from './patch.js'
import { EXECUTE_METHOD, type BuildScriptOptions } from './script.js'
import { parseReleaseVersion, parseVersionCode } from './version.js'

const choice =
  <T extends string>(...values: T[]) =>
  (raw: string): T => {
    const value = raw.trim().toLowerCase()
    if (!(values as string[]).includes(value))
      throw new Error(`must be one of ${values.join(', ')}`)
    return value as T
  }

export async function run(): Promise<void> {
  const cfg = readInputs({
    mode: input.string({ default: 'apply' }),
    projectPath: input.string({ name: 'project-path', default: '.' }),
    format: input.string({ default: 'aab' }),
    output: input.string(),
    version: input.string(),
    versionCode: input.string({ name: 'version-code' }),
    development: input.boolean({ default: false }),
    signing: input.string({ default: 'release' }),
    keystoreBase64: input.string({ name: 'keystore-base64', secret: true }),
    keystorePassword: input.string({ name: 'keystore-password', secret: true }),
    keystoreAlias: input.string({ name: 'keystore-alias', secret: true }),
    keystoreAliasPassword: input.string({ name: 'keystore-alias-password', secret: true }),
    generateKeystore: input.boolean({ name: 'generate-keystore', default: false }),
    commitKeystore: input.boolean({ name: 'commit-keystore', default: true }),
    keystoreName: input.string({ name: 'keystore-name' }),
    githubToken: input.string({ name: 'github-token', secret: true }),
    editorPath: input.string({ name: 'editor-path' })
  })
  const issues: { input: string; message: string }[] = []
  const pick = <T>(name: string, raw: string, parse: (raw: string) => T): T | undefined => {
    try {
      return parse(raw)
    } catch (err) {
      issues.push({ input: name, message: err instanceof Error ? err.message : String(err) })
      return undefined
    }
  }
  const mode = pick('mode', cfg.mode, choice('apply', 'restore'))
  const format = pick('format', cfg.format, choice('aab', 'apk'))
  const signing = pick('signing', cfg.signing, choice('release', 'debug'))
  if (issues.length > 0) throw new InputError(issues)

  const projectRoot = path.resolve(cfg.projectPath)
  const dir = workDir()
  const stateFile = stateFileIn(dir)

  if (mode === 'restore') {
    if (await restorePatch(stateFile)) {
      core.info('Restored the project and removed the build script and any written keystore')
    } else {
      const removed = await removeStale(projectRoot, keysDirIn(dir))
      if (removed.length > 0) core.info(`Removed leftovers of a killed job: ${removed.join(', ')}`)
      else core.notice('Nothing to restore')
    }
    return
  }

  // Validate everything before touching the project or Unity.
  const version = cfg.version ? parseReleaseVersion(cfg.version) : undefined
  const versionCode = cfg.versionCode ? parseVersionCode(cfg.versionCode) : version?.code
  const output = cfg.output || `Builds/release.${format}`

  // A state left by a job that never restored (self-hosted runner) must not become the original.
  if (await restorePatch(stateFile)) core.info('Restored the state left by an earlier job')

  if (signing === 'debug' && !cfg.development) {
    core.warning(
      `signing: debug on a non-development build: the ${format!.toUpperCase()} is signed with the debug key and cannot go to a store`
    )
  }

  let keystore: ResolvedKeystore | undefined
  let setup: KeystoreSetup | undefined
  if (signing === 'release') {
    const repository = process.env['GITHUB_REPOSITORY'] || undefined
    setup = await setupKeystore({
      projectRoot,
      tempDir: keysDirIn(dir),
      inputs: {
        base64: cfg.keystoreBase64,
        password: cfg.keystorePassword,
        alias: cfg.keystoreAlias,
        aliasPassword: cfg.keystoreAliasPassword
      },
      // The convention: <repository name>.keystore.
      name: cfg.keystoreName || repository?.split('/')[1] || path.basename(projectRoot),
      generate: cfg.generateKeystore,
      commit: cfg.commitKeystore,
      token: cfg.githubToken || undefined,
      repository,
      editorPath: cfg.editorPath ? path.resolve(cfg.editorPath) : undefined
    })
    keystore = setup.keystore
    if (keystore.verification === 'unverified') {
      core.warning(
        `${path.basename(keystore.path)} cannot be checked before the build (JKS or a legacy algorithm): a wrong password or alias only shows in the Unity build`
      )
    }
  }
  // Set now: a generated keystore must be kept even when a later step of this action fails.
  core.setOutput('keystore-path', keystore?.path ?? '')
  core.setOutput('keystore-source', setup?.origin ?? '')
  core.setOutput(
    'keystore-committed',
    setup?.committed === undefined ? '' : String(setup.committed)
  )
  core.setOutput('keystore-commit-url', setup?.commitUrl ?? '')
  core.setOutput('keystore-repo-path', setup?.repoPath ?? '')

  // Values from secrets are not written into the script: Unity reads them from the environment.
  const fromSecret = keystore?.source === 'explicit'
  const script: BuildScriptOptions = {
    format: format!,
    output,
    versionName: version?.name ?? '',
    versionCode: versionCode ?? 0,
    development: cfg.development,
    releaseSigning: signing === 'release',
    keystore: keystore
      ? {
          path: keystore.projectRelativePath ?? keystore.path,
          password: fromSecret ? null : keystore.password,
          alias: fromSecret ? null : keystore.alias,
          aliasPassword: fromSecret ? null : keystore.aliasPassword
        }
      : { path: null, password: null, alias: null, aliasPassword: null }
  }

  let patched: string[]
  try {
    patched = await applyPatch({
      projectRoot,
      stateFile,
      script,
      writtenKeystore: keystore?.written ? keystore.path : undefined
    })
  } catch (err) {
    if (keystore) await removeWrittenKeystore(keystore)
    throw err
  }

  const outputPath = path.resolve(projectRoot, output)
  core.info(
    [
      `Build script ready: -executeMethod ${EXECUTE_METHOD}`,
      `  ${format!.toUpperCase()} -> ${outputPath}${cfg.development ? ' (development)' : ''}`,
      `  version ${version?.name ?? '(project)'} (${versionCode ?? 'project code'})`,
      keystore
        ? `  signed with ${keystore.source === 'explicit' ? 'the keystore inputs' : `${keystore.projectRelativePath ?? keystore.path} (${setup?.origin}, alias ${keystore.alias})`}`
        : '  signed with the Unity debug key'
    ].join('\n')
  )
  core.setOutput('execute-method', EXECUTE_METHOD)
  core.setOutput('output', outputPath)
  core.setOutput('version-name', version?.name ?? '')
  core.setOutput('version-code', versionCode === undefined ? '' : String(versionCode))
  core.setOutput('patched', patched.join('\n'))
}
