import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  InputError,
  conventionalPassword,
  generateKeystore,
  readProjectKeystoreSettings,
  removeWrittenKeystore,
  resolveKeystore,
  resolveProjectKeystorePath,
  verifyKeystore
} from '../src/index.js'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
// keytool -genkeypair -storetype PKCS12 ... -alias my-game -keystore My-Game.keystore -storepass My-Game
const PKCS12 = path.join(FIXTURES, 'My-Game.keystore')
// keytool -genkeypair -storetype JKS ... -alias legacy -storepass legacy-pass
const JKS = path.join(FIXTURES, 'legacy.jks')
// A real keytool (JAVA_HOME, as on GitHub-hosted runners) for the generation test; skipped without one.
const KEYTOOL = [process.env['JAVA_HOME']]
  .filter((home): home is string => !!home)
  .map(home => path.join(home, 'bin', process.platform === 'win32' ? 'keytool.exe' : 'keytool'))
  .find(file => existsSync(file))

const settings = (name: string, alias: string): string =>
  `PlayerSettings:\r\n  AndroidKeystoreName: ${name}\r\n  AndroidKeyaliasName: ${alias}\r\n  androidUseCustomKeystore: 1\r\n`

let project: string
let temp: string
beforeEach(async () => {
  project = await mkdtemp(path.join(os.tmpdir(), 'ks-project-'))
  temp = await mkdtemp(path.join(os.tmpdir(), 'ks-temp-'))
  await mkdir(path.join(project, 'ProjectSettings'))
})
afterEach(async () => {
  await rm(project, { recursive: true, force: true })
  await rm(temp, { recursive: true, force: true })
})

async function writeSettings(text: string): Promise<void> {
  await writeFile(path.join(project, 'ProjectSettings', 'ProjectSettings.asset'), text)
}

/** Copy the fixture keystore to each project-relative path, then commit (git add) the tracked ones. */
async function gitProject(tracked: string[], untracked: string[] = []): Promise<void> {
  execFileSync('git', ['init', '-q'], { cwd: project })
  for (const rel of [...tracked, ...untracked]) {
    await mkdir(path.dirname(path.join(project, rel)), { recursive: true })
    await copyFile(PKCS12, path.join(project, rel))
  }
  execFileSync('git', ['add', '--', ...tracked], { cwd: project })
}

describe('ProjectSettings keystore fields', () => {
  it('reads quoted and plain values (CRLF)', () => {
    expect(
      readProjectKeystoreSettings(settings("'{inproject}: My-Game.keystore'", 'my-game'))
    ).toEqual({ name: '{inproject}: My-Game.keystore', alias: 'my-game' })
    expect(readProjectKeystoreSettings(settings("'it''s.keystore'", '"a b"'))).toEqual({
      name: "it's.keystore",
      alias: 'a b'
    })
    expect(readProjectKeystoreSettings('PlayerSettings:\n  AndroidKeystoreName: \n')).toEqual({
      name: '',
      alias: ''
    })
  })

  it('resolves {inproject}: against the project, other paths as they are', () => {
    expect(resolveProjectKeystorePath('/p', '{inproject}: keys/My-Game.keystore')).toBe(
      path.resolve('/p', 'keys/My-Game.keystore')
    )
    expect(resolveProjectKeystorePath('/p', path.resolve('/abs/k.keystore'))).toBe(
      path.resolve('/abs/k.keystore')
    )
  })

  it('takes the file name without extension as the password', () => {
    expect(conventionalPassword('/p/BGPZ-005-Gem.keystore')).toBe('BGPZ-005-Gem')
    expect(conventionalPassword('/p/release.v2.jks')).toBe('release.v2')
    expect(conventionalPassword('/p/noext')).toBe('noext')
  })
})

describe('verifyKeystore', () => {
  it('opens a PKCS12 keystore with its password', async () => {
    expect(verifyKeystore(await readFile(PKCS12), 'My-Game', 'k')).toBe('ok')
  })
  it('rejects a wrong password', async () => {
    const bytes = await readFile(PKCS12)
    expect(() => verifyKeystore(bytes, 'nope', 'k')).toThrow(/wrong store password/)
  })
  it('cannot check JKS here', async () => {
    expect(verifyKeystore(await readFile(JKS), 'whatever', 'k')).toBe('unverified')
  })
  it('rejects a file that is not a keystore', () => {
    expect(() => verifyKeystore(Buffer.from('hello'), 'x', 'k')).toThrow(/not a keystore/)
    expect(() => verifyKeystore(Buffer.alloc(0), 'x', 'k')).toThrow(/not a keystore/)
  })
})

describe('resolveKeystore: project default', () => {
  it('uses ProjectSettings and the file name as password', async () => {
    await copyFile(PKCS12, path.join(project, 'My-Game.keystore'))
    await writeSettings(settings("'{inproject}: My-Game.keystore'", 'my-game'))
    const ks = await resolveKeystore({ projectPath: project, inputs: {}, tempDir: temp })
    expect(ks).toEqual({
      source: 'project-settings',
      path: path.join(project, 'My-Game.keystore'),
      projectRelativePath: 'My-Game.keystore',
      password: 'My-Game',
      alias: 'my-game',
      aliasPassword: 'My-Game',
      written: false,
      verification: 'ok'
    })
  })

  it('treats empty inputs (unset secrets) as "use the default"', async () => {
    await copyFile(PKCS12, path.join(project, 'My-Game.keystore'))
    await writeSettings(settings("'{inproject}: My-Game.keystore'", 'my-game'))
    const ks = await resolveKeystore({
      projectPath: project,
      inputs: { base64: '', password: '', alias: '', aliasPassword: '' },
      tempDir: temp
    })
    expect(ks.source).toBe('project-settings')
  })

  it('fails early when the file is missing, explaining the convention', async () => {
    await writeSettings(settings("'{inproject}: blackgems.keystore'", 'blackgems'))
    await expect(
      resolveKeystore({ projectPath: project, inputs: {}, tempDir: temp })
    ).rejects.toThrow(/blackgems\.keystore, which does not exist.*Convention: commit/)
  })

  it('fails when ProjectSettings has no keystore', async () => {
    await writeSettings('PlayerSettings:\n  AndroidKeystoreName: \n  AndroidKeyaliasName: \n')
    await expect(
      resolveKeystore({ projectPath: project, inputs: {}, tempDir: temp })
    ).rejects.toThrow(/has no AndroidKeystoreName/)
  })

  it('fails when the file name is not the password', async () => {
    await copyFile(PKCS12, path.join(project, 'Other.keystore'))
    await writeSettings(settings("'{inproject}: Other.keystore'", 'my-game'))
    await expect(
      resolveKeystore({ projectPath: project, inputs: {}, tempDir: temp })
    ).rejects.toThrow(/Other\.keystore \(password = its name, "Other"\): wrong store password/)
  })
})

describe('resolveKeystore: a keystore at the project root', () => {
  it('uses the only one when ProjectSettings points to a missing file, with the conventional alias', async () => {
    await copyFile(PKCS12, path.join(project, 'My-Game.keystore'))
    await writeSettings(settings("'{inproject}: blackgems.keystore'", 'blackgems'))
    const ks = await resolveKeystore({ projectPath: project, inputs: {}, tempDir: temp })
    expect(ks).toEqual({
      source: 'project-file',
      path: path.join(project, 'My-Game.keystore'),
      projectRelativePath: 'My-Game.keystore',
      password: 'My-Game',
      alias: 'my-game',
      aliasPassword: 'My-Game',
      written: false,
      verification: 'ok'
    })
  })

  it('needs no ProjectSettings keystore, and keeps the alias ProjectSettings gives the same file', async () => {
    await copyFile(PKCS12, path.join(project, 'My-Game.keystore'))
    await writeSettings('PlayerSettings:\n  AndroidKeystoreName: \n  AndroidKeyaliasName: \n')
    expect(
      await resolveKeystore({ projectPath: project, inputs: {}, tempDir: temp })
    ).toMatchObject({
      source: 'project-file',
      alias: 'my-game'
    })
    await writeSettings(settings("'{inproject}: Keys/My-Game.keystore'", 'Custom-Alias'))
    expect(
      await resolveKeystore({ projectPath: project, inputs: {}, tempDir: temp })
    ).toMatchObject({
      source: 'project-file',
      alias: 'Custom-Alias'
    })
  })

  it('picks <preferredName>.keystore among several, else fails naming them', async () => {
    await copyFile(PKCS12, path.join(project, 'My-Game.keystore'))
    await copyFile(PKCS12, path.join(project, 'Other.keystore'))
    const ks = await resolveKeystore({
      projectPath: project,
      inputs: {},
      tempDir: temp,
      preferredName: 'my-game'
    })
    expect(ks.path).toBe(path.join(project, 'My-Game.keystore'))
    await expect(
      resolveKeystore({ projectPath: project, inputs: {}, tempDir: temp })
    ).rejects.toThrow(
      /Several keystores at the project root \(My-Game\.keystore, Other\.keystore\)/
    )
  })

  it('fails with E_NO_KEYSTORE when there is none', async () => {
    await expect(
      resolveKeystore({ projectPath: project, inputs: {}, tempDir: temp })
    ).rejects.toMatchObject({ code: 'E_NO_KEYSTORE' })
  })
})

describe('resolveKeystore: a keystore committed deeper in the project', () => {
  it('uses the only committed one, never a debug.keystore or an untracked file', async () => {
    await gitProject(
      ['Keys/My-Game.keystore', 'Assets/Plugins/Android/debug.keystore'],
      ['Temp/Other.keystore']
    )
    await writeSettings(settings("'{inproject}: blackgems.keystore'", 'blackgems'))
    expect(
      await resolveKeystore({ projectPath: project, inputs: {}, tempDir: temp })
    ).toMatchObject({
      source: 'project-file',
      path: path.join(project, 'Keys', 'My-Game.keystore'),
      projectRelativePath: 'Keys/My-Game.keystore',
      password: 'My-Game',
      alias: 'my-game',
      verification: 'ok'
    })
  })

  it('prefers a keystore at the root over committed ones', async () => {
    await gitProject(['Keys/Old.keystore'], ['My-Game.keystore'])
    expect((await resolveKeystore({ projectPath: project, inputs: {}, tempDir: temp })).path).toBe(
      path.join(project, 'My-Game.keystore')
    )
  })

  it('picks <preferredName>.keystore among several committed, else fails naming them', async () => {
    await gitProject(['Keys/My-Game.keystore', 'Old/Other.keystore'])
    expect(
      (
        await resolveKeystore({
          projectPath: project,
          inputs: {},
          tempDir: temp,
          preferredName: 'My-Game'
        })
      ).path
    ).toBe(path.join(project, 'Keys', 'My-Game.keystore'))
    await expect(
      resolveKeystore({ projectPath: project, inputs: {}, tempDir: temp })
    ).rejects.toThrow(
      /Several keystores committed in the project \(Keys\/My-Game\.keystore, Old\/Other\.keystore\)/
    )
  })

  it('an untracked debug.keystore at the root does not hide a committed release keystore', async () => {
    await gitProject(['Keys/My-Game.keystore'], ['debug.keystore'])
    expect((await resolveKeystore({ projectPath: project, inputs: {}, tempDir: temp })).path).toBe(
      path.join(project, 'Keys', 'My-Game.keystore')
    )
  })

  it('matches .keystore and .jks in any case', async () => {
    await gitProject(['Keys/My-Game.KeyStore'])
    expect(
      await resolveKeystore({ projectPath: project, inputs: {}, tempDir: temp })
    ).toMatchObject({ projectRelativePath: 'Keys/My-Game.KeyStore', password: 'My-Game' })
  })

  it('finds nothing in a folder that is not a git checkout, and says git could not list', async () => {
    await mkdir(path.join(project, 'Keys'))
    await copyFile(PKCS12, path.join(project, 'Keys', 'My-Game.keystore'))
    await expect(
      resolveKeystore({ projectPath: project, inputs: {}, tempDir: temp })
    ).rejects.toMatchObject({
      code: 'E_NO_KEYSTORE',
      message: expect.stringContaining('git could not list the committed files') as unknown
    })
  })
})

describe('generateKeystore', () => {
  it.skipIf(!KEYTOOL)(
    'makes <name>.keystore that the convention opens, and never overwrites it',
    async () => {
      const file = await generateKeystore({ keytool: KEYTOOL!, dir: project, name: 'New-Game' })
      expect(file).toBe(path.join(project, 'New-Game.keystore'))
      expect(
        await resolveKeystore({ projectPath: project, inputs: {}, tempDir: temp })
      ).toMatchObject({
        source: 'project-file',
        password: 'New-Game',
        alias: 'new-game',
        aliasPassword: 'New-Game',
        verification: 'ok'
      })
      await expect(
        generateKeystore({ keytool: KEYTOOL!, dir: project, name: 'New-Game' })
      ).rejects.toThrow(/already exists/)
    },
    60_000
  )

  it.skipIf(!KEYTOOL)(
    'uses the alias it is given (the one ProjectSettings names)',
    async () => {
      await generateKeystore({
        keytool: KEYTOOL!,
        dir: project,
        name: 'New-Game',
        alias: 'Custom-Alias'
      })
      const list = execFileSync(
        KEYTOOL!,
        ['-list', '-keystore', path.join(project, 'New-Game.keystore'), '-storepass:env', 'PW'],
        { env: { ...process.env, PW: 'New-Game' }, encoding: 'utf8' }
      )
      expect(list.toLowerCase()).toContain('custom-alias,')
    },
    60_000
  )

  it('refuses a name that is not a plain file name', async () => {
    await expect(
      generateKeystore({ keytool: 'keytool', dir: project, name: '../x' })
    ).rejects.toThrow(/cannot be a keystore name/)
    expect(await readdir(project)).toEqual(['ProjectSettings'])
  })
})

describe('resolveKeystore: explicit inputs (secrets)', () => {
  const full = async (): Promise<Record<string, string>> => ({
    base64: (await readFile(PKCS12)).toString('base64'),
    password: 'My-Game',
    alias: 'my-game',
    aliasPassword: 'My-Game'
  })

  it('writes the base64 keystore to the temp dir and removes it', async () => {
    // Even with a project keystore present: explicit inputs win.
    await copyFile(PKCS12, path.join(project, 'My-Game.keystore'))
    await writeSettings(settings("'{inproject}: My-Game.keystore'", 'my-game'))
    const ks = await resolveKeystore({ projectPath: project, inputs: await full(), tempDir: temp })
    expect(ks).toMatchObject({ source: 'explicit', written: true, alias: 'my-game' })
    expect(path.dirname(ks.path)).toBe(temp)
    expect(await readFile(ks.path)).toEqual(await readFile(PKCS12))
    await removeWrittenKeystore(ks)
    expect(existsSync(ks.path)).toBe(false)
  })

  it('names every missing input of a partial set', async () => {
    const inputs = { base64: (await full()).base64, password: '', alias: 'x', aliasPassword: '' }
    const err = await resolveKeystore({ projectPath: project, inputs, tempDir: temp }).catch(
      (e: unknown) => e
    )
    expect(err).toBeInstanceOf(InputError)
    const message = (err as Error).message
    expect(message).toContain('keystore-password: is empty (secret KEYSTORE_PASSWORD)')
    expect(message).toContain('keystore-alias-password: is empty (secret KEYSTORE_ALIAS_PASSWORD)')
    expect(message).not.toContain('keystore-alias: is empty')
    expect(message).toContain('must be set all together')
  })

  it('names the base64 when only passwords are set', async () => {
    await expect(
      resolveKeystore({
        projectPath: project,
        inputs: { password: 'p', alias: 'a', aliasPassword: 'p' },
        tempDir: temp
      })
    ).rejects.toThrow(/keystore-base64: is empty \(secret KEYSTORE_BASE64\)/)
  })

  it('checks the password before any build, and leaves no file behind', async () => {
    const inputs = { ...(await full()), password: 'wrong' }
    await expect(resolveKeystore({ projectPath: project, inputs, tempDir: temp })).rejects.toThrow(
      /wrong store password/
    )
    expect(await readdir(temp)).toEqual([])
  })

  it('accepts an existing file instead of base64, relative to the project', async () => {
    await copyFile(PKCS12, path.join(project, 'My-Game.keystore'))
    const ks = await resolveKeystore({
      projectPath: project,
      inputs: { path: 'My-Game.keystore', password: 'My-Game', alias: 'a', aliasPassword: 'p' },
      tempDir: temp
    })
    expect(ks).toMatchObject({
      source: 'explicit',
      written: false,
      projectRelativePath: 'My-Game.keystore'
    })
  })

  it('refuses base64 and path together, and a missing path', async () => {
    const both = { ...(await full()), path: 'x.keystore' }
    await expect(
      resolveKeystore({ projectPath: project, inputs: both, tempDir: temp })
    ).rejects.toThrow(/cannot be set together/)
    const missing = { path: 'nope.keystore', password: 'p', alias: 'a', aliasPassword: 'p' }
    await expect(
      resolveKeystore({ projectPath: project, inputs: missing, tempDir: temp })
    ).rejects.toThrow(/keystore-path does not exist/)
  })
})
