import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateRawSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  PINNED_BUNDLETOOL,
  bundletoolUrl,
  ensureBundletool,
  type Fetch
} from '../src/bundletool.js'
import { findJava, unityJava } from '../src/java.js'
import { bundletoolArgs, bundletoolRelease, convert, defaultOutput, run } from '../src/main.js'
import { extractZipEntry, listZip } from '../src/zip.js'

// run() calls bundletool through the sdk's exec: replaced here, convert() tests pass their own.
const execMock = vi.hoisted(() => vi.fn())
vi.mock('../../sdk/src/index.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../sdk/src/index.js')>()),
  exec: execMock
}))

// keytool -genkeypair -storetype PKCS12 -alias my-game -keystore My-Game.keystore -storepass My-Game
const KEYSTORE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../sdk/__tests__/fixtures/My-Game.keystore'
)
const SETTINGS =
  "PlayerSettings:\r\n  AndroidKeystoreName: '{inproject}: My-Game.keystore'\r\n  AndroidKeyaliasName: my-game\r\n"

/** A minimal zip: entries stored (method 0) or deflated (method 8). */
function makeZip(entries: { name: string; data: Buffer; method?: 0 | 8 }[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const method = e.method ?? 8
    const body = method === 8 ? deflateRawSync(e.data) : e.data
    const name = Buffer.from(e.name, 'utf8')
    const crc = crc32(e.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(e.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(e.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, name, body)
    centrals.push(central, name)
    offset += local.length + name.length + body.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}

let temp: string
beforeEach(async () => {
  temp = await mkdtemp(path.join(os.tmpdir(), 'aab-to-apk-'))
})
afterEach(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  await rm(temp, { recursive: true, force: true })
})

describe('findJava', () => {
  const base = {
    javaPath: undefined,
    javaHome: undefined,
    editorPath: undefined,
    platform: 'win32' as NodeJS.Platform
  }
  const editor = 'C:\\Unity\\6000.0.58f2\\Editor\\Unity.exe'
  const editorJava =
    'C:\\Unity\\6000.0.58f2\\Editor\\Data\\PlaybackEngines\\AndroidPlayer\\OpenJDK\\bin\\java.exe'

  it('java-path first, even when the others exist', () => {
    expect(
      findJava({
        ...base,
        javaPath: 'D:\\jdk\\bin\\java.exe',
        javaHome: 'C:\\jdk17',
        editorPath: editor,
        exists: () => true
      })
    ).toEqual({ path: 'D:\\jdk\\bin\\java.exe', source: 'java-path' })
  })

  it('a java-path that does not exist is an error, not a fallback', () => {
    expect(() =>
      findJava({
        ...base,
        javaPath: 'D:\\nope\\java.exe',
        javaHome: 'C:\\jdk17',
        exists: f => f !== 'D:\\nope\\java.exe'
      })
    ).toThrow(/java-path does not exist/)
  })

  it('then JAVA_HOME/bin/java', () => {
    expect(
      findJava({ ...base, javaHome: 'C:\\jdk17', editorPath: editor, exists: () => true })
    ).toEqual({ path: 'C:\\jdk17\\bin\\java.exe', source: 'JAVA_HOME' })
  })

  it('then the OpenJDK of the Unity editor when JAVA_HOME has no java', () => {
    expect(
      findJava({
        ...base,
        javaHome: 'C:\\broken',
        editorPath: editor,
        exists: f => f === editorJava
      })
    ).toEqual({ path: editorJava, source: 'unity-editor' })
  })

  it('then java on PATH', () => {
    expect(
      findJava({ ...base, javaHome: 'C:\\broken', editorPath: editor, exists: () => false })
    ).toEqual({ path: 'java', source: 'PATH' })
    expect(findJava({ ...base, exists: () => true })).toEqual({ path: 'java', source: 'PATH' })
  })

  it('Unity OpenJDK per platform', () => {
    expect(unityJava(editor, 'win32')).toBe(editorJava)
    expect(unityJava('/opt/unity/Editor/Unity', 'linux')).toBe(
      '/opt/unity/Editor/Data/PlaybackEngines/AndroidPlayer/OpenJDK/bin/java'
    )
    expect(unityJava('/Applications/Unity/Unity.app/Contents/MacOS/Unity', 'darwin')).toBe(
      '/Applications/Unity/Unity.app/Contents/PlaybackEngines/AndroidPlayer/OpenJDK/bin/java'
    )
  })
})

describe('ensureBundletool', () => {
  const jarBytes = Buffer.from('fake bundletool jar')
  const jarSha = createHash('sha256').update(jarBytes).digest('hex')
  const fakeFetch = (body: Buffer, status = 200): Mock<Fetch> =>
    vi.fn<Fetch>(async () => Promise.resolve(new Response(new Uint8Array(body), { status })))

  it('downloads once, checks the sha256 and reuses the cache', async () => {
    const fetchImpl = fakeFetch(jarBytes)
    const jar = await ensureBundletool({
      version: '9.9.9',
      sha256: jarSha,
      toolCache: temp,
      fetchImpl
    })
    expect(jar).toBe(path.join(temp, 'bundletool', '9.9.9', 'bundletool-all-9.9.9.jar'))
    expect(await readFile(jar)).toEqual(jarBytes)
    expect(fetchImpl).toHaveBeenCalledWith(bundletoolUrl('9.9.9'), expect.anything())
    await ensureBundletool({
      version: '9.9.9',
      sha256: jarSha.toUpperCase(),
      toolCache: temp,
      fetchImpl
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('a download with the wrong sha256 fails and is not cached', async () => {
    const fetchImpl = fakeFetch(Buffer.from('tampered'))
    await expect(
      ensureBundletool({ version: '9.9.9', sha256: jarSha, toolCache: temp, fetchImpl })
    ).rejects.toThrow(/sha256 mismatch: expected [0-9a-f]{64}, got [0-9a-f]{64}/)
    expect(existsSync(path.join(temp, 'bundletool', '9.9.9'))).toBe(false)
  })

  it('a changed cached jar is downloaded again', async () => {
    const dir = path.join(temp, 'bundletool', '9.9.9')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'bundletool-all-9.9.9.jar'), 'changed on the runner')
    const fetchImpl = fakeFetch(jarBytes)
    const log = vi.fn()
    const jar = await ensureBundletool({
      version: '9.9.9',
      sha256: jarSha,
      toolCache: temp,
      fetchImpl,
      log
    })
    expect(await readFile(jar)).toEqual(jarBytes)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/does not match its sha256/))
  })

  it('an HTTP error names the URL', async () => {
    await expect(
      ensureBundletool({
        version: '9.9.9',
        sha256: jarSha,
        toolCache: temp,
        fetchImpl: fakeFetch(Buffer.from('not found'), 404)
      })
    ).rejects.toThrow(/download failed: 404 https:\/\/github.com\/google\/bundletool/)
  })

  it('a body that stalls past the timeout is a clear E_BUNDLETOOL error', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new DOMException('The operation timed out', 'TimeoutError'))
            }
          }),
          { status: 200 }
        )
    )
    await expect(
      ensureBundletool({ version: '9.9.9', sha256: jarSha, toolCache: temp, fetchImpl })
    ).rejects.toMatchObject({
      code: 'E_BUNDLETOOL',
      message: expect.stringContaining('download timed out after 5 minutes') as string
    })
  })

  it('a timed-out download is a clear E_BUNDLETOOL error', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException('The operation timed out', 'TimeoutError')
    })
    await expect(
      ensureBundletool({ version: '9.9.9', sha256: jarSha, toolCache: temp, fetchImpl })
    ).rejects.toMatchObject({
      code: 'E_BUNDLETOOL',
      message: expect.stringContaining('download timed out after 5 minutes') as string
    })
  })
})

describe('bundletoolRelease', () => {
  it('the pinned release by default', () => {
    expect(bundletoolRelease('', '')).toEqual(PINNED_BUNDLETOOL)
    expect(bundletoolRelease(PINNED_BUNDLETOOL.version, '')).toEqual(PINNED_BUNDLETOOL)
  })
  it('another version needs its sha256', () => {
    expect(() => bundletoolRelease('1.17.2', '')).toThrow(/bundletool-sha256/)
    expect(bundletoolRelease('1.17.2', 'A'.repeat(64))).toEqual({
      version: '1.17.2',
      sha256: 'a'.repeat(64)
    })
    expect(() => bundletoolRelease('1.17.2', 'xyz')).toThrow(/64 hex/)
  })
})

describe('zip', () => {
  const apk = Buffer.from('PK fake apk '.repeat(5000))

  it('lists and extracts deflated and stored entries, checking the CRC', async () => {
    const zip = path.join(temp, 'a.apks')
    await writeFile(
      zip,
      makeZip([
        { name: 'toc.pb', data: Buffer.from('toc'), method: 0 },
        { name: 'universal.apk', data: apk },
        { name: 'empty', data: Buffer.alloc(0), method: 0 }
      ])
    )
    expect(await listZip(zip)).toEqual(['toc.pb', 'universal.apk', 'empty'])
    const out = path.join(temp, 'out.apk')
    expect(await extractZipEntry(zip, 'universal.apk', out)).toBe(apk.length)
    expect(await readFile(out)).toEqual(apk)
    await extractZipEntry(zip, 'toc.pb', out)
    expect(await readFile(out, 'utf8')).toBe('toc')
    await extractZipEntry(zip, 'empty', out)
    expect((await readFile(out)).length).toBe(0)
  })

  it('a corrupt entry fails and leaves no partial file', async () => {
    const bytes = makeZip([{ name: 'universal.apk', data: apk, method: 0 }])
    const at = 30 + 'universal.apk'.length + 10
    bytes.writeUInt8(bytes.readUInt8(at) ^ 0xff, at)
    const zip = path.join(temp, 'bad.apks')
    await writeFile(zip, bytes)
    const out = path.join(temp, 'out.apk')
    await expect(extractZipEntry(zip, 'universal.apk', out)).rejects.toThrow(/CRC-32 mismatch/)
    expect(existsSync(out)).toBe(false)
  })

  it('missing entry, not a zip', async () => {
    const zip = path.join(temp, 'a.apks')
    await writeFile(zip, makeZip([{ name: 'toc.pb', data: Buffer.from('toc') }]))
    await expect(extractZipEntry(zip, 'universal.apk', path.join(temp, 'x'))).rejects.toThrow(
      /has no universal.apk/
    )
    const notZip = path.join(temp, 'b.apks')
    await writeFile(notZip, 'hello')
    await expect(listZip(notZip)).rejects.toThrow(/not a zip/)
  })
})

describe('convert', () => {
  const signing = {
    path: 'C:\\keys\\My-Game.keystore',
    alias: 'my-game',
    password: 'S3cret-store',
    aliasPassword: 'S3cret-key'
  }

  it('runs build-apks universal with password files and extracts universal.apk', async () => {
    const apk = Buffer.from('universal apk bytes')
    let seen: { command: string; args: string[]; passwords: string[] } | undefined
    const fakeExec = vi.fn(
      async (command: string, args: readonly string[] = [], _options?: unknown) => {
        const value = (flag: string): string =>
          args.find(a => a.startsWith(flag))!.slice(flag.length)
        seen = {
          command,
          args: [...args],
          passwords: [
            await readFile(value('--ks-pass=file:'), 'utf8'),
            await readFile(value('--key-pass=file:'), 'utf8')
          ]
        }
        await writeFile(
          value('--output='),
          makeZip([
            { name: 'toc.pb', data: Buffer.from('t') },
            { name: 'universal.apk', data: apk }
          ])
        )
        return { command, exitCode: 0, signal: null, stdout: '', stderr: '', durationMs: 1 }
      }
    )
    const output = path.join(temp, 'out', 'game.apk')
    const result = await convert({
      aab: path.join(temp, 'game.aab'),
      output,
      java: 'java',
      jar: 'bundletool.jar',
      signing,
      workDir: path.join(temp, 'work'),
      timeout: '20m',
      exec: fakeExec
    })
    expect(result).toEqual({ apk: output, size: apk.length })
    expect(await readFile(output)).toEqual(apk)
    expect(seen!.command).toBe('java')
    expect(seen!.args.slice(0, 3)).toEqual(['-jar', 'bundletool.jar', 'build-apks'])
    expect(seen!.args).toEqual(
      expect.arrayContaining([
        `--bundle=${path.join(temp, 'game.aab')}`,
        '--mode=universal',
        '--overwrite',
        `--ks=${signing.path}`,
        '--ks-key-alias=my-game'
      ])
    )
    expect(seen!.passwords).toEqual(['S3cret-store', 'S3cret-key'])
    expect(seen!.args.join(' ')).not.toMatch(/S3cret/)
    expect(fakeExec.mock.calls[0]![2]).toEqual({ timeout: '20m' })
    // The .apks and the password files are gone.
    expect(await readdir(path.join(temp, 'work'))).toEqual([])
  })

  it('cleans up when bundletool fails', async () => {
    const fakeExec = vi.fn(async () => Promise.reject(new Error('bundletool exited 1')))
    await expect(
      convert({
        aab: 'game.aab',
        output: path.join(temp, 'game.apk'),
        java: 'java',
        jar: 'bundletool.jar',
        signing,
        workDir: path.join(temp, 'work'),
        timeout: 0,
        exec: fakeExec
      })
    ).rejects.toThrow(/exited 1/)
    expect(await readdir(path.join(temp, 'work'))).toEqual([])
    expect(existsSync(path.join(temp, 'game.apk'))).toBe(false)
  })

  it('no signing flags for the debug key; output next to the aab by default', () => {
    expect(bundletoolArgs({ aab: 'a.aab', jar: 'b.jar' }, 'x.apks').join(' ')).not.toMatch(/--ks/)
    expect(defaultOutput(path.join('Builds', 'Game_release_v1.0.2.aab'))).toBe(
      path.join('Builds', 'Game_release_v1.0.2.apk')
    )
  })
})

describe('run', () => {
  let project: string
  let aab: string

  async function call(inputs: Record<string, string>): Promise<void> {
    const all: Record<string, string> = {
      aab,
      output: '',
      'project-path': project,
      signing: 'release',
      'keystore-base64': '',
      'keystore-password': '',
      'keystore-alias': '',
      'keystore-alias-password': '',
      'java-path': '',
      'editor-path': '',
      'bundletool-version': '',
      'bundletool-sha256': '',
      timeout: '20m',
      ...inputs
    }
    for (const [key, value] of Object.entries(all)) vi.stubEnv(`INPUT_${key.toUpperCase()}`, value)
    await run()
  }

  beforeEach(async () => {
    project = path.join(temp, 'project')
    await mkdir(path.join(project, 'ProjectSettings'), { recursive: true })
    await writeFile(path.join(project, 'ProjectSettings', 'ProjectSettings.asset'), SETTINGS)
    aab = path.join(temp, 'game.aab')
    await writeFile(aab, 'aab')
    vi.stubEnv('RUNNER_TEMP', path.join(temp, 'runner-temp'))
    vi.stubEnv('RUNNER_TOOL_CACHE', path.join(temp, 'tool-cache'))
    vi.stubEnv('GITHUB_OUTPUT', path.join(temp, 'output'))
    await writeFile(path.join(temp, 'output'), '')
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  })

  it('no keystore fails before downloading anything', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    await expect(call({})).rejects.toThrow(/My-Game.keystore, which does not exist/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('a partial secret set names the missing ones', async () => {
    await copyFile(KEYSTORE, path.join(project, 'My-Game.keystore'))
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    await expect(call({ 'keystore-password': 'x', 'keystore-alias': 'y' })).rejects.toThrow(
      /keystore-base64[\s\S]*keystore-alias-password/
    )
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('keystore inputs: a temp keystore, passwords never in argv, removed on success and failure', async () => {
    // A cached "bundletool" with its sha256: nothing is downloaded.
    const jar = Buffer.from('not really bundletool')
    const sha = createHash('sha256').update(jar).digest('hex')
    const jarPath = path.join(temp, 'tool-cache', 'bundletool', '9.9.9', 'bundletool-all-9.9.9.jar')
    await mkdir(path.dirname(jarPath), { recursive: true })
    await writeFile(jarPath, jar)
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const keys = path.join(temp, 'runner-temp', 'ci-sdk-aab-to-apk', 'keys')
    const left = async (): Promise<string[]> => (existsSync(keys) ? readdir(keys) : [])
    const calls: string[][] = []
    execMock.mockImplementation(async (_java: string, args: string[]) => {
      calls.push(args)
      const ks = args.find(a => a.startsWith('--ks='))!.slice('--ks='.length)
      expect(existsSync(ks)).toBe(true)
      const apks = args.find(a => a.startsWith('--output='))!.slice('--output='.length)
      await writeFile(apks, makeZip([{ name: 'universal.apk', data: Buffer.from('apk') }]))
      return { exitCode: 0, stdout: '', stderr: '' }
    })
    const inputs = {
      'keystore-base64': (await readFile(KEYSTORE)).toString('base64'),
      'keystore-password': 'My-Game',
      'keystore-alias': 'my-game',
      'keystore-alias-password': 'My-Game',
      'java-path': process.execPath,
      'bundletool-version': '9.9.9',
      'bundletool-sha256': sha
    }

    await call(inputs)
    expect(await readFile(path.join(temp, 'game.apk'), 'utf8')).toBe('apk')
    expect(fetchSpy).not.toHaveBeenCalled()
    const [args] = calls
    expect(args!.slice(0, 2)).toEqual(['-jar', jarPath])
    expect(args!.some(a => a.endsWith('My-Game') && !a.startsWith('--ks-key-alias'))).toBe(false)
    expect(args).toContainEqual(expect.stringMatching(/^--ks-pass=file:/))
    expect(
      args!
        .find(a => a.startsWith('--ks='))!
        .slice('--ks='.length)
        .startsWith(keys)
    ).toBe(true)
    expect(await left()).toEqual([])

    execMock.mockRejectedValueOnce(new Error('bundletool exited with 1'))
    await expect(call(inputs)).rejects.toThrow(/bundletool exited with 1/)
    expect(await left()).toEqual([])
    expect(await readdir(path.join(temp, 'runner-temp', 'ci-sdk-aab-to-apk'))).toEqual(['keys'])
  })

  it('a missing aab, a bad signing value, an unpinned bundletool without sha256', async () => {
    await expect(call({ aab: path.join(temp, 'nope.aab') })).rejects.toThrow(/No AAB at/)
    await expect(call({ signing: 'store' })).rejects.toThrow(/release, debug/)
    await expect(call({ 'bundletool-version': '1.17.2' })).rejects.toThrow(/bundletool-sha256/)
    await expect(call({ output: aab })).rejects.toThrow(/must not be the .aab/)
  })
})
