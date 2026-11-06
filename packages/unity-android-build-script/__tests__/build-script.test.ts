import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { crc32 } from 'node:zlib'
import { parseAssemblies, run } from '../src/main.js'
import { OBFUSCAR_ENTRY, ensureObfuscar, obfuscarUrl } from '../src/obfuscar.js'
import {
  OBFUSCAR_DIR,
  PROJECT_SETTINGS,
  applyPatch,
  obfuscarExeRelative,
  removeStale,
  restorePatch
} from '../src/patch.js'
import {
  ASMDEF_FILE,
  EXECUTE_METHOD,
  GENERATED_DIR,
  SCRIPT_FILE,
  buildScriptSource,
  csLiteral,
  csStringArray,
  type BuildScriptOptions
} from '../src/script.js'
import { MAX_VERSION_CODE, parseReleaseVersion, parseVersionCode } from '../src/version.js'

/** A minimal stored (uncompressed) zip, enough to stand in for an Obfuscar nupkg. */
function makeZip(entries: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8')
    const crc = crc32(e.data)
    const body = e.data
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(e.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 10)
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

// keytool -genkeypair -storetype PKCS12 -alias my-game -keystore My-Game.keystore -storepass My-Game
const KEYSTORE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../sdk/__tests__/fixtures/My-Game.keystore'
)
const SETTINGS = Buffer.from(
  "PlayerSettings:\r\n  bundleVersion: 1.0.1\r\n  AndroidBundleVersionCode: 1\r\n  AndroidKeystoreName: '{inproject}: My-Game.keystore'\r\n  AndroidKeyaliasName: my-game\r\n",
  'utf8'
)

describe('parseReleaseVersion', () => {
  it.each([
    ['v1.0.2', '1.0.2', 10002],
    ['1.2.3', '1.2.3', 10203],
    [' v0.0.1 ', '0.0.1', 1],
    ['v12.99.99', '12.99.99', 129999],
    ['v2.0.0', '2.0.0', 20000]
  ])('%j -> %s (%d)', (raw, name, code) => {
    expect(parseReleaseVersion(raw)).toEqual({ name, code })
  })

  it('always grows with the version', () => {
    const order = ['v1.0.9', 'v1.0.10', 'v1.1.0', 'v1.99.99', 'v2.0.0']
    const codes = order.map(v => parseReleaseVersion(v).code)
    expect([...codes].sort((a, b) => a - b)).toEqual(codes)
  })

  it.each([
    ['v1.0', /not a release version/],
    ['v1.0.2-rc1', /not a release version/],
    ['v1.0.2+build', /not a release version/],
    ['v01.0.0', /not a release version/],
    ['V1.0.0', /not a release version/],
    ['release-1', /not a release version/],
    ['', /not a release version/],
    ['v1.100.0', /below 100/],
    ['v1.0.100', /below 100/],
    ['v0.0.0', /outside 1\.\./],
    ['v210001.0.0', /outside 1\.\./]
  ])('rejects %j', (raw, message) => {
    expect(() => parseReleaseVersion(raw)).toThrow(message)
  })
})

describe('parseVersionCode', () => {
  it('accepts a whole number in range', () => {
    expect(parseVersionCode('42')).toBe(42)
    expect(parseVersionCode(String(MAX_VERSION_CODE))).toBe(MAX_VERSION_CODE)
  })
  it.each(['0', '-1', '1.5', 'abc', '007', String(MAX_VERSION_CODE + 1)])('rejects %j', raw => {
    expect(() => parseVersionCode(raw)).toThrow(/whole number/)
  })
})

describe('generated script', () => {
  const base: BuildScriptOptions = {
    format: 'aab',
    output: 'Builds/release.aab',
    versionName: '1.0.2',
    versionCode: 10002,
    development: false,
    releaseSigning: true,
    keystore: {
      path: 'My-Game.keystore',
      password: 'My-Game',
      alias: 'my-game',
      aliasPassword: 'My-Game'
    },
    scriptingBackend: '',
    il2cppConfiguration: 'release',
    obfuscate: { mode: 'off', assemblies: ['Assembly-CSharp'], exe: null, config: null }
  }

  it('bakes the build settings and the conventional keystore', () => {
    const src = buildScriptSource(base)
    expect(src).toContain('AppBundle = true;')
    expect(src).toContain('Output = "Builds/release.aab";')
    expect(src).toContain('VersionName = "1.0.2";')
    expect(src).toContain('VersionCode = 10002;')
    expect(src).toContain('Development = false;')
    expect(src).toContain('KeystorePass = "My-Game";')
    expect(src).toContain('EditorApplication.Exit(1)')
    expect(src).toContain('options = Development ? BuildOptions.Development : BuildOptions.None')
  })

  it('never bakes values that came from secrets', () => {
    const src = buildScriptSource({
      ...base,
      keystore: { path: 'C:\\temp\\k.keystore', password: null, alias: null, aliasPassword: null }
    })
    expect(src).toContain('KeystorePath = "C:\\\\temp\\\\k.keystore";')
    expect(src).toContain('KeystorePass = null;')
    expect(src).toContain('KeyaliasName = null;')
    expect(src).toContain('KeyaliasPass = null;')
  })

  it('builds an APK too', () => {
    expect(buildScriptSource({ ...base, format: 'apk', development: true })).toContain(
      'AppBundle = false;'
    )
  })

  it('escapes C# strings and refuses control characters', () => {
    expect(csLiteral('a"b\\c')).toBe('"a\\"b\\\\c"')
    expect(csLiteral(null)).toBe('null')
    expect(() => csLiteral('a\nb')).toThrow(/control characters/)
  })

  it('builds a C# string array literal', () => {
    expect(csStringArray(['A', 'B.c'])).toBe('new string[] { "A", "B.c" }')
  })

  it('keeps the project scripting backend and emits no obfuscation hook by default', () => {
    const src = buildScriptSource(base)
    expect(src).toContain('ScriptingBackend = "";')
    expect(src).not.toContain('CiSdkObfuscate')
  })

  it('forces IL2CPP with the chosen compiler configuration and ensures ARM64', () => {
    const src = buildScriptSource({
      ...base,
      scriptingBackend: 'il2cpp',
      il2cppConfiguration: 'master'
    })
    expect(src).toContain('ScriptingBackend = "il2cpp";')
    expect(src).toContain(
      'SetScriptingBackend(BuildTargetGroup.Android, ScriptingImplementation.IL2CPP)'
    )
    expect(src).toContain(
      'SetIl2CppCompilerConfiguration(BuildTargetGroup.Android, Il2CppCompilerConfiguration.Master)'
    )
    expect(src).toContain('AndroidArchitecture.ARM64')
    // Always restored.
    expect(src).toContain(
      'PlayerSettings.SetScriptingBackend(BuildTargetGroup.Android, oldBackend)'
    )
  })

  it('emits the obfuscation hook with the baked mode, assemblies and paths (full)', () => {
    const src = buildScriptSource({
      ...base,
      obfuscate: {
        mode: 'full',
        assemblies: ['Assembly-CSharp', 'Game.Core'],
        exe: obfuscarExeRelative,
        config: 'obf/rules.xml'
      }
    })
    expect(src).toContain('class CiSdkObfuscate : UnityEditor.Build.IPostBuildPlayerScriptDLLs')
    expect(src).toContain('Mode = "full";')
    expect(src).toContain('ExeRelative = ".ci-sdk-obfuscar/Obfuscar.Console.exe";')
    expect(src).toContain('ExtraRulesRelative = "obf/rules.xml";')
    expect(src).toContain('Assemblies = new string[] { "Assembly-CSharp", "Game.Core" };')
    expect(src).toContain('RiskyTypeNames')
    // A risky type keeps its members too, not only its name.
    for (const attr of ['skipMethods', 'skipFields', 'skipProperties', 'skipEvents']) {
      expect(src).toContain(`Attr("${attr}", "true")`)
    }
    // The generated C# must have no stray backslash outside escaped C# string literals.
    const hook = src.slice(src.indexOf('class CiSdkObfuscate'))
    expect(hook.includes('\\')).toBe(false)
  })

  it('emits the hook in strings mode with no extra-rules path', () => {
    const src = buildScriptSource({
      ...base,
      obfuscate: {
        mode: 'strings',
        assemblies: ['Assembly-CSharp'],
        exe: obfuscarExeRelative,
        config: null
      }
    })
    expect(src).toContain('Mode = "strings";')
    expect(src).toContain('ExtraRulesRelative = null;')
  })
})

describe('parseAssemblies', () => {
  it('splits, trims, strips .dll and dedups', () => {
    expect(parseAssemblies('Assembly-CSharp')).toEqual(['Assembly-CSharp'])
    expect(parseAssemblies('A.dll, B\nA')).toEqual(['A', 'B'])
    expect(parseAssemblies(' Game.Core.DLL ')).toEqual(['Game.Core'])
  })

  it('rejects an empty list and path separators', () => {
    expect(() => parseAssemblies('   ')).toThrow(/at least one/)
    expect(() => parseAssemblies('a/b')).toThrow(/path separator/)
    expect(() => parseAssemblies('a\\b')).toThrow(/path separator/)
  })
})

let root: string
let temp: string
let stateFile: string
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'ci-sdk-build-script-'))
  temp = await mkdtemp(path.join(os.tmpdir(), 'ci-sdk-build-script-temp-'))
  stateFile = path.join(temp, 'work', 'state.json')
  await mkdir(path.join(root, 'Assets'), { recursive: true })
  await mkdir(path.join(root, 'ProjectSettings'), { recursive: true })
  await writeFile(path.join(root, PROJECT_SETTINGS), SETTINGS)
})
afterEach(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
  await rm(temp, { recursive: true, force: true })
})

const script: BuildScriptOptions = {
  format: 'aab',
  output: 'Builds/release.aab',
  versionName: '',
  versionCode: 0,
  development: false,
  releaseSigning: false,
  keystore: { path: null, password: null, alias: null, aliasPassword: null },
  scriptingBackend: '',
  il2cppConfiguration: 'release',
  obfuscate: { mode: 'off', assemblies: ['Assembly-CSharp'], exe: null, config: null }
}

describe('apply / restore', () => {
  it('adds the script, then restores every byte and removes it with its meta files', async () => {
    const patched = await applyPatch({
      projectRoot: root,
      stateFile,
      script,
      writtenKeystore: undefined
    })
    expect(patched).toEqual([
      `${GENERATED_DIR}/${SCRIPT_FILE}`,
      `${GENERATED_DIR}/${ASMDEF_FILE}`,
      PROJECT_SETTINGS
    ])
    expect(await readFile(path.join(root, GENERATED_DIR, ASMDEF_FILE), 'utf8')).toContain(
      '"includePlatforms": [\n        "Editor"'
    )
    // What Unity does during the build: rewrites the settings (LF) and creates meta files.
    await writeFile(path.join(root, PROJECT_SETTINGS), 'PlayerSettings:\n  bundleVersion: 9.9.9\n')
    await writeFile(path.join(root, `${GENERATED_DIR}.meta`), 'guid: 1')
    await writeFile(path.join(root, GENERATED_DIR, `${SCRIPT_FILE}.meta`), 'guid: 2')

    expect(await restorePatch(stateFile)).toBe(true)
    expect(await readFile(path.join(root, PROJECT_SETTINGS))).toEqual(SETTINGS)
    expect(existsSync(path.join(root, GENERATED_DIR))).toBe(false)
    expect(existsSync(path.join(root, `${GENERATED_DIR}.meta`))).toBe(false)
    expect(existsSync(stateFile)).toBe(false)
    expect(await readdir(path.join(root, 'Assets'))).toEqual([])
  })

  it('deletes the written keystore on restore', async () => {
    const key = path.join(temp, 'k.keystore')
    await writeFile(key, 'x')
    await applyPatch({ projectRoot: root, stateFile, script, writtenKeystore: key })
    await restorePatch(stateFile)
    expect(existsSync(key)).toBe(false)
  })

  it('a failed project restore still deletes the keystore and keeps the state', async () => {
    const key = path.join(temp, 'k.keystore')
    await writeFile(key, 'x')
    await applyPatch({ projectRoot: root, stateFile, script, writtenKeystore: key })
    // Writing the saved settings back fails: the path is now a folder.
    await rm(path.join(root, PROJECT_SETTINGS))
    await mkdir(path.join(root, PROJECT_SETTINGS))
    await expect(restorePatch(stateFile)).rejects.toThrow(/ProjectSettings/)
    expect(existsSync(key)).toBe(false)
    expect(existsSync(stateFile)).toBe(true)
  })

  it('when both fail, the project error is thrown with the keystore error added', async () => {
    // A folder: deleting it without recursive fails.
    const key = path.join(temp, 'k.keystore')
    await mkdir(key)
    await applyPatch({ projectRoot: root, stateFile, script, writtenKeystore: key })
    await rm(path.join(root, PROJECT_SETTINGS))
    await mkdir(path.join(root, PROJECT_SETTINGS))
    await expect(restorePatch(stateFile)).rejects.toThrow(
      /ProjectSettings.*; the keystore was not deleted either: /s
    )
    expect(existsSync(stateFile)).toBe(true)
  })

  it('refuses to overwrite a folder that is not ours', async () => {
    await mkdir(path.join(root, GENERATED_DIR))
    await writeFile(path.join(root, GENERATED_DIR, 'Mine.cs'), 'class Mine {}')
    await expect(
      applyPatch({ projectRoot: root, stateFile, script, writtenKeystore: undefined })
    ).rejects.toThrow(/not generated by ci-sdk/)
    expect(existsSync(stateFile)).toBe(false)
  })

  it('replaces a leftover of ours', async () => {
    await applyPatch({ projectRoot: root, stateFile, script, writtenKeystore: undefined })
    await rm(stateFile)
    await applyPatch({ projectRoot: root, stateFile, script, writtenKeystore: undefined })
    expect(await restorePatch(stateFile)).toBe(true)
    expect(existsSync(path.join(root, GENERATED_DIR))).toBe(false)
  })

  it('without a state removes our leftover folder and stray keystores only', async () => {
    await applyPatch({ projectRoot: root, stateFile, script, writtenKeystore: undefined })
    await rm(stateFile)
    const keys = path.join(temp, 'keys')
    await mkdir(keys)
    await writeFile(path.join(keys, 'a.keystore'), 'x')
    expect(await removeStale(root, keys)).toEqual([GENERATED_DIR, 'keystore a.keystore'])
    expect(existsSync(path.join(root, GENERATED_DIR))).toBe(false)
    expect(await readdir(keys)).toEqual([])
    expect(await removeStale(root, keys)).toEqual([])
  })

  it('drops an unreadable state', async () => {
    await mkdir(path.dirname(stateFile), { recursive: true })
    await writeFile(stateFile, '{"version": 1, "ro')
    expect(await restorePatch(stateFile)).toBe(false)
    expect(existsSync(stateFile)).toBe(false)
  })
})

describe('run', () => {
  let outputFile: string

  async function call(inputs: Record<string, string>): Promise<Record<string, string>> {
    const all: Record<string, string> = {
      mode: 'apply',
      'project-path': root,
      format: 'aab',
      output: '',
      version: '',
      'version-code': '',
      development: 'false',
      signing: 'release',
      'keystore-base64': '',
      'keystore-password': '',
      'keystore-alias': '',
      'keystore-alias-password': '',
      ...inputs
    }
    for (const [key, value] of Object.entries(all)) vi.stubEnv(`INPUT_${key.toUpperCase()}`, value)
    await writeFile(outputFile, '')
    await run()
    const out: Record<string, string> = {}
    const text = (await readFile(outputFile, 'utf8')).split(/\r?\n/).join('\n')
    for (const m of text.matchAll(/^(.+)<<(ghadelimiter_[\w-]+)\n([\s\S]*?)\n\2$/gm)) {
      out[m[1]!] = m[3]!
    }
    return out
  }

  beforeEach(async () => {
    outputFile = path.join(temp, 'output')
    vi.stubEnv('RUNNER_TEMP', temp)
    vi.stubEnv('GITHUB_OUTPUT', outputFile)
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  })

  it('release from a tag with the project keystore, then restore', async () => {
    await copyFile(KEYSTORE, path.join(root, 'My-Game.keystore'))
    const out = await call({ version: 'v1.0.2' })
    expect(out).toMatchObject({
      'execute-method': EXECUTE_METHOD,
      output: path.join(root, 'Builds', 'release.aab'),
      'version-name': '1.0.2',
      'version-code': '10002',
      'keystore-path': path.join(root, 'My-Game.keystore'),
      'keystore-source': 'project-settings'
    })
    const src = await readFile(path.join(root, GENERATED_DIR, SCRIPT_FILE), 'utf8')
    expect(src).toContain('KeystorePath = "My-Game.keystore";')
    expect(src).toContain('KeyaliasName = "my-game";')

    await call({ mode: 'restore' })
    expect(await readFile(path.join(root, PROJECT_SETTINGS))).toEqual(SETTINGS)
    expect(existsSync(path.join(root, GENERATED_DIR))).toBe(false)
  })

  it('fails early when the project keystore is missing, changing nothing', async () => {
    await expect(call({ version: 'v1.0.2' })).rejects.toThrow(/does not exist.*Convention/)
    expect(existsSync(path.join(root, GENERATED_DIR))).toBe(false)
    expect(await readFile(path.join(root, PROJECT_SETTINGS))).toEqual(SETTINGS)
  })

  it('fails on a bad tag before anything else', async () => {
    await copyFile(KEYSTORE, path.join(root, 'My-Game.keystore'))
    await expect(call({ version: 'v1.0' })).rejects.toThrow(/not a release version/)
    expect(existsSync(path.join(root, GENERATED_DIR))).toBe(false)
  })

  it('uses complete keystore secrets, keeps their values out of the script, deletes the file', async () => {
    const out = await call({
      version: '2.1.0',
      'keystore-base64': (await readFile(KEYSTORE)).toString('base64'),
      'keystore-password': 'My-Game',
      'keystore-alias': 'my-game',
      'keystore-alias-password': 'My-Game'
    })
    expect(out['keystore-source']).toBe('explicit')
    expect(out['version-code']).toBe('20100')
    const key = out['keystore-path']!
    expect(existsSync(key)).toBe(true)
    const src = await readFile(path.join(root, GENERATED_DIR, SCRIPT_FILE), 'utf8')
    expect(src).toContain('KeystorePass = null;')
    expect(src).toContain('KeyaliasName = null;')
    expect(src).toContain('KeyaliasPass = null;')
    expect(src).not.toContain('My-Game"')

    await call({ mode: 'restore' })
    expect(existsSync(key)).toBe(false)
  })

  it('fails on a partial set of keystore secrets, naming the missing ones', async () => {
    await expect(
      call({ 'keystore-base64': (await readFile(KEYSTORE)).toString('base64') })
    ).rejects.toThrow(/keystore-password: is empty \(secret KEYSTORE_PASSWORD\)/)
    expect(existsSync(path.join(root, GENERATED_DIR))).toBe(false)
  })

  it('debug signing needs no keystore', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const out = await call({ signing: 'debug', format: 'apk', development: 'true' })
    expect(out['keystore-source']).toBe('')
    expect(out.output).toBe(path.join(root, 'Builds', 'release.apk'))
    expect(write.mock.calls.join('')).not.toContain('::warning::')
    await call({ mode: 'restore' })

    write.mockClear()
    await call({ signing: 'debug', format: 'apk' })
    expect(write.mock.calls.join('')).toContain(
      '::warning::signing: debug on a non-development build'
    )
    await call({ mode: 'restore' })
  })

  it('rejects unknown choices', async () => {
    await expect(call({ format: 'ipa', signing: 'none' })).rejects.toThrow(/format.*signing/s)
  })

  it('downloads Obfuscar, copies it under the project, bakes the full hook, then restore removes it', async () => {
    await copyFile(KEYSTORE, path.join(root, 'My-Game.keystore'))
    const nupkg = makeZip([
      { name: 'tools/Obfuscar.Console.exe', data: Buffer.from('MZ-fake-obfuscar') }
    ])
    const sha = createHash('sha256').update(nupkg).digest('hex')
    const fetchMock = vi.fn(async () => new Response(nupkg, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('RUNNER_TOOL_CACHE', path.join(temp, 'tool-cache'))
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const out = await call({
      version: 'v1.0.2',
      obfuscate: 'full',
      'scripting-backend': 'il2cpp',
      'obfuscar-sha256': sha
    })
    expect(out.obfuscate).toBe('full')
    expect(out['scripting-backend']).toBe('il2cpp')
    expect(fetchMock).toHaveBeenCalledOnce()
    const exe = path.join(root, obfuscarExeRelative)
    expect(existsSync(exe)).toBe(true)
    expect(await readFile(exe, 'utf8')).toBe('MZ-fake-obfuscar')
    const src = await readFile(path.join(root, GENERATED_DIR, SCRIPT_FILE), 'utf8')
    expect(src).toContain('class CiSdkObfuscate')
    expect(src).toContain('Mode = "full";')
    expect(write.mock.calls.join('')).toContain('::warning::obfuscate: full')

    await call({ mode: 'restore' })
    expect(existsSync(path.join(root, OBFUSCAR_DIR))).toBe(false)
    expect(existsSync(exe)).toBe(false)
  })

  it('rejects an obfuscate-config that does not exist', async () => {
    await copyFile(KEYSTORE, path.join(root, 'My-Game.keystore'))
    vi.stubEnv('RUNNER_TOOL_CACHE', path.join(temp, 'tool-cache'))
    await expect(
      call({ version: 'v1.0.2', obfuscate: 'strings', 'obfuscate-config': 'missing/rules.xml' })
    ).rejects.toThrow(/obfuscate-config: file not found/)
    expect(existsSync(path.join(root, GENERATED_DIR))).toBe(false)
  })
})

describe('ensureObfuscar', () => {
  let cache: string
  beforeEach(async () => {
    cache = await mkdtemp(path.join(os.tmpdir(), 'ci-sdk-obfuscar-cache-'))
  })
  afterEach(async () => {
    await rm(cache, { recursive: true, force: true })
  })

  const nupkg = makeZip([{ name: OBFUSCAR_ENTRY, data: Buffer.from('MZ-fake-obfuscar') }])
  const sha = createHash('sha256').update(nupkg).digest('hex')

  it('builds the flatcontainer URL (lower-cased)', () => {
    expect(obfuscarUrl('2.2.38')).toBe(
      'https://api.nuget.org/v3-flatcontainer/obfuscar/2.2.38/obfuscar.2.2.38.nupkg'
    )
  })

  it('verifies the sha256, extracts the exe, then serves it from the cache', async () => {
    const fetchImpl = vi.fn(async () => new Response(nupkg, { status: 200 }))
    const exe = await ensureObfuscar({
      version: '2.2.38',
      sha256: sha,
      toolCache: cache,
      fetchImpl
    })
    expect(await readFile(exe, 'utf8')).toBe('MZ-fake-obfuscar')
    const again = await ensureObfuscar({
      version: '2.2.38',
      sha256: sha,
      toolCache: cache,
      fetchImpl
    })
    expect(again).toBe(exe)
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('re-extracts the exe from the cached nupkg when the exe is missing, without re-downloading', async () => {
    const fetchImpl = vi.fn(async () => new Response(nupkg, { status: 200 }))
    const exe = await ensureObfuscar({
      version: '2.2.38',
      sha256: sha,
      toolCache: cache,
      fetchImpl
    })
    await rm(exe, { force: true })
    const again = await ensureObfuscar({
      version: '2.2.38',
      sha256: sha,
      toolCache: cache,
      fetchImpl
    })
    expect(again).toBe(exe)
    expect(await readFile(exe, 'utf8')).toBe('MZ-fake-obfuscar')
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('re-downloads when the cached nupkg no longer matches its sha256', async () => {
    const fetchImpl = vi.fn(async () => new Response(nupkg, { status: 200 }))
    const exe = await ensureObfuscar({
      version: '2.2.38',
      sha256: sha,
      toolCache: cache,
      fetchImpl
    })
    // Tamper with the cached nupkg (a persistent runner's cache could be changed).
    await writeFile(path.join(cache, 'obfuscar', '2.2.38', 'obfuscar.2.2.38.nupkg'), 'tampered')
    const again = await ensureObfuscar({
      version: '2.2.38',
      sha256: sha,
      toolCache: cache,
      fetchImpl
    })
    expect(again).toBe(exe)
    expect(await readFile(exe, 'utf8')).toBe('MZ-fake-obfuscar')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('fails on a sha256 mismatch', async () => {
    const fetchImpl = vi.fn(async () => new Response(nupkg, { status: 200 }))
    await expect(
      ensureObfuscar({
        version: '2.2.38',
        sha256: 'deadbeef',
        toolCache: cache,
        fetchImpl
      })
    ).rejects.toThrow(/sha256 mismatch/)
  })

  it('fails on a non-ok response', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404 }))
    await expect(
      ensureObfuscar({
        version: '2.2.38',
        sha256: sha,
        toolCache: cache,
        fetchImpl
      })
    ).rejects.toThrow(/download failed: 404/)
  })

  it('a body that stalls past the timeout is a clear E_OBFUSCAR error', async () => {
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
      ensureObfuscar({ version: '2.2.38', sha256: sha, toolCache: cache, fetchImpl })
    ).rejects.toMatchObject({
      code: 'E_OBFUSCAR',
      message: expect.stringContaining('download timed out after 5 minutes') as string
    })
  })

  it('a timed-out download is a clear E_OBFUSCAR error', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException('The operation timed out', 'TimeoutError')
    })
    await expect(
      ensureObfuscar({ version: '2.2.38', sha256: sha, toolCache: cache, fetchImpl })
    ).rejects.toMatchObject({
      code: 'E_OBFUSCAR',
      message: expect.stringContaining('download timed out after 5 minutes') as string
    })
  })
})
