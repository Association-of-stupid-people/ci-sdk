import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

vi.mock('@actions/core', async importOriginal => ({
  ...(await importOriginal<typeof import('@actions/core')>()),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  startGroup: vi.fn(),
  endGroup: vi.fn()
}))

// Failure injection for the cleanup: a folder rm cannot delete, a DLL git still reports as changed.
const hooks = vi.hoisted(() => ({ keepClient: false, diffExit: undefined as number | undefined }))
vi.mock('node:fs/promises', async importOriginal => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...real,
    rm: async (p: Parameters<typeof real.rm>[0], o?: Parameters<typeof real.rm>[1]) =>
      hooks.keepClient && String(p).endsWith('BibgDebugView') ? undefined : real.rm(p, o)
  }
})
vi.mock('../../sdk/src/index.js', async importOriginal => {
  const real = await importOriginal<typeof import('../../sdk/src/index.js')>()
  return {
    ...real,
    exec: async (...a: Parameters<typeof real.exec>) =>
      hooks.diffExit !== undefined && a[0] === 'git' && a[1]?.[0] === 'diff'
        ? {
            command: 'git diff',
            exitCode: hooks.diffExit,
            signal: null,
            stdout: '',
            stderr: '',
            durationMs: 0
          }
        : real.exec(...a)
  }
})

import {
  BUILD_PLACEHOLDER,
  DEBUG_VIEW_DIR,
  PATCH_MARKER,
  URL_PLACEHOLDER,
  buildLabel,
  cleanDebugView,
  debugViewGate,
  download,
  fillPlaceholders,
  injectClient,
  parseBaseUrl,
  patchFirebaseDll,
  resolveFirebaseDll,
  type DllPath
} from '../src/debug-view.js'
import { fakeDotnet } from './fixtures/dotnet.js'
import { DLL, ORIGINAL_DLL, git, gitProject, status } from './fixtures/project.js'

const CLIENT = `public static class BibgDebugView {\n  const string InjectedUrl = "${URL_PLACEHOLDER}";\n  const string InjectedBuild = "${BUILD_PLACEHOLDER}";\n}\n`
const TOOL = `#:package Mono.Cecil@0.11.6\n// adds Firebase.Analytics.${PATCH_MARKER}\n`

/** fetch stub: each URL answers the next of its responses (the last one repeats). */
function fakeFetch(routes: Record<string, (Response | Error)[]>): {
  impl: typeof fetch
  calls: string[]
} {
  const calls: string[] = []
  const impl = vi.fn(async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : input.toString()
    calls.push(url)
    const list = routes[url]
    if (!list) return new Response('not found', { status: 404 })
    const next = list.length > 1 ? list.shift() : list[0]
    if (next instanceof Error) throw next
    return next!.clone()
  })
  return { impl, calls }
}

const BASE = 'https://bi.example.org'
const CLIENT_URL = `${BASE}/api/v1/sdk/debugview/BibgDebugView.cs`
const TOOL_URL = `${BASE}/api/v1/sdk/debugview/BibgFirebasePatch.cs`
const io = (): { log: Mock<(m: string) => void>; warn: Mock<(m: string) => void> } => ({
  log: vi.fn(),
  warn: vi.fn()
})

let dir: string
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'debug-view-'))
  hooks.keepClient = false
  hooks.diffExit = undefined
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('parseBaseUrl', () => {
  it('keeps an https base URL without the trailing slash', () => {
    expect(parseBaseUrl('https://bi.example.org')).toBe('https://bi.example.org')
    expect(parseBaseUrl(' https://bi.example.org:8443/bibg/ ')).toBe(
      'https://bi.example.org:8443/bibg'
    )
  })
  it('never lets a quote or backslash into the C# literal', () => {
    expect(parseBaseUrl('https://bi.example.org/a"b\\c')).toBe('https://bi.example.org/a%22b/c')
  })
  it.each([
    ['http://bi.example.org', /https/],
    ['ftp://bi.example.org', /https/],
    ['bi.example.org', /not a URL/],
    ['https://user:pw@bi.example.org', /credentials/],
    ['https://bi.example.org/?x=1', /query/],
    ['https://bi.example.org/#x', /query or fragment/],
    ['https://bi.example.org/api/v1', /without \/api\/v1/]
  ])('rejects %s', (raw, error) => {
    expect(() => parseBaseUrl(raw)).toThrow(error)
  })
})

describe('buildLabel', () => {
  it('is <ref>@<sha7> #<run>', () => {
    expect(buildLabel({ refName: 'develop', sha: '0123456789abcdef', runNumber: 42 })).toBe(
      'develop@0123456 #42'
    )
  })
  it('keeps only the sample characters: no quote, backslash, $ or newline', () => {
    const label = buildLabel({
      refName: 'feat/my_game"; \\x\n$(rm -rf)',
      sha: 'abcdef0123',
      runNumber: 7
    })
    expect(label).toBe('feat/my_game xrm -rf@abcdef0 #7')
    expect(label).toMatch(/^[A-Za-z0-9._@#/ +-]*$/)
  })
  it('can never hold or start like a placeholder, and is capped', () => {
    expect(buildLabel({ refName: '__BIBG_DEBUGVIEW_BUILD__' })).toBe('BIBG_DEBUGVIEW_BUILD_@ #')
    expect(buildLabel({ refName: `x${URL_PLACEHOLDER}`, sha: 'a', runNumber: 1 })).not.toContain(
      URL_PLACEHOLDER
    )
    expect(buildLabel({ refName: 'x'.repeat(300), sha: 'a', runNumber: 1 })).toHaveLength(100)
  })
})

describe('fillPlaceholders', () => {
  it('replaces both placeholders everywhere', () => {
    const out = fillPlaceholders(`${CLIENT}// ${URL_PLACEHOLDER}\n`, BASE, 'main@abc1234 #3')
    expect(out).toContain(`InjectedUrl = "${BASE}"`)
    expect(out).toContain('InjectedBuild = "main@abc1234 #3"')
    expect(out).not.toContain('__BIBG_DEBUGVIEW_')
  })
  it.each([URL_PLACEHOLDER, BUILD_PLACEHOLDER])('fails when %s is missing', p => {
    expect(() => fillPlaceholders(CLIENT.replace(p, 'x'), BASE, 'l')).toThrow(`no ${p} placeholder`)
  })
  it("keeps $' $& $$ in a value as text (no replacement patterns)", () => {
    const url = "https://bi.example.org/x$'y$&$$"
    expect(parseBaseUrl(url)).toBe(url)
    const out = fillPlaceholders(CLIENT, url, 'l')
    expect(out).toContain(`InjectedUrl = "${url}";`)
    expect(out).toContain('InjectedBuild = "l";')
  })
  it('fails when a value brings a placeholder back', () => {
    expect(() => fillPlaceholders(CLIENT, BASE, BUILD_PLACEHOLDER)).toThrow(/still holds/)
  })
})

describe('debugViewGate', () => {
  it('is off unless enabled', () => {
    expect(debugViewGate({ enabled: false, refType: 'branch', ref: 'refs/heads/main' })).toEqual({
      inject: false,
      reason: 'off'
    })
  })
  it.each([
    ['tag', 'refs/tags/v1.2.3'],
    [undefined, 'refs/tags/v1.2.3'],
    ['tag', undefined]
  ])('never injects on a tag, even when enabled (ref_type %s, ref %s)', (refType, ref) => {
    expect(debugViewGate({ enabled: true, refType, ref })).toEqual({ inject: false, reason: 'tag' })
  })
  it('injects on a branch or a PR when enabled', () => {
    expect(debugViewGate({ enabled: true, refType: 'branch', ref: 'refs/heads/dev' }).inject).toBe(
      true
    )
    expect(
      debugViewGate({ enabled: true, refType: 'branch', ref: 'refs/pull/5/merge' }).inject
    ).toBe(true)
  })
})

describe('resolveFirebaseDll', () => {
  it('input, then FIREBASE_ANALYTICS_DLL, then the default; none = no DLL', () => {
    expect(resolveFirebaseDll('Plugins/F.dll', 'Other/F.dll', dir)).toMatchObject({
      rel: 'Plugins/F.dll',
      explicit: true
    })
    expect(resolveFirebaseDll('', 'Other/F.dll', dir)?.rel).toBe('Other/F.dll')
    expect(resolveFirebaseDll(undefined, undefined, dir)).toMatchObject({
      rel: DLL,
      abs: path.join(dir, DLL),
      explicit: false
    })
    expect(resolveFirebaseDll('none', 'Other/F.dll', dir)).toBeUndefined()
    expect(resolveFirebaseDll('', 'NONE', dir)).toBeUndefined()
  })
  it.each(['../F.dll', path.resolve(os.tmpdir(), 'elsewhere.dll'), '.'])('rejects %s', raw => {
    expect(() => resolveFirebaseDll(raw, undefined, dir)).toThrow(/inside the project/)
  })
})

describe('cleanDebugView', () => {
  const dllOf = (project: string, rel = DLL, explicit = false): DllPath => ({
    rel,
    abs: path.join(project, rel),
    explicit
  })
  const leaveLeftovers = (project: string): void => {
    mkdirSync(path.join(project, DEBUG_VIEW_DIR), { recursive: true })
    writeFileSync(path.join(project, DEBUG_VIEW_DIR, 'BibgDebugView.cs'), CLIENT)
    writeFileSync(path.join(project, `${DEBUG_VIEW_DIR}.meta`), 'guid: 1')
    writeFileSync(path.join(project, `${DLL}.bibg.tmp`), 'partial')
    writeFileSync(path.join(project, DLL), Buffer.concat([ORIGINAL_DLL, Buffer.from(PATCH_MARKER)]))
  }

  it('removes the client and restores the patched DLL: the tree is clean again', async () => {
    const project = gitProject(path.join(dir, 'p'))
    leaveLeftovers(project)
    expect(status(project)).not.toBe('')
    await cleanDebugView({ projectDir: project, dll: dllOf(project), ...io() })
    expect(status(project)).toBe('')
    expect(existsSync(path.join(project, DEBUG_VIEW_DIR))).toBe(false)
    expect(readFileSync(path.join(project, DLL))).toEqual(ORIGINAL_DLL)
  })

  it('restores a deleted DLL and works from a project in a subfolder of the repository', async () => {
    const repo = gitProject(dir, {
      'Game/Assets/Firebase/Plugins/Firebase.Analytics.dll': ORIGINAL_DLL
    })
    const project = path.join(repo, 'Game')
    rmSync(path.join(project, DLL))
    await cleanDebugView({ projectDir: project, dll: dllOf(project), ...io() })
    expect(status(repo)).toBe('')
  })

  it('fails when the client folder survives the removal', async () => {
    const project = gitProject(path.join(dir, 'p'))
    leaveLeftovers(project)
    hooks.keepClient = true
    await expect(
      cleanDebugView({ projectDir: project, dll: dllOf(project), ...io() })
    ).rejects.toThrow(/Stale BIBG Debug View client: .*BibgDebugView$/)
  })

  it('fails when the DLL still differs from git after the restore', async () => {
    const project = gitProject(path.join(dir, 'p'))
    hooks.diffExit = 1
    await expect(
      cleanDebugView({ projectDir: project, dll: dllOf(project), ...io() })
    ).rejects.toThrow(/still differs from git after the restore/)
  })

  it('fails when the committed DLL itself is patched', async () => {
    const project = gitProject(path.join(dir, 'p'), {
      [DLL]: Buffer.concat([ORIGINAL_DLL, Buffer.from(PATCH_MARKER)])
    })
    await expect(
      cleanDebugView({ projectDir: project, dll: dllOf(project), ...io() })
    ).rejects.toThrow(/contains the BIBG Debug View patch/)
  })

  it('a DLL git does not track: fails when patched, warns otherwise', async () => {
    const project = gitProject(path.join(dir, 'p'), { 'Assets/F.dll': ORIGINAL_DLL })
    git(project, 'rm', '-q', '--cached', 'Assets/F.dll')
    const out = io()
    await cleanDebugView({ projectDir: project, dll: dllOf(project, 'Assets/F.dll'), ...out })
    expect(out.warn).toHaveBeenCalledWith(expect.stringMatching(/not tracked by git/))
    writeFileSync(path.join(project, 'Assets/F.dll'), PATCH_MARKER)
    await expect(
      cleanDebugView({ projectDir: project, dll: dllOf(project, 'Assets/F.dll'), ...io() })
    ).rejects.toThrow(/contains the BIBG Debug View patch/)
  })

  it("not a git repository: an existing DLL is only checked, with git's reason", async () => {
    mkdirSync(path.join(dir, path.dirname(DLL)), { recursive: true })
    writeFileSync(path.join(dir, DLL), ORIGINAL_DLL)
    const out = io()
    await cleanDebugView({ projectDir: dir, dll: dllOf(dir), ...out })
    expect(out.warn).toHaveBeenCalledWith(
      expect.stringMatching(/git cannot tell if it is tracked \(.*not a git repository/i)
    )
  })

  it('no git on the runner: says so, and still refuses a patched DLL', async () => {
    mkdirSync(path.join(dir, path.dirname(DLL)), { recursive: true })
    writeFileSync(path.join(dir, DLL), PATCH_MARKER)
    const savedPath = process.env.PATH
    process.env.PATH = path.join(dir, 'empty-bin')
    try {
      const out = io()
      await expect(cleanDebugView({ projectDir: dir, dll: dllOf(dir), ...out })).rejects.toThrow(
        /contains the BIBG Debug View patch/
      )
      expect(out.warn).toHaveBeenCalledWith(expect.stringContaining('(no git on the runner)'))
    } finally {
      process.env.PATH = savedPath
    }
  })

  it.each([
    ['another configured path', DLL],
    ['none', undefined]
  ])(
    'restores a patched Firebase.Analytics.dll elsewhere in the project (this build: %s)',
    async (_name, configured) => {
      const other = 'Assets/MyGame/Plugins/Firebase.Analytics.dll'
      const project = gitProject(path.join(dir, 'p'), { [other]: ORIGINAL_DLL })
      writeFileSync(
        path.join(project, other),
        Buffer.concat([ORIGINAL_DLL, Buffer.from(PATCH_MARKER)])
      )
      const out = io()
      await cleanDebugView({
        projectDir: project,
        dll: configured ? dllOf(project, configured) : undefined,
        ...out
      })
      expect(status(project)).toBe('')
      expect(out.log).toHaveBeenCalledWith(`${other}: held the Debug View patch, restored from git`)
    }
  )

  it('not a git repository: a patched Firebase.Analytics.dll anywhere under Assets/ still fails', async () => {
    const other = 'Assets/MyGame/Plugins/Firebase.Analytics.dll'
    mkdirSync(path.join(dir, path.dirname(other)), { recursive: true })
    writeFileSync(path.join(dir, other), Buffer.concat([ORIGINAL_DLL, Buffer.from(PATCH_MARKER)]))
    await expect(cleanDebugView({ projectDir: dir, dll: dllOf(dir), ...io() })).rejects.toThrow(
      `${other} contains the BIBG Debug View patch`
    )
    await expect(cleanDebugView({ projectDir: dir, dll: undefined, ...io() })).rejects.toThrow(
      /contains the BIBG Debug View patch/
    )
  })

  it('takes a DLL path with glob characters literally', async () => {
    const odd = 'Assets/[x]y/Firebase.Analytics.dll'
    const project = gitProject(path.join(dir, 'p'), {
      [odd]: ORIGINAL_DLL,
      'Assets/xy/Firebase.Analytics.dll': ORIGINAL_DLL
    })
    writeFileSync(path.join(project, 'Assets/xy/Firebase.Analytics.dll'), 'changed by the game')
    await cleanDebugView({ projectDir: project, dll: dllOf(project, odd), ...io() })
    // Only the configured file was checked out: the unpatched change elsewhere stays.
    expect(status(project)).toBe('M Assets/xy/Firebase.Analytics.dll')
  })

  it('not a git repository and no Firebase DLL (a game without Firebase): only removes the client', async () => {
    mkdirSync(path.join(dir, DEBUG_VIEW_DIR), { recursive: true })
    const out = io()
    await cleanDebugView({ projectDir: dir, dll: dllOf(dir), ...out })
    expect(existsSync(path.join(dir, DEBUG_VIEW_DIR))).toBe(false)
    expect(out.warn).not.toHaveBeenCalled()
    // An explicit path that is missing is worth a warning.
    await cleanDebugView({ projectDir: dir, dll: dllOf(dir, DLL, true), ...out })
    expect(out.warn).toHaveBeenCalledWith(expect.stringMatching(/does not exist/))
  })

  it('dll none: leaves a changed DLL alone', async () => {
    const project = gitProject(path.join(dir, 'p'))
    writeFileSync(path.join(project, DLL), 'changed by the game')
    await cleanDebugView({ projectDir: project, dll: undefined, ...io() })
    expect(status(project)).toBe(`M ${DLL}`)
  })
})

describe('download', () => {
  it('retries a 5xx and a network error, then returns the file', async () => {
    const f = fakeFetch({
      [CLIENT_URL]: [
        new Response('busy', { status: 503 }),
        new TypeError('fetch failed'),
        new Response(CLIENT)
      ]
    })
    const out = io()
    const text = await download(CLIENT_URL, [URL_PLACEHOLDER], {
      fetchImpl: f.impl,
      minDelay: 1,
      ...out
    })
    expect(text).toBe(CLIENT)
    expect(f.calls).toHaveLength(3)
    expect(out.warn).toHaveBeenCalledWith(expect.stringContaining('HTTP 503'))
  })

  it.each([
    ['a 404, without retrying', new Response('x', { status: 404 }), /HTTP 404/, 1],
    ['an empty file', new Response('  \n'), /is empty/, 3],
    ['another file', new Response('<html>login</html>'), /does not look like BibgDebugView\.cs/, 1]
  ])('fails on %s', async (_name, response, error, calls) => {
    const f = fakeFetch({ [CLIENT_URL]: [response] })
    await expect(
      download(CLIENT_URL, [URL_PLACEHOLDER], { fetchImpl: f.impl, minDelay: 1, ...io() })
    ).rejects.toThrow(error)
    expect(f.calls).toHaveLength(calls)
  })

  it('retries a body that breaks while it is read', async () => {
    const broken = new Response(
      new ReadableStream({
        start(c) {
          c.error(new Error('socket hang up'))
        }
      })
    )
    const f = fakeFetch({ [CLIENT_URL]: [broken, new Response(CLIENT)] })
    const out = io()
    await expect(
      download(CLIENT_URL, [URL_PLACEHOLDER], { fetchImpl: f.impl, minDelay: 1, ...out })
    ).resolves.toBe(CLIENT)
    expect(out.warn).toHaveBeenCalledWith(expect.stringContaining('failed while reading'))
  })

  it('fails when a redirect left https', async () => {
    const res = new Response(CLIENT)
    Object.defineProperty(res, 'url', { value: 'http://bi.example.org/x' })
    const impl = (async () => res) as unknown as typeof fetch
    await expect(
      download(CLIENT_URL, [URL_PLACEHOLDER], { fetchImpl: impl, minDelay: 1, ...io() })
    ).rejects.toThrow(/redirected off https/)
  })
})

describe('injectClient', () => {
  it('writes the filled client into Assets/BibgDebugView', async () => {
    const f = fakeFetch({ [CLIENT_URL]: [new Response(CLIENT)] })
    const file = await injectClient({
      projectDir: dir,
      baseUrl: BASE,
      label: 'main@abc1234 #9',
      fetchImpl: f.impl,
      ...io()
    })
    expect(file).toBe(path.join(dir, DEBUG_VIEW_DIR, 'BibgDebugView.cs'))
    const code = readFileSync(file, 'utf8')
    expect(code).toContain(`InjectedUrl = "${BASE}"`)
    expect(code).toContain('InjectedBuild = "main@abc1234 #9"')
  })

  it('writes nothing when the download is not the client', async () => {
    const f = fakeFetch({ [CLIENT_URL]: [new Response('class Other {}')] })
    await expect(
      injectClient({ projectDir: dir, baseUrl: BASE, label: 'l', fetchImpl: f.impl, ...io() })
    ).rejects.toThrow(/does not look like/)
    expect(existsSync(path.join(dir, DEBUG_VIEW_DIR))).toBe(false)
  })
})

describe('patchFirebaseDll', () => {
  let project: string
  let dotnet: string
  let calls: string
  const savedEnv = { ...process.env }
  beforeEach(() => {
    project = gitProject(path.join(dir, 'p'))
    const bin = path.join(dir, 'bin')
    mkdirSync(bin)
    dotnet = fakeDotnet(bin)
    calls = path.join(dir, 'dotnet.log')
    process.env.FAKE_DOTNET_CALLS = calls
  })
  afterEach(() => {
    process.env = { ...savedEnv }
  })
  const patch = async (
    extra: Partial<Parameters<typeof patchFirebaseDll>[0]> = {}
  ): Promise<void> =>
    patchFirebaseDll({
      projectDir: project,
      dll: { rel: DLL, abs: path.join(project, DLL), explicit: false },
      baseUrl: BASE,
      toolDir: path.join(dir, 'tmp', 'bibg-fbpatch'),
      dotnet,
      fetchImpl: fakeFetch({ [TOOL_URL]: [new Response(TOOL)] }).impl,
      retryDelay: 1,
      ...io(),
      ...extra
    })

  it('downloads the tool outside Assets/ and runs it on the DLL', async () => {
    await patch()
    expect(readFileSync(path.join(project, DLL)).includes(PATCH_MARKER)).toBe(true)
    const tool = path.join(dir, 'tmp', 'bibg-fbpatch', 'BibgFirebasePatch.cs')
    expect(readFileSync(tool, 'utf8')).toBe(TOOL)
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toEqual([
      '--list-sdks',
      `run --file ${tool} -- ${path.join(project, DLL)}`
    ])
  })

  it('fails on a missing DLL and says how to use the LogBridge fallback', async () => {
    rmSync(path.join(project, DLL))
    await expect(patch()).rejects.toThrow(
      /Missing .*Firebase\.Analytics\.dll: .*or none to use the LogBridge fallback/
    )
    expect(existsSync(calls)).toBe(false)
  })

  it('fails on a DLL git does not track (it could not be restored)', async () => {
    git(project, 'rm', '-q', '--cached', DLL)
    await expect(patch()).rejects.toThrow(
      /: not tracked by git, so the patched DLL could not be restored/
    )
  })

  it('fails without dotnet, or without a .NET 10 SDK, and names setup-dotnet', async () => {
    await expect(patch({ dotnet: path.join(dir, 'no-such-dotnet') })).rejects.toThrow(
      /needs the \.NET 10 SDK: add actions\/setup-dotnet/
    )
    process.env.FAKE_DOTNET_SDKS = '8.0.400 [/x]\n9.0.100 [/x]'
    await expect(patch()).rejects.toThrow(/Installed SDKs: 8\.0\.400 \[\/x\], 9\.0\.100 \[\/x\]/)
  })

  it('fails when the tool fails or leaves the DLL unpatched', async () => {
    process.env.FAKE_DOTNET_MODE = 'fail'
    await expect(patch()).rejects.toThrow(/Firebase patch failed \(exit code 1\)/)
    process.env.FAKE_DOTNET_MODE = 'noop'
    await expect(patch()).rejects.toThrow(/exited 0 but .* has no BibgDebugViewHooks/)
  })

  it('only patches a file named Firebase.Analytics.dll (the cleanup finds it by that name)', async () => {
    await expect(
      patch({
        dll: { rel: 'Assets/F.dll', abs: path.join(project, 'Assets/F.dll'), explicit: true }
      })
    ).rejects.toThrow(/must be a Firebase\.Analytics\.dll/)
  })

  it('refuses a tool folder under Assets/', async () => {
    await expect(patch({ toolDir: path.join(project, 'Assets', 'tool') })).rejects.toThrow(
      /must not go under Assets/
    )
  })
})
