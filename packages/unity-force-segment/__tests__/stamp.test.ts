import { existsSync } from 'node:fs'
import { copyFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { exec, listZip } from '../../sdk/src/index.js'
import { SEGMENT_ENTRY } from '../src/runtime.js'
import { parseSegmentFile } from '../src/segment.js'
import {
  findApksigner,
  signerDigests,
  stampApk,
  unitySdk,
  type Keystore,
  type SdkLookup
} from '../src/stamp.js'
import { tempDir } from './fixtures.js'

vi.mock('../../sdk/src/index.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../sdk/src/index.js')>()),
  exec: vi.fn()
}))

const execMock = exec as unknown as Mock

/** An empty zip: just the end record. */
const EMPTY_ZIP = (() => {
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  return eocd
})()

const certs = (...digests: string[]): string =>
  digests.map((d, i) => `Signer #${i + 1} certificate SHA-256 digest: ${d}\n`).join('')

describe('findApksigner', () => {
  const lookup = (
    files: string[],
    dirs: Record<string, string[]>,
    extra: Partial<SdkLookup> = {}
  ): SdkLookup => ({
    androidSdk: undefined,
    env: {},
    editorPath: undefined,
    platform: 'linux',
    exists: (f: string) => files.includes(f),
    list: (d: string) => {
      const found = dirs[d]
      if (!found) throw new Error('ENOENT')
      return found
    },
    ...extra
  })

  it('takes the newest build-tools that has apksigner.jar', () => {
    const jar = findApksigner(
      lookup(
        ['/sdk/build-tools/34.0.0/lib/apksigner.jar', '/sdk/build-tools/9.0.0/lib/apksigner.jar'],
        {
          '/sdk/build-tools': ['9.0.0', '34.0.0', '35.0.0-rc1']
        },
        { androidSdk: '/sdk' }
      )
    )
    expect(jar).toBe('/sdk/build-tools/34.0.0/lib/apksigner.jar')
  })

  it('falls back to the Unity editor SDK', () => {
    const sdk = unitySdk('/opt/unity/Editor/Unity', 'linux')
    expect(sdk).toBe('/opt/unity/Editor/Data/PlaybackEngines/AndroidPlayer/SDK')
    const jar = `${sdk}/build-tools/34.0.0/lib/apksigner.jar`
    expect(
      findApksigner(
        lookup(
          [jar],
          { [`${sdk}/build-tools`]: ['34.0.0'] },
          { editorPath: '/opt/unity/Editor/Unity', env: { ANDROID_HOME: '/none' } }
        )
      )
    ).toBe(jar)
  })

  it('takes the newest across every SDK root', () => {
    const sdk = unitySdk('/opt/unity/Editor/Unity', 'linux')
    const editorJar = `${sdk}/build-tools/35.0.0/lib/apksigner.jar`
    expect(
      findApksigner(
        lookup(
          ['/sdk/build-tools/34.0.0/lib/apksigner.jar', editorJar],
          { '/sdk/build-tools': ['34.0.0'], [`${sdk}/build-tools`]: ['35.0.0'] },
          { androidSdk: '/sdk', editorPath: '/opt/unity/Editor/Unity' }
        )
      )
    ).toBe(editorJar)
  })

  it('skips build-tools older than 30', () => {
    expect(() =>
      findApksigner(
        lookup(
          ['/sdk/build-tools/29.0.3/lib/apksigner.jar'],
          { '/sdk/build-tools': ['29.0.3'] },
          {
            androidSdk: '/sdk'
          }
        )
      )
    ).toThrow(/not found/)
  })

  it('says where it looked when there is none', () => {
    expect(() => findApksigner(lookup([], {}, { androidSdk: '/sdk' }))).toThrow(
      /apksigner.jar \(build-tools 30\+\) not found.*\/sdk/
    )
  })
})

describe('signerDigests', () => {
  it('reads every signer SHA-256 digest', () => {
    expect(
      signerDigests(
        `Signer #1 certificate DN: CN=x\n${certs('ABcd', 'ef01')}Signer #1 certificate SHA-1 digest: 99`
      )
    ).toEqual(['abcd', 'ef01'])
  })
})

describe('stampApk', () => {
  let dir: string
  const segment = parseSegmentFile('segments:\n  - name: qa\n    campaign: C1\n').segments[0]!
  const keystore = (): Keystore => ({
    file: path.join(dir, 'debug.keystore'),
    password: 'android',
    alias: 'androiddebugkey',
    keyPassword: 'android'
  })

  beforeEach(async () => {
    dir = await tempDir()
    await writeFile(path.join(dir, 'base.apk'), EMPTY_ZIP)
    await writeFile(path.join(dir, 'debug.keystore'), 'ks')
    execMock.mockReset()
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  /** sign copies the unsigned APK to --out; verify prints these digests (base first). */
  function fakeApksigner(baseDigest: string, outDigest: string): void {
    execMock.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[2] === 'sign') {
        await copyFile(args[args.length - 1]!, args[args.indexOf('--out') + 1]!)
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      const apk = args[args.length - 1]!
      return {
        exitCode: 0,
        stdout: certs(apk.endsWith('base.apk') ? baseDigest : outDigest),
        stderr: ''
      }
    })
  }

  it('adds the segment file and signs with the keystore, passwords through env', async () => {
    fakeApksigner('aa', 'aa')
    const output = path.join(dir, 'out', 'qa.apk')
    const result = await stampApk({
      base: path.join(dir, 'base.apk'),
      output,
      segment,
      java: 'java',
      apksigner: 'apksigner.jar',
      keystore: keystore()
    })

    expect(result.signers).toEqual(['aa'])
    expect(await listZip(output)).toEqual([SEGMENT_ENTRY])
    expect(existsSync(`${output}.unsigned`)).toBe(false)
    expect(existsSync(`${output}.signed`)).toBe(false)
    const [cmd, args, options] = execMock.mock.calls[0] as [
      string,
      string[],
      { env: Record<string, string> }
    ]
    expect(cmd).toBe('java')
    expect(args).toEqual([
      '-jar',
      'apksigner.jar',
      'sign',
      '--ks',
      keystore().file,
      '--ks-pass',
      'env:CI_SDK_KS_PASS',
      '--ks-key-alias',
      'androiddebugkey',
      '--key-pass',
      'env:CI_SDK_KEY_PASS',
      '--v4-signing-enabled',
      'false',
      '--out',
      `${output}.signed`,
      `${output}.unsigned`
    ])
    expect(options.env).toEqual({ CI_SDK_KS_PASS: 'android', CI_SDK_KEY_PASS: 'android' })
    expect(args.join(' ')).not.toContain('pass:android')
  })

  it('fails and leaves no APK when the keystore did not sign the base APK', async () => {
    fakeApksigner('aa', 'bb')
    const output = path.join(dir, 'qa.apk')
    await expect(
      stampApk({
        base: path.join(dir, 'base.apk'),
        output,
        segment,
        java: 'java',
        apksigner: 'a.jar',
        keystore: keystore()
      })
    ).rejects.toThrow(/would not install over the normal one/)
    expect(existsSync(output)).toBe(false)
  })

  it('leaves no APK when the signed one cannot be verified', async () => {
    execMock.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[2] === 'sign') {
        await copyFile(args[args.length - 1]!, args[args.indexOf('--out') + 1]!)
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      return { exitCode: 1, stdout: '', stderr: 'DOES NOT VERIFY' }
    })
    const output = path.join(dir, 'qa.apk')
    await expect(
      stampApk({
        base: path.join(dir, 'base.apk'),
        output,
        segment,
        java: 'java',
        apksigner: 'a.jar',
        keystore: keystore()
      })
    ).rejects.toThrow()
    expect(existsSync(output)).toBe(false)
    expect(existsSync(`${output}.signed`)).toBe(false)
  })

  it('reports a failed sign', async () => {
    execMock.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'Failed to load signer' })
    const output = path.join(dir, 'qa.apk')
    await expect(
      stampApk({
        base: path.join(dir, 'base.apk'),
        output,
        segment,
        java: 'java',
        apksigner: 'a.jar',
        keystore: keystore()
      })
    ).rejects.toThrow(/apksigner sign failed: Failed to load signer/)
    expect(existsSync(output)).toBe(false)
    expect(existsSync(`${output}.unsigned`)).toBe(false)
  })

  it('needs the base APK and the keystore', async () => {
    const base = path.join(dir, 'base.apk')
    await expect(
      stampApk({
        base: path.join(dir, 'none.apk'),
        output: path.join(dir, 'o.apk'),
        segment,
        java: 'j',
        apksigner: 'a',
        keystore: keystore()
      })
    ).rejects.toThrow(/Base APK not found/)
    await expect(
      stampApk({
        base,
        output: path.join(dir, 'o.apk'),
        segment,
        java: 'j',
        apksigner: 'a',
        keystore: { ...keystore(), file: path.join(dir, 'none') }
      })
    ).rejects.toThrow(/Keystore not found/)
  })
})
