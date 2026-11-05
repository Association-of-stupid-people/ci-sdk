import * as core from '@actions/core'
import { createHash } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  CiError,
  GitHubApiError,
  GitHubClient,
  errorMessage,
  exec,
  generateKeystore,
  readProjectKeystoreSettings,
  resolveKeystore,
  resolveProjectKeystorePath,
  type GenerateKeystoreOptions,
  type KeystoreInputs,
  type ResolvedKeystore
} from '../../sdk/src/index.js'
import { unityJava } from '../../aab-to-apk/src/java.js'
import {
  currentHost,
  editorExecutable,
  editorRoots,
  findEditor,
  type HostEnv
} from '../../unity-build/src/locate.js'
import { parseProjectVersion } from '../../unity-build/src/version.js'

/** Where the release keystore came from (the `keystore-source` output). */
export type KeystoreOrigin =
  'explicit' | 'project-settings' | 'project-file' | 'default-branch' | 'generated'

export interface KeystoreSetup {
  keystore: ResolvedKeystore
  origin: KeystoreOrigin
  /**
   * Set when the keystore is not in this commit (generated, or found but not tracked by git): `true`
   * when it is on the default branch, `false` when it still has to be committed.
   */
  committed?: boolean
  commitUrl?: string
  /** Its path in the repository (`Game/My-Game.keystore`) when it is not in this commit. */
  repoPath?: string
}

export interface KeystoreSetupOptions {
  projectRoot: string
  /** Where a keystore given as base64 is written. */
  tempDir: string
  inputs: KeystoreInputs
  /** `<name>.keystore`: preferred among several, looked up on the default branch, or generated. */
  name: string
  /**
   * The default branch is the reference: a keystore this commit lacks is taken from it, an untracked
   * one is checked against it, and only when it has none is one generated. Needs git and the API.
   */
  generate: boolean
  /** Commit a keystore that is not on the default branch here. `false`: a later job commits it. */
  commit: boolean
  token: string | undefined
  /** `owner/repo`. */
  repository: string | undefined
  /** Unity editor executable, to find keytool. Default: located from ProjectVersion.txt. */
  editorPath: string | undefined
  /** Injectable for tests. */
  fetch?: typeof fetch
  generateKeystore?: (options: GenerateKeystoreOptions) => Promise<string>
  host?: HostEnv
  listDir?: (dir: string) => string[]
}

function listDirSync(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/**
 * keytool of Unity's OpenJDK (the JDK that builds the project), else `JAVA_HOME`, else the OpenJDK
 * of any other installed Unity editor (newest first), else PATH. The editor is `editorPath`, or the
 * one ProjectSettings/ProjectVersion.txt names, found like unity-build. Any of them makes the same
 * PKCS12 key.
 */
export function findKeytool(
  projectRoot: string,
  editorPath: string | undefined,
  host: HostEnv = currentHost(),
  listDir: (dir: string) => string[] = listDirSync
): string {
  const p = host.platform === 'win32' ? path.win32 : path.posix
  const exe = host.platform === 'win32' ? 'keytool.exe' : 'keytool'
  const keytoolOf = (editor: string): string =>
    p.join(p.dirname(unityJava(editor, host.platform)), exe)
  let editor = editorPath
  if (!editor) {
    const text = host.read(p.join(projectRoot, 'ProjectSettings', 'ProjectVersion.txt'))
    const version = text ? parseProjectVersion(text)?.version : undefined
    if (version) editor = findEditor(host, version)
  }
  if (editor && host.exists(keytoolOf(editor))) return keytoolOf(editor)
  const home = host.env['JAVA_HOME']
  if (home && host.exists(p.join(home, 'bin', exe))) return p.join(home, 'bin', exe)
  const newestFirst = (a: string, b: string): number => b.localeCompare(a, 'en', { numeric: true })
  for (const root of editorRoots(host)) {
    for (const version of listDir(root).sort(newestFirst)) {
      const keytool = keytoolOf(editorExecutable(p.join(root, version), host.platform))
      if (host.exists(keytool)) return keytool
    }
  }
  return 'keytool'
}

/** Git's blob id of `bytes`: what the trees API lists, so files compare without a download. */
export const blobSha = (bytes: Buffer): string =>
  createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')

/** A release keystore path (`*.keystore` / `*.jks`, any case), not an Android debug keystore. */
const isReleaseKeystore = (file: string): boolean => {
  const lower = file.toLowerCase()
  return (
    (lower.endsWith('.keystore') || lower.endsWith('.jks')) &&
    path.posix.basename(lower) !== 'debug.keystore'
  )
}

async function git(projectRoot: string, args: string[]): Promise<string | undefined> {
  const res = await exec('git', args, { cwd: projectRoot, silent: true, allowFailure: true }).catch(
    () => undefined
  )
  return res?.exitCode === 0 ? res.stdout : undefined
}

/** The project folder inside its git repository (`Game/`, or `` at the top), or undefined. */
async function gitPrefix(projectRoot: string): Promise<string | undefined> {
  return (await git(projectRoot, ['rev-parse', '--show-prefix']))?.replace(/\r?\n$/, '')
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

interface TreeEntry {
  path: string
  type: string
  sha: string
}

interface DefaultBranch {
  branch: string
  /** The project folder as the branch spells it (`Game/`, or ``): git may report the disk's case. */
  prefix: string
  /** Release keystores under the project folder (repository paths). */
  keys: TreeEntry[]
  /** Release keystores anywhere in the repository. */
  all: TreeEntry[]
  /** Every file of the branch: ProjectSettings may name a keystore of any name (`release.ks`). */
  files: TreeEntry[]
}

/** The default branch and every release keystore it has (one trees API call). */
async function defaultBranchKeystores(
  github: GitHubClient,
  repository: string,
  prefix: string
): Promise<DefaultBranch> {
  const { data: repo } = await github.request<{ default_branch: string }>(`/repos/${repository}`)
  const branch = repo.default_branch
  const { data } = await github.request<{ tree?: TreeEntry[]; truncated?: boolean }>(
    `/repos/${repository}/git/trees/${encodeURIComponent(branch)}`,
    { query: { recursive: '1' } }
  )
  if (data.truncated || !Array.isArray(data.tree)) {
    throw new CiError(
      'E_KEYSTORE',
      `The files of ${branch} cannot be listed in one API call (too many), so its keystores cannot be checked: commit the keystore to this project, or set the keystore secrets`
    )
  }
  const files = data.tree.filter(e => e.type === 'blob')
  const all = files.filter(e => isReleaseKeystore(e.path))
  // The folder as the branch spells it: exactly git's prefix when it is there, else in any case.
  const folders = data.tree.filter(e => e.type === 'tree')
  const exact = prefix === '' || folders.some(e => `${e.path}/` === prefix)
  const lower = prefix.toLowerCase()
  const folder = exact
    ? prefix
    : folders.find(e => `${e.path}/`.toLowerCase() === lower)?.path.concat('/')
  const keys = all.filter(e =>
    exact ? e.path.startsWith(prefix) : e.path.toLowerCase().startsWith(lower)
  )
  return { branch, prefix: folder ?? prefix, keys, all, files }
}

/**
 * The keystores of `branch` that belong to this game: the project folder's, and those at `paths`
 * (where the file would go, where ProjectSettings points). Another game's key is not one of them.
 */
function gameKeys(branch: DefaultBranch, ...paths: (string | undefined)[]): TreeEntry[] {
  const at = new Set(paths.filter((p): p is string => !!p).map(p => p.toLowerCase()))
  return [
    ...branch.keys,
    ...branch.files.filter(e => at.has(e.path.toLowerCase()) && !branch.keys.includes(e))
  ]
}

/**
 * Resolve the release keystore (`resolveKeystore`). With `generate`, the default branch is the
 * reference, so a game never gets a second key:
 * - a keystore committed in this commit (or given as secrets) is used as it is;
 * - one found but not tracked by git (left by an earlier run, or copied by hand) is used when the
 *   default branch has the same file or no keystore at all (then it still has to be committed); a
 *   different keystore there stops the step;
 * - none: the default branch's keystore (at the project root, or where ProjectSettings points),
 *   else a new one generated by the convention.
 *
 * A keystore that is not on the default branch is committed there with `commit`, else reported as
 * `committed: false` with its `repoPath` for a later job. A failed commit is a warning.
 */
export async function setupKeystore(o: KeystoreSetupOptions): Promise<KeystoreSetup> {
  const resolve = async (): Promise<ResolvedKeystore> =>
    resolveKeystore({
      projectPath: o.projectRoot,
      tempDir: o.tempDir,
      inputs: o.inputs,
      preferredName: o.name
    })
  let found: ResolvedKeystore | undefined
  try {
    found = await resolve()
  } catch (err) {
    if (!o.generate || !(err instanceof CiError) || err.code !== 'E_NO_KEYSTORE') throw err
  }
  if (found && (!o.generate || found.source === 'explicit')) {
    return { keystore: found, origin: found.source }
  }

  const prefix = await gitPrefix(o.projectRoot)
  const settingsFile = path.join(o.projectRoot, 'ProjectSettings', 'ProjectSettings.asset')
  /** `file` relative to the repository root (the disk's spelling), or undefined outside it. */
  const repoRelative = (file: string): string | undefined => {
    const rel = path.relative(o.projectRoot, file)
    if (prefix === undefined || path.isAbsolute(rel)) return undefined
    const joined = path.posix.normalize(`${prefix}${rel.split(path.sep).join('/')}`)
    return joined === '..' || joined.startsWith('../') ? undefined : joined
  }
  const settings = readProjectKeystoreSettings(await readFile(settingsFile, 'utf8').catch(() => ''))
  const namedRaw = settings.name.replace(/^\{inproject\}:\s*/, '')
  const namedAbsolute = namedRaw !== settings.name ? false : !!namedRaw && path.isAbsolute(namedRaw)
  let foundRepo: string | undefined
  if (found) {
    if (prefix === undefined) {
      // A keystore ProjectSettings names by an absolute path (kept on the runner): as it is.
      if (found.source === 'project-settings' && namedAbsolute && !found.projectRelativePath) {
        return { keystore: found, origin: found.source }
      }
      throw new CiError(
        'E_KEYSTORE',
        `${o.projectRoot} is not in a git checkout (or git failed), so it cannot be told whether ${found.projectRelativePath ?? found.path} is committed: fix git (e.g. safe.directory), or set the keystore secrets`
      )
    }
    // Outside the repository (a keystore kept on the runner): as it is.
    foundRepo = repoRelative(found.path)
    if (!foundRepo) return { keystore: found, origin: found.source }
    // ProjectSettings may spell the path in another case than the index: fine where the file
    // system ignores case (core.ignorecase), but on Linux that would be another file.
    const ignoreCase = (await git(o.projectRoot, ['config', '--get', 'core.ignorecase']))?.trim()
    const magic = ignoreCase === 'true' ? 'top,literal,icase' : 'top,literal'
    const tracked = ['ls-files', '--error-unmatch', '--', `:(${magic})${foundRepo}`]
    if (await git(o.projectRoot, tracked)) return { keystore: found, origin: found.source }
  } else {
    // A wrong project-path must not get a key (committed to the wrong place, then a second one).
    if (!(await exists(path.join(o.projectRoot, 'Assets'))) || !(await exists(settingsFile))) {
      throw new CiError(
        'E_KEYSTORE',
        `${o.projectRoot} is not a Unity project (no Assets folder or ProjectSettings/ProjectSettings.asset): check project-path. No keystore was generated`
      )
    }
    if (prefix === undefined) {
      throw new CiError(
        'E_KEYSTORE',
        `${o.projectRoot} is not in a git checkout (or git failed), so its committed keystores cannot be listed: no keystore is generated. Commit one, or set the keystore secrets`
      )
    }
  }
  if (!o.token || !o.repository) {
    throw new CiError(
      'E_KEYSTORE',
      `The default branch cannot be checked for the game's keystore (no github-token or repository), so ${found ? `the untracked ${foundRepo} cannot be trusted` : 'no keystore is generated'}`
    )
  }
  const repository = o.repository
  // The checkout must be that repository: else the wrong default branch would be checked and written.
  const remote = (await git(o.projectRoot, ['config', '--get', 'remote.origin.url']))?.trim()
  const checkout = remote
    ? /github\.com[/:]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(remote)?.[1]
    : undefined
  if (checkout && checkout.toLowerCase() !== repository.toLowerCase()) {
    throw new CiError(
      'E_KEYSTORE',
      `The checkout is ${checkout}, not ${repository}: its keystore would be checked on (and committed to) the wrong repository. Run the release in ${checkout}'s own workflow, or set the keystore secrets`
    )
  }
  const github = new GitHubClient({
    token: o.token,
    ...(o.fetch ? { fetch: o.fetch, minDelay: 1 } : {})
  })
  const main = await defaultBranchKeystores(github, repository, prefix)
  const list = (keys: TreeEntry[]): string => keys.map(e => e.path).join(', ')
  /** A repository path with the project folder spelled as on the default branch. */
  const onBranch = (repoPath: string): string =>
    prefix && repoPath.toLowerCase().startsWith(prefix.toLowerCase())
      ? `${main.prefix}${repoPath.slice(prefix.length)}`
      : repoPath

  const namedFile = settings.name
    ? resolveProjectKeystorePath(o.projectRoot, settings.name)
    : undefined
  const namedRel = namedFile
    ? path.relative(o.projectRoot, namedFile).split(path.sep).join('/')
    : undefined
  const namedRepo = namedFile ? repoRelative(namedFile) : undefined

  /** The default branch's keystore at the project root or where ProjectSettings points, written here. */
  const adopt = async (branch: DefaultBranch): Promise<KeystoreSetup | undefined> => {
    // The one ProjectSettings names may sit outside the project folder (`../Keys/x.keystore`).
    const named = namedRepo
      ? branch.files.find(e => e.path.toLowerCase() === onBranch(namedRepo).toLowerCase())
      : undefined
    if (!named && branch.keys.length === 0) return undefined
    const rel = (e: TreeEntry): string => e.path.slice(branch.prefix.length)
    const pick =
      named ??
      branch.keys.find(e => rel(e).toLowerCase() === `${o.name}.keystore`.toLowerCase()) ??
      (branch.keys.length === 1 && !rel(branch.keys[0]!).includes('/') ? branch.keys[0] : undefined)
    if (!pick) {
      throw new CiError(
        'E_KEYSTORE',
        `${branch.branch} has ${list(branch.keys)}, which this commit does not have: tag a commit that has the keystore (merge ${branch.branch} first), or name it in ProjectSettings.asset. No keystore is generated`
      )
    }
    const { data } = await github.request<{ content?: string; encoding?: string }>(
      `/repos/${repository}/git/blobs/${pick.sha}`
    )
    if (data.encoding !== 'base64' || !data.content) {
      throw new CiError('E_KEYSTORE', `${pick.path} on ${branch.branch} cannot be read`)
    }
    // Where ProjectSettings points (its spelling, for a case-sensitive file system), else the root.
    const target =
      pick === named && namedFile ? namedFile : path.join(o.projectRoot, ...rel(pick).split('/'))
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, Buffer.from(data.content, 'base64'))
    core.info(`Using ${pick.path} from ${branch.branch}: this commit does not have it`)
    return {
      keystore: await resolve(),
      origin: 'default-branch',
      committed: true,
      repoPath: pick.path
    }
  }

  /** Commit `file` to `repoPath` on the default branch (retried on 409/422 while it is absent). */
  const commit = async (
    file: string,
    repoPath: string,
    keystore: ResolvedKeystore,
    origin: KeystoreOrigin
  ): Promise<KeystoreSetup> => {
    const done = { keystore, origin, repoPath }
    if (!isReleaseKeystore(repoPath)) {
      throw new CiError(
        'E_KEYSTORE',
        `${repoPath} is not a *.keystore or *.jks file: it is not committed. Rename it, or set the keystore secrets`
      )
    }
    if (!o.commit) {
      core.info(`${repoPath} is not committed by this step (commit-keystore: false)`)
      return { ...done, committed: false }
    }
    const bytes = await readFile(file)
    const sha = blobSha(bytes)
    const apiPath = repoPath.split('/').map(encodeURIComponent).join('/')
    let failure: unknown
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const { data } = await github.request<{ commit?: { html_url?: string } }>(
          `/repos/${repository}/contents/${apiPath}`,
          {
            method: 'PUT',
            body: {
              message: `chore: add the release keystore ${path.posix.basename(repoPath)} (committed by CI)`,
              content: bytes.toString('base64'),
              branch: main.branch
            }
          }
        )
        core.info(`Committed ${repoPath} to ${main.branch}`)
        return {
          ...done,
          committed: true,
          ...(data.commit?.html_url ? { commitUrl: data.commit.html_url } : {})
        }
      } catch (err) {
        failure = err
        if (!(err instanceof GitHubApiError && (err.status === 409 || err.status === 422))) break
        // The file appeared meanwhile (another release, or a retried request that had succeeded),
        // or the branch moved under the request: then nothing is there yet, and the PUT is retried.
        const now = await defaultBranchKeystores(github, repository, prefix).catch(() => undefined)
        if (!now) break
        const other = gameKeys(now, repoPath, namedRepo && onBranch(namedRepo))
        const same = other.find(e => e.sha === sha)
        if (same) return { ...done, committed: true, repoPath: same.path }
        if (other.length > 0) {
          if (origin === 'generated') {
            // Never used: drop it and take the one that won.
            await rm(file, { force: true })
            const adopted = await adopt(now)
            if (adopted) return adopted
          }
          throw new CiError(
            'E_KEYSTORE',
            `${list(other)} reached ${now.branch} while ${repoPath} was being committed: release again, it uses that keystore${origin === 'generated' ? '' : ` (delete ${repoPath} from this runner first)`}`
          )
        }
      }
    }
    core.warning(
      `${repoPath} could not be committed to ${main.branch}: ${errorMessage(failure)}. Commit it yourself before the next release`
    )
    return { ...done, committed: false }
  }

  if (found) {
    const repoPath = onBranch(foundRepo!)
    const sha = blobSha(await readFile(found.path))
    const other = gameKeys(main, repoPath, namedRepo && onBranch(namedRepo))
    const same = other.find(e => e.sha === sha)
    if (same) {
      core.info(
        `${repoPath} is not in this commit, but ${main.branch} has the same file (${same.path})`
      )
      return { keystore: found, origin: found.source, committed: true, repoPath: same.path }
    }
    // The same bytes outside the project folder (and not where ProjectSettings points): another game's?
    const elsewhere = main.files.filter(
      e => e.sha === sha && !other.includes(e) && !e.path.startsWith(main.prefix)
    )
    if (elsewhere.length > 0) {
      core.warning(
        `${repoPath} is the same file as ${list(elsewhere)} on ${main.branch}, outside this project folder: is this a copy of another game's key?`
      )
    }
    if (other.length > 0) {
      throw new CiError(
        'E_KEYSTORE',
        `${repoPath} is not committed, and ${main.branch} has another keystore (${list(other)}): this copy is not the game's key. Delete it from this runner (or run the release with clean: true), then release again`
      )
    }
    core.warning(
      `${repoPath} is not committed (left by an earlier run?) and ${main.branch} has no keystore for this game: this release signs with it, so it must be committed`
    )
    return commit(found.path, repoPath, found, found.source)
  }

  const adopted = await adopt(main)
  if (adopted) return adopted

  // ProjectSettings' alias when it names this file name, so a manual build agrees with CI.
  const file = path.join(o.projectRoot, `${o.name}.keystore`)
  const sameName =
    path.basename(namedRel ?? '').toLowerCase() === `${o.name}.keystore`.toLowerCase()
  if (namedRel && namedRel.toLowerCase() !== `${o.name}.keystore`.toLowerCase()) {
    core.warning(
      `ProjectSettings.asset names ${settings.name}, which is neither in this commit nor on ${main.branch}: the release is signed with a new ${o.name}.keystore at the project root instead. If Google Play knows the key of ${path.basename(namedRel)}, find and commit it instead`
    )
  }
  await (o.generateKeystore ?? generateKeystore)({
    keytool: findKeytool(o.projectRoot, o.editorPath, o.host, o.listDir),
    dir: o.projectRoot,
    name: o.name,
    alias: sameName && settings.alias ? settings.alias : undefined
  })
  const keystore = await resolve()
  const repoPath = `${main.prefix}${o.name}.keystore`
  core.warning(
    `Generated a new release keystore ${repoPath} (password = its name): every later release must sign with it`
  )
  return commit(file, repoPath, keystore, 'generated')
}
