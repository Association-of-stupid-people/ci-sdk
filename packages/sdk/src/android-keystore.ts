import { createSecureContext } from 'node:tls'
import { randomUUID } from 'node:crypto'
import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { CiError, InputError, errorMessage, type InputIssue } from './errors.js'
import { exec } from './exec.js'

/**
 * Android signing keystore for a Unity project, resolved in this order:
 *
 * 1. **Explicit** (usually GitHub secrets): `base64` (or `path`), `password`, `alias` and
 *    `aliasPassword`. An empty value means "not set"; setting only some of them fails and names
 *    the missing ones (sources are never mixed).
 * 2. **Project default**: `AndroidKeystoreName` / `AndroidKeyaliasName` from
 *    `ProjectSettings/ProjectSettings.asset` (`{inproject}: file` is relative to the project), when
 *    that file exists.
 * 3. **A keystore at the project root** (`*.keystore` / `*.jks` next to `Assets`), else one committed
 *    anywhere in the project (`git ls-files`, Android `debug.keystore` files excluded): the only one,
 *    or `<preferredName>.keystore` among several. Its alias is ProjectSettings' when ProjectSettings
 *    names the same file name, else the convention.
 * 4. Otherwise it fails with code `E_NO_KEYSTORE` (`generateKeystore` can then make one; the caller
 *    must keep it, e.g. commit it: a key that is not kept breaks store updates).
 *
 * For 2 and 3, store password = key password = the keystore file name without its extension, and
 * the conventional alias is that name in lower case (`BGPZ-005-Gem.keystore`, password
 * `BGPZ-005-Gem`, alias `bgpz-005-gem`).
 */
export interface KeystoreInputs {
  /** The keystore file, base64 (e.g. the KEYSTORE_BASE64 secret). */
  base64?: string | undefined
  /** An existing keystore file (absolute, or relative to the project), instead of `base64`. */
  path?: string | undefined
  password?: string | undefined
  alias?: string | undefined
  aliasPassword?: string | undefined
}

export interface ResolvedKeystore {
  /** `project-file`: found at the project root, not through ProjectSettings. */
  source: 'explicit' | 'project-settings' | 'project-file'
  /** Absolute path of the keystore file. */
  path: string
  /** Path relative to the project when the file is inside it (forward slashes). */
  projectRelativePath: string | undefined
  password: string
  alias: string
  aliasPassword: string
  /** A file written from `base64`: delete it when done (`removeWrittenKeystore`). */
  written: boolean
  /** `unverified` when the format cannot be checked here (JKS); the build will tell. */
  verification: 'ok' | 'unverified'
}

export interface ResolveKeystoreOptions {
  projectPath: string
  inputs: KeystoreInputs
  /** Where a keystore given as base64 is written (e.g. `$RUNNER_TEMP/<action>`). */
  tempDir: string
  /** Input names for messages, e.g. `{ base64: 'keystore-base64' }`. */
  names?: Partial<Record<keyof KeystoreInputs, string>>
  /** `<preferredName>.keystore` wins when the project root holds several keystores (e.g. the repository name). */
  preferredName?: string | undefined
}

const DEFAULT_NAMES: Record<keyof KeystoreInputs, string> = {
  base64: 'keystore-base64',
  path: 'keystore-path',
  password: 'keystore-password',
  alias: 'keystore-alias',
  aliasPassword: 'keystore-alias-password'
}

/** The conventional secret behind each input, for messages. */
const SECRET_NAMES: Partial<Record<keyof KeystoreInputs, string>> = {
  base64: 'KEYSTORE_BASE64',
  password: 'KEYSTORE_PASSWORD',
  alias: 'KEYSTORE_ALIAS',
  aliasPassword: 'KEYSTORE_ALIAS_PASSWORD'
}

const CONVENTION =
  'Convention: commit <name>.keystore (PKCS12) at the project root (optionally named in Player Settings > ' +
  'Publishing Settings: ProjectSettings.asset AndroidKeystoreName / AndroidKeyaliasName), store and key ' +
  'password = <name>, alias = <name> in lower case; ' +
  'or set all of KEYSTORE_BASE64, KEYSTORE_PASSWORD, KEYSTORE_ALIAS, KEYSTORE_ALIAS_PASSWORD.'

/** A keystore file name that is safe as a password, an alias and a path: `BGPZ-005-Gem`. */
const KEYSTORE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/

/** Unquote a YAML scalar as Unity writes it (`'a ''b'''`, `"a"`, or plain). */
function yamlScalar(raw: string): string {
  const value = raw.trim()
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    return value.slice(1, -1).replaceAll("''", "'")
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2)
    return value.slice(1, -1).replaceAll('\\"', '"').replaceAll('\\\\', '\\')
  return value
}

/** `AndroidKeystoreName` and `AndroidKeyaliasName` of a ProjectSettings.asset text. */
export function readProjectKeystoreSettings(text: string): { name: string; alias: string } {
  const field = (key: string): string => {
    const m = new RegExp(`^[ \\t]*${key}:[ \\t]*(.*?)[ \\t]*\\r?$`, 'm').exec(text)
    return m ? yamlScalar(m[1]!) : ''
  }
  return { name: field('AndroidKeystoreName'), alias: field('AndroidKeyaliasName') }
}

/** Unity's keystore name: `{inproject}: rel/path` is relative to the project, else a plain path. */
export function resolveProjectKeystorePath(projectPath: string, name: string): string {
  const m = /^\{inproject\}:\s*(.*)$/.exec(name)
  return path.resolve(projectPath, m ? m[1]! : name)
}

/** The basename without its extension: the conventional password. */
export function conventionalPassword(keystorePath: string): string {
  const base = path.basename(keystorePath)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}

/** The conventional alias: the conventional password in lower case. */
export function conventionalAlias(keystorePath: string): string {
  return conventionalPassword(keystorePath).toLowerCase()
}

/**
 * Keystores committed anywhere under the project (git; `.keystore` / `.jks` in any case), except
 * Android debug keystores. Undefined when git cannot list them (not a checkout, or git failed).
 */
async function trackedKeystores(projectPath: string): Promise<string[] | undefined> {
  const pathspecs = [':(icase)*.keystore', ':(icase)*.jks']
  const res = await exec('git', ['ls-files', '-z', '--', ...pathspecs], {
    cwd: projectPath,
    silent: true,
    allowFailure: true
  }).catch(() => undefined)
  if (res?.exitCode !== 0) return undefined
  const present: string[] = []
  for (const rel of res.stdout.split('\0').filter(Boolean)) {
    const file = path.resolve(projectPath, rel)
    if (path.basename(file).toLowerCase() !== 'debug.keystore' && (await readable(file))) {
      present.push(file)
    }
  }
  return present.sort()
}

/** `*.keystore` and `*.jks` files directly in the project folder (no `debug.keystore`), sorted. */
async function rootKeystores(projectPath: string): Promise<string[]> {
  try {
    const entries = await readdir(projectPath, { withFileTypes: true })
    return entries
      .filter(
        e =>
          e.isFile() &&
          /\.(keystore|jks)$/i.test(e.name) &&
          e.name.toLowerCase() !== 'debug.keystore'
      )
      .map(e => path.join(projectPath, e.name))
      .sort()
  } catch {
    return []
  }
}

/**
 * Check that `bytes` is a keystore that `password` opens. PKCS12 is checked here (OpenSSL); JKS
 * cannot be, so it is `unverified`. Throws a CiError for a wrong password or a non-keystore file.
 */
export function verifyKeystore(
  bytes: Buffer,
  password: string,
  label: string
): 'ok' | 'unverified' {
  if (bytes.length >= 4 && bytes.readUInt32BE(0) === 0xfeedfeed) return 'unverified'
  if (bytes.length === 0 || bytes[0] !== 0x30) {
    throw new CiError('E_KEYSTORE', `${label} is not a keystore (neither PKCS12 nor JKS)`)
  }
  try {
    createSecureContext({ pfx: bytes, passphrase: password })
    return 'ok'
  } catch (err) {
    const message = errorMessage(err)
    // Old keystores may use algorithms OpenSSL 3 only has in its legacy provider: not a verdict.
    if (/unsupported/i.test(message)) return 'unverified'
    if (/mac verify failure|bad decrypt/i.test(message)) {
      throw new CiError('E_KEYSTORE', `${label}: wrong store password`)
    }
    throw new CiError('E_KEYSTORE', `${label} cannot be opened: ${message}`)
  }
}

async function readable(file: string): Promise<boolean> {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

function relativeInside(projectPath: string, file: string): string | undefined {
  const rel = path.relative(projectPath, file)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined
  return rel.split(path.sep).join('/')
}

/** Resolve (and for `base64`, write) the keystore. See {@link KeystoreInputs} for the order. */
export async function resolveKeystore(options: ResolveKeystoreOptions): Promise<ResolvedKeystore> {
  const projectPath = path.resolve(options.projectPath)
  const names = { ...DEFAULT_NAMES, ...options.names }
  const set = (v: string | undefined): v is string => v !== undefined && v !== ''
  const { inputs } = options

  const explicit = (['base64', 'path', 'password', 'alias', 'aliasPassword'] as const).some(k =>
    set(inputs[k])
  )
  if (explicit) {
    const issues: InputIssue[] = []
    const need = (key: keyof KeystoreInputs): void => {
      if (set(inputs[key])) return
      const secret = SECRET_NAMES[key]
      issues.push({ input: names[key], message: `is empty${secret ? ` (secret ${secret})` : ''}` })
    }
    if (set(inputs.base64) && set(inputs.path)) {
      issues.push({ input: names.path, message: `cannot be set together with ${names.base64}` })
    } else if (!set(inputs.path)) {
      need('base64')
    }
    need('password')
    need('alias')
    need('aliasPassword')
    if (issues.length > 0) {
      issues.push({
        input: names.base64,
        message:
          'the keystore inputs must be set all together, or all left empty to use the project keystore'
      })
      throw new InputError(issues)
    }

    let file: string
    let written = false
    let bytes: Buffer
    if (set(inputs.base64)) {
      bytes = Buffer.from(inputs.base64.replace(/\s+/g, ''), 'base64')
      if (bytes.length === 0) throw new CiError('E_KEYSTORE', `${names.base64} is not base64`)
      await mkdir(options.tempDir, { recursive: true })
      file = path.join(options.tempDir, `${randomUUID()}.keystore`)
      await writeFile(file, bytes, { mode: 0o600 })
      written = true
    } else {
      file = path.resolve(projectPath, inputs.path!)
      if (!(await readable(file))) {
        throw new CiError('E_KEYSTORE', `${names.path} does not exist: ${file}`)
      }
      bytes = await readFile(file)
    }
    let verification: 'ok' | 'unverified'
    try {
      verification = verifyKeystore(bytes, inputs.password!, `keystore (${names.base64})`)
    } catch (err) {
      if (written) await rm(file, { force: true })
      throw err
    }
    return {
      source: 'explicit',
      path: file,
      projectRelativePath: written ? undefined : relativeInside(projectPath, file),
      password: inputs.password!,
      alias: inputs.alias!,
      aliasPassword: inputs.aliasPassword!,
      written,
      verification
    }
  }

  const settingsFile = path.join(projectPath, 'ProjectSettings', 'ProjectSettings.asset')
  let settings = { name: '', alias: '' }
  let why: string
  try {
    settings = readProjectKeystoreSettings(await readFile(settingsFile, 'utf8'))
    why = 'ProjectSettings.asset has no AndroidKeystoreName'
  } catch {
    why = `${settingsFile} cannot be read`
  }
  const referenced = settings.name
    ? resolveProjectKeystorePath(projectPath, settings.name)
    : undefined
  const sameFile = (a: string, b: string): boolean =>
    path.basename(a).toLowerCase() === path.basename(b).toLowerCase()

  let file: string
  let source: 'project-settings' | 'project-file'
  if (referenced && (await readable(referenced))) {
    file = referenced
    source = 'project-settings'
  } else {
    if (referenced) {
      why = `ProjectSettings.asset points to ${referenced}, which does not exist (is it committed? *.keystore is often gitignored)`
    }
    // At the root first (that includes one generated and not yet committed), else committed deeper.
    const atRoot = await rootKeystores(projectPath)
    const tracked = atRoot.length > 0 ? [] : await trackedKeystores(projectPath)
    const found = atRoot.length > 0 ? atRoot : (tracked ?? [])
    const preferred = options.preferredName?.toLowerCase()
    const pick =
      found.length === 1
        ? found[0]
        : found.find(f => conventionalPassword(f).toLowerCase() === preferred)
    if (!pick && found.length > 1) {
      const names = found.map(f => relativeInside(projectPath, f) ?? f).join(', ')
      throw new CiError(
        'E_KEYSTORE',
        `Several keystores ${atRoot.length > 0 ? 'at the project root' : 'committed in the project'} (${names}): name one in ProjectSettings.asset (AndroidKeystoreName)${options.preferredName ? ` or call it ${options.preferredName}.keystore` : ''}`
      )
    }
    if (!pick) {
      throw new CiError(
        'E_NO_KEYSTORE',
        `No keystore: ${why}, and the project has no *.keystore or *.jks at its root${tracked ? ' or committed' : ' (git could not list the committed files)'}. ${CONVENTION}`
      )
    }
    file = pick
    source = 'project-file'
  }
  const password = conventionalPassword(file)
  const verification = verifyKeystore(
    await readFile(file),
    password,
    `${path.basename(file)} (password = its name, "${password}")`
  )
  // ProjectSettings' alias belongs to the file it names; any other file has the conventional alias.
  const alias =
    (referenced && sameFile(referenced, file) && settings.alias) || conventionalAlias(file)
  return {
    source,
    path: file,
    projectRelativePath: relativeInside(projectPath, file),
    password,
    alias,
    aliasPassword: password,
    written: false,
    verification
  }
}

export interface GenerateKeystoreOptions {
  /** The keytool executable (e.g. next to the java of Unity's OpenJDK). */
  keytool: string
  /** The folder for `<name>.keystore` (the project root). */
  dir: string
  /** The file name without extension; also the store and key password, and in lower case the alias. */
  name: string
  /** Distinguished name of the certificate. Default `CN=<name>`. */
  dname?: string | undefined
  /** Default `name` in lower case. Give ProjectSettings' alias when it names this file, so the build agrees. */
  alias?: string | undefined
}

/**
 * Generate `<dir>/<name>.keystore` by the convention: PKCS12, RSA 2048, valid 10000 days (Google Play
 * needs a key valid past 2033), store and key password = `name`, alias = `name` in lower case. Never
 * overwrites a file. The caller must keep the file (commit it): every later build has to sign with it.
 * @returns the path of the new keystore.
 */
export async function generateKeystore(options: GenerateKeystoreOptions): Promise<string> {
  if (!KEYSTORE_NAME.test(options.name)) {
    throw new CiError(
      'E_KEYSTORE',
      `"${options.name}" cannot be a keystore name: use letters, digits, ".", "_" and "-"`
    )
  }
  const file = path.join(options.dir, `${options.name}.keystore`)
  if (await readable(file)) {
    throw new CiError('E_KEYSTORE', `${file} already exists: it is never overwritten`)
  }
  await mkdir(options.dir, { recursive: true })
  // The password goes through the environment, not the command line.
  const env = 'CI_SDK_KEYSTORE_PASSWORD'
  // prettier-ignore
  await exec(options.keytool, [
    '-genkeypair', '-noprompt', '-storetype', 'PKCS12', '-keystore', file,
    '-alias', options.alias || conventionalAlias(file), '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000',
    '-dname', options.dname ?? `CN=${options.name}`,
    '-storepass:env', env, '-keypass:env', env
  ], { env: { [env]: options.name } })
  return file
}

/** Delete a keystore that `resolveKeystore` wrote from base64 (no-op otherwise). */
export async function removeWrittenKeystore(keystore: ResolvedKeystore): Promise<void> {
  if (keystore.written) await rm(keystore.path, { force: true, maxRetries: 5, retryDelay: 200 })
}
