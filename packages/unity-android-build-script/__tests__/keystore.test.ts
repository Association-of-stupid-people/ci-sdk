import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { GenerateKeystoreOptions } from '../../sdk/src/index.js'
import { editorCandidates, type HostEnv } from '../../unity-build/src/locate.js'
import { blobSha, findKeytool, setupKeystore, type KeystoreSetupOptions } from '../src/keystore.js'

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../sdk/__tests__/fixtures'
)
// keytool -genkeypair -storetype PKCS12 -alias my-game -keystore My-Game.keystore -storepass My-Game
const KEYSTORE = path.join(FIXTURES, 'My-Game.keystore')
// Another keystore (JKS: accepted unverified), as if another run had committed a different key.
const OTHER = path.join(FIXTURES, 'legacy.jks')
const API = 'https://api.github.com/repos/o/My-Game'

const SETTINGS =
  "PlayerSettings:\n  AndroidKeystoreName: '{inproject}: My-Game.keystore'\n  AndroidKeyaliasName: my-game\n"

const noHost: HostEnv = {
  platform: 'linux',
  env: {},
  home: '/home/u',
  exists: () => false,
  read: () => undefined
}

/** The URL of a fetch call. */
const urlOf = (input: string | URL | Request): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

interface Call {
  method: string
  url: string
  body: Record<string, string> | undefined
}

interface FakeOptions {
  /** The default branch's files (repository path -> bytes). */
  main?: Record<string, Buffer>
  /** PUT replies in turn (default 201). */
  put?: number | number[]
  /** On the first PUT, another run's key lands at that path first (and the PUT gets 422). */
  race?: Buffer
  /** Where the racing key lands instead (default: the PUT's path). */
  raceAt?: string
  treeStatus?: number
  truncated?: boolean
  /** Extra folders of the default branch (the parents of its files are listed anyway). */
  folders?: string[]
}

/** A fake GitHub API: the repository, the default branch's tree and blobs, and contents PUT. */
function fakeGitHub(o: FakeOptions = {}): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const main = new Map(Object.entries(o.main ?? {}))
  const puts = Array.isArray(o.put) ? [...o.put] : undefined
  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input)
    const method = init?.method ?? 'GET'
    const body =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, string>) : undefined
    calls.push({ method, url, body })
    if (url === API) return json(200, { default_branch: 'main' })
    if (url === `${API}/git/trees/main?recursive=1` && method === 'GET') {
      if (o.treeStatus) return json(o.treeStatus, { message: 'nope' })
      const tree = [...main].map(([p, bytes]) => ({ path: p, type: 'blob', sha: blobSha(bytes) }))
      const folders = new Set(['Assets', ...(o.folders ?? [])])
      for (const p of main.keys()) {
        const parts = p.split('/')
        for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/'))
      }
      for (const f of folders) tree.push({ path: f, type: 'tree', sha: 'f'.repeat(40) })
      return json(200, { tree, truncated: !!o.truncated })
    }
    const blob = /\/git\/blobs\/([0-9a-f]{40})$/.exec(url)
    if (blob && method === 'GET') {
      const bytes = [...main.values()].find(b => blobSha(b) === blob[1])
      return bytes
        ? json(200, {
            encoding: 'base64',
            content: bytes.toString('base64').replace(/(.{60})/g, '$1\n')
          })
        : json(404, { message: 'Not Found' })
    }
    const contents = `${API}/contents/`
    if (url.startsWith(contents) && method === 'PUT') {
      const repoPath = url.slice(contents.length).split('/').map(decodeURIComponent).join('/')
      if (o.race && !main.has(repoPath) && !main.has(o.raceAt ?? repoPath)) {
        main.set(o.raceAt ?? repoPath, o.race)
        return json(422, { message: 'sha wasn’t supplied' })
      }
      const status = (puts ? puts.shift() : (o.put as number | undefined)) ?? 201
      if (status === 201) {
        main.set(repoPath, Buffer.from(body!['content']!, 'base64'))
        return json(201, { commit: { html_url: 'https://github.com/o/My-Game/commit/abc' } })
      }
      return json(status, { message: `HTTP ${status}` })
    }
    return json(500, { message: `unexpected ${method} ${url}` })
  }
  return { fetch: impl, calls }
}

const gitInit = (dir: string): void => {
  execFileSync('git', ['init', '-q'], { cwd: dir })
}

/** A repository at <temp>/repo with the Unity project in its `folder`, ProjectSettings naming `keystore`. */
async function subProject(folder: string, keystore = 'My-Game.keystore'): Promise<string> {
  const repo = path.join(temp, 'repo')
  const game = path.join(repo, folder)
  await mkdir(path.join(game, 'ProjectSettings'), { recursive: true })
  await mkdir(path.join(game, 'Assets'))
  await writeFile(
    path.join(game, 'ProjectSettings', 'ProjectSettings.asset'),
    SETTINGS.replace('My-Game.keystore', keystore)
  )
  gitInit(repo)
  return game
}

let root: string
let temp: string
let generated: GenerateKeystoreOptions[]
let stdout: MockInstance<typeof process.stdout.write>
let key: Buffer
let other: Buffer
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'ci-sdk-ks-root-'))
  temp = await mkdtemp(path.join(os.tmpdir(), 'ci-sdk-ks-temp-'))
  await mkdir(path.join(root, 'ProjectSettings'), { recursive: true })
  await mkdir(path.join(root, 'Assets'))
  await writeFile(path.join(root, 'ProjectSettings', 'ProjectSettings.asset'), SETTINGS)
  gitInit(root)
  generated = []
  key = await readFile(KEYSTORE)
  other = await readFile(OTHER)
  stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
  await rm(temp, { recursive: true, force: true })
})

/** Generation without keytool: the fixture stands for the new key. */
async function fakeGenerate(o: GenerateKeystoreOptions): Promise<string> {
  generated.push(o)
  const file = path.join(o.dir, `${o.name}.keystore`)
  await copyFile(KEYSTORE, file)
  return file
}

function options(over: Partial<KeystoreSetupOptions>): KeystoreSetupOptions {
  return {
    projectRoot: root,
    tempDir: path.join(temp, 'keys'),
    inputs: {},
    name: 'My-Game',
    generate: true,
    commit: true,
    token: 'ghs_test',
    repository: 'o/My-Game',
    editorPath: undefined,
    generateKeystore: fakeGenerate,
    host: noHost,
    listDir: () => [],
    ...over
  }
}

const warnings = (): string =>
  stdout.mock.calls
    .map(c => String(c[0]))
    .filter(line => line.startsWith('::warning::'))
    .join('\n')
const puts = (calls: Call[]): Call[] => calls.filter(c => c.method === 'PUT')

describe('setupKeystore: a keystore in the project', () => {
  it('uses a committed one with no API call', async () => {
    await copyFile(KEYSTORE, path.join(root, 'My-Game.keystore'))
    execFileSync('git', ['add', 'My-Game.keystore'], { cwd: root })
    const gh = fakeGitHub()
    const setup = await setupKeystore(options({ fetch: gh.fetch }))
    expect(setup.origin).toBe('project-settings')
    expect(setup.committed).toBeUndefined()
    expect(setup.repoPath).toBeUndefined()
    expect(gh.calls).toEqual([])
  })

  it('without generate-keystore: an untracked one as before, none fails, no API call', async () => {
    const gh = fakeGitHub()
    await expect(
      setupKeystore(options({ generate: false, fetch: gh.fetch }))
    ).rejects.toMatchObject({ code: 'E_NO_KEYSTORE' })
    await copyFile(KEYSTORE, path.join(root, 'My-Game.keystore'))
    expect((await setupKeystore(options({ generate: false, fetch: gh.fetch }))).origin).toBe(
      'project-settings'
    )
    expect(gh.calls).toEqual([])
    expect(generated).toEqual([])
  })

  it('an untracked one that the default branch has (same file) is used as committed', async () => {
    await copyFile(KEYSTORE, path.join(root, 'My-Game.keystore'))
    const gh = fakeGitHub({ main: { 'My-Game.keystore': key } })
    const setup = await setupKeystore(options({ fetch: gh.fetch }))
    expect(setup).toMatchObject({
      origin: 'project-settings',
      committed: true,
      repoPath: 'My-Game.keystore'
    })
    expect(puts(gh.calls)).toEqual([])
  })

  it('an untracked one that the default branch has under another name reports that path', async () => {
    await copyFile(KEYSTORE, path.join(root, 'My-Game.keystore'))
    const gh = fakeGitHub({ main: { 'Keys/old.keystore': key } })
    const setup = await setupKeystore(options({ fetch: gh.fetch }))
    expect(setup).toMatchObject({ committed: true, repoPath: 'Keys/old.keystore' })
    expect(puts(gh.calls)).toEqual([])
  })

  it('an untracked one is never trusted when git cannot tell', async () => {
    await rm(path.join(root, '.git'), { recursive: true, force: true })
    await copyFile(KEYSTORE, path.join(root, 'My-Game.keystore'))
    const gh = fakeGitHub()
    await expect(setupKeystore(options({ fetch: gh.fetch }))).rejects.toThrow(
      /cannot be told whether My-Game\.keystore is committed/
    )
    expect(gh.calls).toEqual([])
  })

  it('only a *.keystore or *.jks file is ever committed', async () => {
    await writeFile(
      path.join(root, 'ProjectSettings', 'ProjectSettings.asset'),
      SETTINGS.replace('My-Game.keystore', 'My-Game.bin')
    )
    await copyFile(KEYSTORE, path.join(root, 'My-Game.bin'))
    const gh = fakeGitHub()
    await expect(setupKeystore(options({ fetch: gh.fetch, commit: false }))).rejects.toThrow(
      /My-Game\.bin is not a \*\.keystore or \*\.jks file/
    )
    expect(puts(gh.calls)).toEqual([])
  })

  it('an untracked one, with no keystore on the default branch, is committed (it signs this release)', async () => {
    await copyFile(KEYSTORE, path.join(root, 'My-Game.keystore'))
    const gh = fakeGitHub()
    const setup = await setupKeystore(options({ fetch: gh.fetch }))
    expect(setup).toMatchObject({
      origin: 'project-settings',
      committed: true,
      repoPath: 'My-Game.keystore'
    })
    expect(puts(gh.calls)).toHaveLength(1)
    expect(warnings()).toContain('My-Game.keystore is not committed')
    expect(generated).toEqual([])
  })

  it('an untracked one with commit-keystore false is left for a later job', async () => {
    await copyFile(KEYSTORE, path.join(root, 'My-Game.keystore'))
    const gh = fakeGitHub()
    const setup = await setupKeystore(options({ fetch: gh.fetch, commit: false }))
    expect(setup).toMatchObject({ committed: false, repoPath: 'My-Game.keystore' })
    expect(puts(gh.calls)).toEqual([])
  })

  it('an untracked one that differs from the default branch stops the step', async () => {
    await copyFile(KEYSTORE, path.join(root, 'My-Game.keystore'))
    const gh = fakeGitHub({ main: { 'My-Game.keystore': other } })
    await expect(setupKeystore(options({ fetch: gh.fetch }))).rejects.toThrow(
      /My-Game\.keystore is not committed, and main has another keystore \(My-Game\.keystore\)/
    )
    expect(puts(gh.calls)).toEqual([])
  })

  it('an untracked one cannot be trusted without the API', async () => {
    await copyFile(KEYSTORE, path.join(root, 'My-Game.keystore'))
    await expect(setupKeystore(options({ token: undefined }))).rejects.toThrow(
      /cannot be checked .*untracked My-Game\.keystore cannot be trusted/
    )
  })
})

describe('setupKeystore: no keystore in the project', () => {
  it('takes the keystore from the default branch when this commit does not have it', async () => {
    const gh = fakeGitHub({ main: { 'My-Game.keystore': key } })
    const setup = await setupKeystore(options({ fetch: gh.fetch }))
    expect(setup).toMatchObject({
      origin: 'default-branch',
      committed: true,
      repoPath: 'My-Game.keystore',
      keystore: { password: 'My-Game', verification: 'ok' }
    })
    expect(await readFile(path.join(root, 'My-Game.keystore'))).toEqual(key)
    expect(generated).toEqual([])
    expect(puts(gh.calls)).toEqual([])
  })

  it('takes the one ProjectSettings points to, in a subfolder', async () => {
    await writeFile(
      path.join(root, 'ProjectSettings', 'ProjectSettings.asset'),
      SETTINGS.replace('My-Game.keystore', 'Keys/My-Game.keystore')
    )
    const gh = fakeGitHub({ main: { 'Keys/My-Game.keystore': key, 'Old/x.jks': other } })
    const setup = await setupKeystore(options({ fetch: gh.fetch }))
    expect(setup).toMatchObject({ origin: 'default-branch', repoPath: 'Keys/My-Game.keystore' })
    expect(setup.keystore.path).toBe(path.join(root, 'Keys', 'My-Game.keystore'))
  })

  it("writes it where ProjectSettings points, in ProjectSettings' spelling", async () => {
    await writeFile(
      path.join(root, 'ProjectSettings', 'ProjectSettings.asset'),
      SETTINGS.replace('My-Game.keystore', 'keys/My-Game.keystore')
    )
    const gh = fakeGitHub({ main: { 'Keys/My-Game.keystore': key } })
    const setup = await setupKeystore(options({ fetch: gh.fetch }))
    expect(setup).toMatchObject({ origin: 'default-branch', repoPath: 'Keys/My-Game.keystore' })
    expect(setup.keystore.path).toBe(path.join(root, 'keys', 'My-Game.keystore'))
  })

  it('never generates when the default branch has a keystore it cannot place', async () => {
    const gh = fakeGitHub({ main: { 'Old/Other.KEYSTORE': other } })
    await expect(setupKeystore(options({ fetch: gh.fetch }))).rejects.toThrow(
      /main has Old\/Other\.KEYSTORE, which this commit does not have/
    )
    expect(generated).toEqual([])
  })

  it('ignores debug keystores and keystores of other folders on the default branch', async () => {
    const repo = path.join(temp, 'repo')
    const game = path.join(repo, 'My Game')
    await mkdir(path.join(game, 'ProjectSettings'), { recursive: true })
    await mkdir(path.join(game, 'Assets'))
    await writeFile(path.join(game, 'ProjectSettings', 'ProjectSettings.asset'), SETTINGS)
    gitInit(repo)
    const gh = fakeGitHub({
      main: {
        'Other Game/Other.keystore': other,
        'My Game/Assets/Plugins/Android/debug.keystore': other
      }
    })
    const setup = await setupKeystore(options({ projectRoot: game, fetch: gh.fetch }))
    expect(setup).toMatchObject({
      origin: 'generated',
      committed: true,
      repoPath: 'My Game/My-Game.keystore'
    })
    expect(puts(gh.calls).map(c => c.url)).toEqual([`${API}/contents/My%20Game/My-Game.keystore`])
  })

  it("matches the project folder in any case, and commits in the branch's spelling", async () => {
    const repo = path.join(temp, 'repo')
    const game = path.join(repo, 'game')
    await mkdir(path.join(game, 'ProjectSettings'), { recursive: true })
    await mkdir(path.join(game, 'Assets'))
    await writeFile(path.join(game, 'ProjectSettings', 'ProjectSettings.asset'), SETTINGS)
    gitInit(repo)
    // The branch spells the folder Game/ (a case-only rename left game/ on a persistent runner).
    await expect(
      setupKeystore(
        options({
          projectRoot: game,
          fetch: fakeGitHub({ main: { 'Game/Old/Other.keystore': other } }).fetch
        })
      )
    ).rejects.toThrow(/main has Game\/Old\/Other\.keystore/)
    expect(generated).toEqual([])
    const gh = fakeGitHub({ folders: ['Game'] })
    const setup = await setupKeystore(options({ projectRoot: game, fetch: gh.fetch }))
    expect(setup).toMatchObject({ origin: 'generated', repoPath: 'Game/My-Game.keystore' })
    expect(puts(gh.calls).map(c => c.url)).toEqual([`${API}/contents/Game/My-Game.keystore`])
  })

  it('generates the keystore and commits it to the default branch', async () => {
    const gh = fakeGitHub()
    const setup = await setupKeystore(options({ fetch: gh.fetch }))
    expect(setup).toMatchObject({
      origin: 'generated',
      committed: true,
      commitUrl: 'https://github.com/o/My-Game/commit/abc',
      repoPath: 'My-Game.keystore',
      keystore: { path: path.join(root, 'My-Game.keystore'), alias: 'my-game', password: 'My-Game' }
    })
    expect(generated).toEqual([
      { keytool: 'keytool', dir: root, name: 'My-Game', alias: 'my-game' }
    ])
    const [put] = puts(gh.calls)
    expect(put?.body?.['branch']).toBe('main')
    expect(put?.body?.['message']).toContain('My-Game.keystore')
    expect(Buffer.from(put!.body!['content']!, 'base64')).toEqual(key)
    expect(warnings()).toContain('Generated a new release keystore My-Game.keystore')
  })

  it('a commit that already went through (a retried request) counts as committed', async () => {
    const setup = await setupKeystore(options({ fetch: fakeGitHub({ race: key }).fetch }))
    expect(setup).toMatchObject({ origin: 'generated', committed: true })
  })

  it('takes the keystore another run committed meanwhile, not its own', async () => {
    const setup = await setupKeystore(options({ fetch: fakeGitHub({ race: other }).fetch }))
    expect(setup).toMatchObject({ origin: 'default-branch', committed: true })
    expect(await readFile(path.join(root, 'My-Game.keystore'))).toEqual(other)
  })

  it('retries the PUT while the keystore is still absent (the branch moved)', async () => {
    const gh = fakeGitHub({ put: [409, 201] })
    const setup = await setupKeystore(options({ fetch: gh.fetch }))
    expect(setup).toMatchObject({ origin: 'generated', committed: true })
    expect(puts(gh.calls)).toHaveLength(2)
  })

  it('gives up after three refused PUTs, with a warning', async () => {
    const gh = fakeGitHub({ put: 409 })
    const setup = await setupKeystore(options({ fetch: gh.fetch }))
    expect(setup).toMatchObject({ origin: 'generated', committed: false })
    expect(puts(gh.calls)).toHaveLength(3)
    expect(warnings()).toMatch(/could not be committed to main: .*409/)
  })

  it('a failed commit is a warning: the keystore stays, committed is false', async () => {
    const gh = fakeGitHub({ put: 403 })
    const setup = await setupKeystore(options({ fetch: gh.fetch }))
    expect(setup).toMatchObject({ origin: 'generated', committed: false })
    expect(existsSync(path.join(root, 'My-Game.keystore'))).toBe(true)
    expect(warnings()).toMatch(/My-Game\.keystore could not be committed to main: .*403/)
  })

  it('commit-keystore false: checks the default branch, generates, does not commit', async () => {
    const gh = fakeGitHub()
    const setup = await setupKeystore(options({ fetch: gh.fetch, commit: false }))
    expect(setup).toMatchObject({
      origin: 'generated',
      committed: false,
      repoPath: 'My-Game.keystore'
    })
    expect(gh.calls.some(c => c.url.includes('/git/trees/main'))).toBe(true)
    expect(puts(gh.calls)).toEqual([])
    expect(warnings()).not.toContain('could not be committed')
  })

  it('generates with the alias ProjectSettings gives that file name', async () => {
    await writeFile(
      path.join(root, 'ProjectSettings', 'ProjectSettings.asset'),
      SETTINGS.replace('AndroidKeyaliasName: my-game', 'AndroidKeyaliasName: Custom-Alias')
    )
    const setup = await setupKeystore(options({ fetch: fakeGitHub().fetch }))
    expect(generated[0]?.alias).toBe('Custom-Alias')
    expect(setup.keystore.alias).toBe('Custom-Alias')
  })

  it('warns when ProjectSettings names another keystore, or the same name elsewhere', async () => {
    const asset = path.join(root, 'ProjectSettings', 'ProjectSettings.asset')
    await writeFile(
      asset,
      "PlayerSettings:\n  AndroidKeystoreName: '{inproject}: old-key.keystore'\n  AndroidKeyaliasName: old-key\n"
    )
    const setup = await setupKeystore(options({ fetch: fakeGitHub().fetch }))
    expect(generated[0]?.alias).toBeUndefined()
    expect(setup.keystore.alias).toBe('my-game')
    expect(warnings()).toMatch(
      /ProjectSettings\.asset names \{inproject\}: old-key\.keystore, which is neither in this commit nor on main/
    )
    await rm(path.join(root, 'My-Game.keystore'))
    stdout.mockClear()
    await writeFile(asset, SETTINGS.replace('My-Game.keystore', 'Keys/My-Game.keystore'))
    await setupKeystore(options({ fetch: fakeGitHub().fetch }))
    expect(generated[1]?.alias).toBe('my-game')
    expect(warnings()).toContain('names {inproject}: Keys/My-Game.keystore, which is neither')
  })

  it('refuses to generate when project-path is not a Unity project', async () => {
    await rm(path.join(root, 'Assets'), { recursive: true })
    const gh = fakeGitHub()
    await expect(setupKeystore(options({ fetch: gh.fetch }))).rejects.toThrow(
      /is not a Unity project .*check project-path/
    )
    expect(gh.calls).toEqual([])
    expect(generated).toEqual([])
  })

  it('refuses to generate outside a git checkout', async () => {
    await rm(path.join(root, '.git'), { recursive: true, force: true })
    const gh = fakeGitHub()
    await expect(setupKeystore(options({ fetch: gh.fetch }))).rejects.toThrow(
      /is not in a git checkout/
    )
    expect(gh.calls).toEqual([])
    expect(generated).toEqual([])
  })

  it('refuses to generate without a token: the default branch cannot be checked', async () => {
    await expect(setupKeystore(options({ token: undefined }))).rejects.toThrow(
      /cannot be checked .*no keystore is generated/
    )
    expect(generated).toEqual([])
  })

  it('stops when the default branch cannot be listed, or only in part', async () => {
    await expect(
      setupKeystore(options({ fetch: fakeGitHub({ treeStatus: 403 }).fetch }))
    ).rejects.toThrow(/403/)
    await expect(
      setupKeystore(options({ fetch: fakeGitHub({ truncated: true }).fetch }))
    ).rejects.toThrow(/cannot be listed in one API call/)
    expect(generated).toEqual([])
  })
})

describe('setupKeystore: the repository around the project', () => {
  it('adopts the keystore ProjectSettings names outside the project folder', async () => {
    const game = await subProject('Game', '../Keys/My-Game.keystore')
    const gh = fakeGitHub({ main: { 'Keys/My-Game.keystore': key } })
    const setup = await setupKeystore(options({ projectRoot: game, fetch: gh.fetch }))
    expect(setup).toMatchObject({
      origin: 'default-branch',
      committed: true,
      repoPath: 'Keys/My-Game.keystore'
    })
    expect(setup.keystore.path).toBe(path.join(temp, 'repo', 'Keys', 'My-Game.keystore'))
    expect(generated).toEqual([])
  })

  it('checks an untracked keystore outside the project folder by its repository path', async () => {
    const game = await subProject('Game', '../Keys/My-Game.keystore')
    await mkdir(path.join(temp, 'repo', 'Keys'))
    await copyFile(KEYSTORE, path.join(temp, 'repo', 'Keys', 'My-Game.keystore'))
    const gh = fakeGitHub()
    const setup = await setupKeystore(options({ projectRoot: game, fetch: gh.fetch }))
    expect(setup).toMatchObject({ committed: true, repoPath: 'Keys/My-Game.keystore' })
    expect(puts(gh.calls).map(c => c.url)).toEqual([`${API}/contents/Keys/My-Game.keystore`])
    await expect(
      setupKeystore(
        options({
          projectRoot: game,
          fetch: fakeGitHub({ main: { 'Keys/My-Game.keystore': other } }).fetch
        })
      )
    ).rejects.toThrow(/Keys\/My-Game\.keystore is not committed, and main has another keystore/)
  })

  it("prefers the folder spelled exactly as git's prefix", async () => {
    const game = await subProject('game')
    // A case-sensitive repository with both Game/ (another project) and game/ (this one).
    const gh = fakeGitHub({ main: { 'Game/Other.keystore': other }, folders: ['game'] })
    const setup = await setupKeystore(options({ projectRoot: game, fetch: gh.fetch }))
    expect(setup).toMatchObject({ origin: 'generated', repoPath: 'game/My-Game.keystore' })
  })

  it('refuses a checkout of another repository than the one it would write to', async () => {
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/o/Other.git'], {
      cwd: root
    })
    const gh = fakeGitHub()
    await expect(setupKeystore(options({ fetch: gh.fetch }))).rejects.toThrow(
      /The checkout is o\/Other, not o\/My-Game/
    )
    expect(gh.calls).toEqual([])
    execFileSync('git', ['remote', 'set-url', 'origin', 'https://github.com/O/my-game'], {
      cwd: root
    })
    expect((await setupKeystore(options({ fetch: gh.fetch }))).origin).toBe('generated')
  })

  it("never takes another game's key in the repository for this game's", async () => {
    const game = await subProject('GameA')
    await copyFile(KEYSTORE, path.join(game, 'My-Game.keystore'))
    const gh = fakeGitHub({ main: { 'GameB/GameB.keystore': key } })
    const setup = await setupKeystore(options({ projectRoot: game, fetch: gh.fetch }))
    expect(setup).toMatchObject({ committed: true, repoPath: 'GameA/My-Game.keystore' })
    expect(puts(gh.calls).map(c => c.url)).toEqual([`${API}/contents/GameA/My-Game.keystore`])
    expect(warnings()).toMatch(/the same file as GameB\/GameB\.keystore on main, outside/)
  })

  it('no warning when the same bytes sit in the project folder under another name', async () => {
    await copyFile(KEYSTORE, path.join(root, 'My-Game.keystore'))
    const gh = fakeGitHub({ main: { 'Keys/My-Game.p12': key } })
    const setup = await setupKeystore(options({ fetch: gh.fetch }))
    expect(setup).toMatchObject({ committed: true, repoPath: 'My-Game.keystore' })
    expect(warnings()).not.toMatch(/the same file as/)
  })

  it('adopts the file ProjectSettings names whatever its extension', async () => {
    const game = await subProject('Game', 'Keys/release.ks')
    // JKS (accepted unverified): its password would be "release", not the fixture's.
    const gh = fakeGitHub({ main: { 'Game/Keys/release.ks': other } })
    const setup = await setupKeystore(options({ projectRoot: game, fetch: gh.fetch }))
    expect(setup).toMatchObject({
      origin: 'default-branch',
      committed: true,
      repoPath: 'Game/Keys/release.ks'
    })
    expect(setup.keystore.path).toBe(path.join(game, 'Keys', 'release.ks'))
    expect(generated).toEqual([])
    expect(puts(gh.calls)).toEqual([])
  })

  it('an untracked key clashes with a ProjectSettings-named file of any extension', async () => {
    const game = await subProject('Game', 'Keys/release.ks')
    await copyFile(KEYSTORE, path.join(game, 'My-Game.keystore'))
    const gh = fakeGitHub({ main: { 'Game/Keys/release.ks': other } })
    await expect(setupKeystore(options({ projectRoot: game, fetch: gh.fetch }))).rejects.toThrow(
      /Game\/My-Game\.keystore is not committed, and main has another keystore \(Game\/Keys\/release\.ks\)/
    )
    expect(puts(gh.calls)).toEqual([])
  })

  it('an untracked key clashes with the one ProjectSettings names outside the project', async () => {
    const game = await subProject('Game', '../Keys/My-Game.keystore')
    // A stray key from an earlier run at the project root; the real one is on main where ProjectSettings points.
    await copyFile(KEYSTORE, path.join(game, 'My-Game.keystore'))
    const gh = fakeGitHub({ main: { 'Keys/My-Game.keystore': other } })
    await expect(setupKeystore(options({ projectRoot: game, fetch: gh.fetch }))).rejects.toThrow(
      /Game\/My-Game\.keystore is not committed, and main has another keystore \(Keys\/My-Game\.keystore\)/
    )
    expect(puts(gh.calls)).toEqual([])
  })

  it('a committed key that ProjectSettings spells in another case is tracked', async () => {
    const game = await subProject('Game', 'keys/My-Game.keystore')
    await mkdir(path.join(game, 'Keys'))
    await copyFile(KEYSTORE, path.join(game, 'Keys', 'My-Game.keystore'))
    // The path ProjectSettings spells: the same file where case is ignored, a separate copy on Linux.
    await mkdir(path.join(game, 'keys'), { recursive: true })
    await copyFile(KEYSTORE, path.join(game, 'keys', 'My-Game.keystore'))
    const repo = path.join(temp, 'repo')
    execFileSync('git', ['add', 'Game/Keys/My-Game.keystore'], { cwd: repo })
    execFileSync('git', ['config', 'core.ignorecase', 'true'], { cwd: repo })
    const gh = fakeGitHub()
    const setup = await setupKeystore(options({ projectRoot: game, fetch: gh.fetch }))
    expect(setup.committed).toBeUndefined()
    expect(gh.calls).toEqual([])
    // A case-sensitive checkout: keys/ is not the Keys/ git tracks, so it is not committed.
    execFileSync('git', ['config', 'core.ignorecase', 'false'], { cwd: repo })
    const again = await setupKeystore(options({ projectRoot: game, fetch: gh.fetch }))
    expect(again).toMatchObject({ committed: true, repoPath: 'Game/keys/My-Game.keystore' })
    expect(puts(gh.calls).map(c => c.url)).toEqual([`${API}/contents/Game/keys/My-Game.keystore`])
  })

  it('without git, only a key ProjectSettings names by an absolute path is used as it is', async () => {
    await rm(path.join(root, '.git'), { recursive: true, force: true })
    const asset = path.join(root, 'ProjectSettings', 'ProjectSettings.asset')
    const outside = path.join(temp, 'keys-on-runner', 'My-Game.keystore')
    await mkdir(path.dirname(outside))
    await copyFile(KEYSTORE, outside)
    await writeFile(
      asset,
      SETTINGS.replace("'{inproject}: My-Game.keystore'", `'${outside.split(path.sep).join('/')}'`)
    )
    const gh = fakeGitHub()
    expect((await setupKeystore(options({ fetch: gh.fetch }))).origin).toBe('project-settings')
    expect(gh.calls).toEqual([])
    // The same key named relative to the project: it may be inside the repository, so not trusted.
    const rel = path.relative(root, outside).split(path.sep).join('/')
    await writeFile(asset, SETTINGS.replace('My-Game.keystore', rel))
    await expect(setupKeystore(options({ fetch: gh.fetch }))).rejects.toThrow(
      /not in a git checkout .*cannot be told whether/
    )
  })

  it('a racing commit of the same file under another path reports that path', async () => {
    const gh = fakeGitHub({ race: key, raceAt: 'Keys/old.keystore' })
    const setup = await setupKeystore(options({ fetch: gh.fetch }))
    expect(setup).toMatchObject({
      origin: 'generated',
      committed: true,
      repoPath: 'Keys/old.keystore'
    })
  })
})

describe('findKeytool', () => {
  it("prefers the keytool of the project's Unity editor", () => {
    const host: HostEnv = {
      ...noHost,
      read: f => (f.endsWith('ProjectVersion.txt') ? 'm_EditorVersion: 6000.0.79f1\n' : undefined),
      exists: f => f === editor || f === keytool
    }
    const editor = editorCandidates(host, '6000.0.79f1')[0]!
    const keytool = path.posix.join(
      path.posix.dirname(editor),
      'Data/PlaybackEngines/AndroidPlayer/OpenJDK/bin/keytool'
    )
    expect(findKeytool('/p', undefined, host)).toBe(keytool)
  })

  it('takes editor-path, then JAVA_HOME, then PATH', () => {
    const unity = '/u/Editor/Data/PlaybackEngines/AndroidPlayer/OpenJDK/bin/keytool'
    expect(
      findKeytool('/p', '/u/Editor/Unity', { ...noHost, exists: f => f === unity }, () => [])
    ).toBe(unity)
    const java = '/jdk/bin/keytool'
    expect(
      findKeytool(
        '/p',
        undefined,
        { ...noHost, env: { JAVA_HOME: '/jdk' }, exists: f => f === java },
        () => []
      )
    ).toBe(java)
    expect(findKeytool('/p', undefined, noHost, () => [])).toBe('keytool')
  })

  it("falls back to the newest installed editor's OpenJDK, after JAVA_HOME", () => {
    const root = '/home/u/Unity/Hub/Editor'
    const keytoolIn = (version: string): string =>
      `${root}/${version}/Editor/Data/PlaybackEngines/AndroidPlayer/OpenJDK/bin/keytool`
    const listDir = (dir: string): string[] =>
      dir === root ? ['2022.3.9f1', '6000.0.79f1', '2022.3.10f1', 'broken'] : []
    const installed = new Set([keytoolIn('2022.3.9f1'), keytoolIn('2022.3.10f1')])
    const host: HostEnv = { ...noHost, exists: f => installed.has(f) }
    expect(findKeytool('/p', undefined, host, listDir)).toBe(keytoolIn('2022.3.10f1'))
    installed.add('/jdk/bin/keytool')
    expect(findKeytool('/p', undefined, { ...host, env: { JAVA_HOME: '/jdk' } }, listDir)).toBe(
      '/jdk/bin/keytool'
    )
  })
})

describe('blobSha', () => {
  it("is git's blob id", () => {
    const file = path.join(root, 'x.bin')
    return writeFile(file, key).then(() => {
      const id = execFileSync('git', ['hash-object', file], { encoding: 'utf8' }).trim()
      expect(blobSha(key)).toBe(id)
    })
  })
})
