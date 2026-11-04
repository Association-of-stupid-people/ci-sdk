import * as core from '@actions/core'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@actions/core', async importOriginal => ({
  ...(await importOriginal<typeof import('@actions/core')>()),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  startGroup: vi.fn(),
  endGroup: vi.fn(),
  setOutput: vi.fn(),
  setFailed: vi.fn(),
  setSecret: vi.fn(),
  getInput: vi.fn()
}))

import type { PipelineReport } from '../../sdk/src/index.js'
import { machineLicenseFile } from '../src/license.js'
import { currentHost, type HostEnv } from '../src/locate.js'
import { ulf } from './fixtures/ulf.js'

const { run } = await import('../src/main.js')

const fakeUnity = fileURLToPath(new URL('./fixtures/fake-unity.mjs', import.meta.url))
const output = (name: string): unknown =>
  vi.mocked(core.setOutput).mock.calls.find(([n]) => n === name)?.[1]

let dir: string
const savedEnv = { ...process.env }

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'unity-build-'))
  process.env.RUNNER_TEMP = dir
  process.env.FAKE_UNITY_STATE = path.join(dir, 'runs')
  process.env.INPUT_LEAK = 'should-not-reach-unity'
  process.env.ACTIONS_RUNTIME_TOKEN = 'runner-token'
  delete process.env.GITHUB_STEP_SUMMARY
  delete process.env.UNITY_VER
})
afterEach(() => {
  process.env = { ...savedEnv }
  rmSync(dir, { recursive: true, force: true })
})

const start = async (
  mode: string,
  extra: Record<string, string> = {},
  host?: HostEnv
): Promise<PipelineReport> => {
  process.env.FAKE_UNITY_MODE = mode
  const values: Record<string, string> = {
    workdir: dir,
    version: '2022.3.20f1',
    mode: 'host',
    'editor-path': process.execPath,
    'default-args-override': `${JSON.stringify(fakeUnity)} -batchmode -logFile -`,
    args: '-buildTarget Android',
    modules: 'none',
    'license-retry-delay': '1ms',
    'clean-gradle-cache': 'false',
    ...extra
  }
  vi.mocked(core.getInput).mockImplementation(name => values[name] ?? '')
  return run(host ? { host } : {})
}

describe('unity-build', () => {
  it('builds, passes the keystore through env only and writes the log', async () => {
    const report = await start('ok', { 'keystore-password': 'k3y', 'keystore-path': 'k.keystore' })
    expect(report.status).toBe('success')
    expect(core.setSecret).toHaveBeenCalledWith('k3y')
    const log = readFileSync(output('log-file') as string, 'utf8')
    // The keystore reached Unity through env, is redacted in the file, and runner tokens are stripped.
    expect(log).toContain('env keystore=*** inputs=0')
    expect(log).not.toContain('k3y')
    expect(log).toMatch(/args=-batchmode -logFile - -buildTarget Android -projectPath /)
    expect(log).not.toMatch(/args=.*k3y/)
    expect(output('attempts')).toBe('1')
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('retries a license error and then succeeds', async () => {
    const report = await start('license-then-ok')
    expect(report.status).toBe('success')
    expect(output('attempts')).toBe('2')
    expect(readFileSync(output('log-file') as string, 'utf8')).toContain('attempt 2')
  })

  it('gives up after license-retries', async () => {
    const report = await start('license', { 'license-retries': '1' })
    expect(report.status).toBe('failure')
    expect(output('attempts')).toBe('2')
    expect(output('failure-kind')).toBe('license')
  })

  it('does not retry a compile error even with license noise, and annotates it', async () => {
    const report = await start('compile')
    expect(report.status).toBe('failure')
    expect(output('attempts')).toBe('1')
    expect(output('failure-kind')).toBe('build')
    expect(core.error).toHaveBeenCalledWith(
      expect.stringContaining('error CS0103'),
      expect.objectContaining({ startLine: 12, startColumn: 5 })
    )
    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('error CS0103'))
  })

  it('fails on "Result: Failure" even when Unity exits 0', async () => {
    const report = await start('result-failure')
    expect(report.status).toBe('failure')
    expect(output('failure-kind')).toBe('build')
  })

  it('kills a hung editor', async () => {
    const report = await start('hang', { 'idle-timeout': '400ms' })
    expect(report.status).toBe('failure')
    expect(output('failure-kind')).toBe('hang')
    expect(output('attempts')).toBe('1')
  }, 20_000)

  it('kills Unity at the hard timeout', async () => {
    const report = await start('hang', { timeout: '400ms', 'idle-timeout': '0' })
    expect(output('failure-kind')).toBe('timeout')
    expect(report.status).toBe('failure')
  }, 20_000)

  it('takes the version from UNITY_VER, then ProjectVersion.txt', async () => {
    process.env.UNITY_VER = '6000.0.23f1'
    await start('ok', { version: '' })
    expect(output('unity-version')).toBe('6000.0.23f1')
  })

  it('reports a missing editor with the paths it searched', async () => {
    const report = await start('ok', { 'editor-path': '', install: 'false', version: '1999.1.1f1' })
    expect(report.status).toBe('failure')
    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('Unity 1999.1.1f1 not found')
    )
  })

  it('writes the job summary', async () => {
    const summary = path.join(dir, 'summary.md')
    process.env.GITHUB_STEP_SUMMARY = summary
    writeFileSync(summary, '')
    await start('compile')
    const md = readFileSync(summary, 'utf8')
    expect(md).toContain('Unity build: failure')
    expect(md).toContain('error CS0103')
  })

  it('docker mode: warns about settings it cannot honour and explains a missing Docker', async () => {
    process.env.PATH = dir // no docker CLI in here
    const report = await start('ok', {
      mode: 'docker',
      modules: 'auto',
      args: '-customBuildPath /tmp/out.apk',
      'unity-serial': 'SC-1',
      'unity-email': 'e@x',
      'unity-password': 'pw'
    })
    expect(report.status).toBe('failure')
    const warnings = vi.mocked(core.warning).mock.calls.map(([m]) => String(m))
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^No -buildTarget/),
        expect.stringMatching(/^editor-path only apply to mode: host/),
        expect.stringMatching(/^"\/tmp\/out\.apk" is outside the project/)
      ])
    )
    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringMatching(/needs Docker on the runner: Failed to start docker.*set mode: host/s)
    )
  })

  it('rejects a missing license file before Docker can create it as a directory', async () => {
    await expect(
      start('ok', { mode: 'docker', 'unity-license-file': 'missing.ulf' })
    ).rejects.toThrow(/unity-license-file: not found/)
  })

  it('docker mode: rejects unity-serial without the account before pulling anything', async () => {
    await expect(start('ok', { mode: 'docker', 'unity-serial': 'SC-1' })).rejects.toThrow(
      /unity-email: is required with unity-serial\n.*unity-password: is required with unity-serial/
    )
    await expect(
      start('ok', { mode: 'docker', 'unity-serial': 'SC-1', 'unity-email': 'e@x' })
    ).rejects.toThrow(/^(?!.*unity-email).*unity-password: is required/s)
  })
})

/** A docker CLI that logs its arguments: images are cached, `run` succeeds or hangs. */
describe.skipIf(process.platform === 'win32')('unity-build with a fake docker CLI', () => {
  let dockerLog: string
  const docker = (): string[] => readFileSync(dockerLog, 'utf8').trim().split('\n')

  beforeEach(() => {
    dockerLog = path.join(dir, 'docker.log')
    writeFileSync(dockerLog, '')
    const bin = path.join(dir, 'bin')
    mkdirSync(bin)
    writeFileSync(
      path.join(bin, 'docker'),
      [
        '#!/bin/sh',
        'echo "$*" >>"$FAKE_DOCKER_LOG"',
        'case "$1" in',
        '  run)',
        '    [ "${FAKE_DOCKER_RUN:-}" = hang ] && exec sleep 30',
        // A container that needs 6 s after SIGTERM to return the seat, and fails to.
        '    if [ "${FAKE_DOCKER_RUN:-}" = slow-stop ]; then',
        '      trap \'sleep 6; echo "ci-unity: could not return the license seat (exit 1)"; echo "ci-unity:   Unable to return the license: Code 500"; exit 143\' TERM',
        '      while :; do sleep 1; done',
        '    fi',
        '    exit 0 ;;',
        '  volume) echo "Error response from daemon: remove $4: volume is in use" >&2; exit 1 ;;',
        'esac',
        'exit 0',
        ''
      ].join('\n')
    )
    chmodSync(path.join(bin, 'docker'), 0o755)
    process.env.PATH = `${bin}:${process.env.PATH ?? ''}`
    process.env.FAKE_DOCKER_LOG = dockerLog
  })

  const warnings = (): string[] => vi.mocked(core.warning).mock.calls.map(([m]) => String(m))
  const dockerMode = { mode: 'docker', 'editor-path': '', 'docker-gradle-volume': 'none' }

  it('runs the cached GameCI image, without --platform for none, and says the Dockerfile went unused', async () => {
    const report = await start('ok', {
      ...dockerMode,
      'docker-platform': 'none',
      dockerfile: 'ci/unity.Dockerfile'
    })
    expect(report.status).toBe('success')
    expect(output('image')).toBe('unityci/editor:ubuntu-2022.3.20f1-base-3')
    const run = docker().find(l => l.startsWith('run '))
    expect(run).toMatch(/ unityci\/editor:ubuntu-2022\.3\.20f1-base-3 sh -c /)
    expect(run).not.toContain('--platform')
    expect(warnings()).toContainEqual(
      expect.stringMatching(/^dockerfile is not used: the image is unityci\/editor:/)
    )
  })

  it('docker-image set: no "No -buildTarget" warning, the given image runs', async () => {
    await start('ok', { ...dockerMode, modules: 'auto', args: '', 'docker-image': 'my/unity:1' })
    expect(warnings().filter(w => w.startsWith('No -buildTarget'))).toEqual([])
    expect(docker().find(l => l.startsWith('run '))).toContain(' my/unity:1 sh -c ')
  })

  it.each([
    ['build', 'remove docker-image to build'],
    ['auto', 'remove docker-image and set docker-image-source: build to build']
  ])(
    'docker-image and dockerfile (source %s): says docker-image is why the Dockerfile went unused',
    async (source, advice) => {
      await start('ok', {
        ...dockerMode,
        'docker-image': 'my/unity:1',
        'docker-image-source': source,
        dockerfile: 'ci/unity.Dockerfile'
      })
      expect(warnings()).toContainEqual(
        'dockerfile is not used: docker-image (my/unity:1) is set and overrides docker-image-source; ' +
          `${advice} from the Dockerfile.`
      )
    }
  )

  it('on timeout gives the container time to return the seat, then removes it', async () => {
    process.env.FAKE_DOCKER_RUN = 'hang'
    const report = await start('ok', { ...dockerMode, timeout: '400ms', 'idle-timeout': '0' })
    expect(report.status).toBe('failure')
    expect(output('failure-kind')).toBe('timeout')
    const name = /--name (\S+)/.exec(docker().find(l => l.startsWith('run ')) ?? '')?.[1]
    expect(docker().slice(-2)).toEqual([`stop -t 300 ${name}`, `rm --force ${name}`])
  }, 20_000)

  it('on timeout stays attached while the container cleans up, and warns about the seat', async () => {
    process.env.FAKE_DOCKER_RUN = 'slow-stop'
    const report = await start('ok', { ...dockerMode, timeout: '400ms', 'idle-timeout': '0' })
    expect(report.status).toBe('failure')
    // Not a license failure: the notice is never scanned as Unity output.
    expect(output('failure-kind')).toBe('timeout')
    expect(output('errors')).toBe('[]')
    expect(warnings()).toContainEqual(
      'could not return the license seat (exit 1)\n  Unable to return the license: Code 500'
    )
  }, 20_000)

  it('warns when the Gradle volume cannot be removed', async () => {
    const report = await start('ok', {
      ...dockerMode,
      'docker-gradle-volume': 'g',
      'clean-gradle-cache': 'true'
    })
    expect(report.status).toBe('success')
    expect(docker()[0]).toBe('volume rm --force g')
    expect(warnings()).toContainEqual(
      expect.stringMatching(/^Gradle cache not cleaned: .*volume is in use/)
    )
  })
})

/** Host mode with a serial: an editor wrapper around fake-unity.mjs that takes Unity's own argv. */
describe('unity-build host license', () => {
  const SERIAL = 'SC-1234'
  const EMAIL = 'ci@example.com'
  const PASSWORD = 'pw-secret'
  let calls: string
  let editor: string
  const licenseCalls = (): string[] =>
    existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []
  const buildRuns = (): number =>
    existsSync(process.env.FAKE_UNITY_STATE ?? '')
      ? Number(readFileSync(process.env.FAKE_UNITY_STATE ?? '', 'utf8'))
      : 0
  const warnings = (): string[] => vi.mocked(core.warning).mock.calls.map(([m]) => String(m))
  /** The real host, but the machine-wide license file holds `content` (none by default). */
  const machine = (content?: string): HostEnv => {
    const real = currentHost()
    const file = machineLicenseFile(real)
    return { ...real, read: f => (f === file ? content : real.read(f)) }
  }
  const host = (extra: Record<string, string> = {}): Record<string, string> => ({
    'editor-path': editor,
    'default-args-override': '-batchmode -logFile -',
    'unity-serial': SERIAL,
    'unity-email': EMAIL,
    'unity-password': PASSWORD,
    ...extra
  })
  const ACTIVATE =
    /^activate -batchmode -nographics -quit -logFile \S+license\.log -projectPath \S+blank -serial SC-1234 -username ci@example\.com -password pw-secret inputs=0$/
  const RETURN =
    /^return -batchmode -nographics -quit -logFile \S+license\.log -projectPath \S+blank -returnlicense -username ci@example\.com -password pw-secret inputs=0$/

  beforeEach(() => {
    calls = path.join(dir, 'calls.log')
    process.env.FAKE_UNITY_CALLS = calls
    process.env.INPUT_UNITY_PASSWORD = PASSWORD
    const bin = path.join(dir, 'bin')
    mkdirSync(bin)
    if (process.platform === 'win32') {
      editor = path.join(bin, 'Unity.cmd')
      writeFileSync(editor, `@"${process.execPath}" "${fakeUnity}" %*\r\n`)
    } else {
      editor = path.join(bin, 'Unity')
      writeFileSync(editor, `#!/bin/sh\nexec "${process.execPath}" "${fakeUnity}" "$@"\n`)
      chmodSync(editor, 0o755)
    }
  })

  it('activates before the build, keeps the seat (return-license auto) and cleans up', async () => {
    const report = await start('ok', host(), machine())
    expect(report.status).toBe('success')
    expect(report.steps.map(s => s.name)).toEqual([
      'clean gradle cache',
      'locate Unity 2022.3.20f1',
      'activate Unity license',
      'build (Unity 2022.3.20f1)'
    ])
    expect(licenseCalls()).toEqual([expect.stringMatching(ACTIVATE)])
    expect(buildRuns()).toBe(1)
    expect(readdirSync(dir).filter(f => f.startsWith('unity-license-'))).toEqual([])
    expect(warnings().filter(w => /unity-serial|unity-license-file/.test(w))).toEqual([])
    for (const s of [SERIAL, EMAIL, PASSWORD]) expect(core.setSecret).toHaveBeenCalledWith(s)
  })

  it('fails with the redacted license lines of the log, after license-retries', async () => {
    process.env.FAKE_UNITY_ACTIVATE = 'fail'
    const report = await start('ok', host({ 'license-retries': '1' }), machine())
    expect(report.status).toBe('failure')
    expect(licenseCalls()).toHaveLength(2)
    expect(buildRuns()).toBe(0)
    expect(output('failure-kind')).toBe('license')
    expect(output('attempts')).toBe('0')
    const message = String(vi.mocked(core.setFailed).mock.calls[0]?.[0])
    expect(message).toContain('Failed to activate the Unity license (Unity exited with code 1):')
    expect(message).toContain('Error: Code 400 while processing request for *** (password ***)')
    expect(message).toContain('Successfully connected to LicensingClient for ***')
    expect(message).not.toContain('-serial')
    for (const s of [SERIAL, EMAIL, PASSWORD]) expect(message).not.toContain(s)
    expect(readdirSync(dir).filter(f => f.startsWith('unity-license-'))).toEqual([])
  })

  it('skips activation when the machine license already holds the serial', async () => {
    const report = await start('ok', host(), machine(ulf(SERIAL)))
    expect(report.status).toBe('success')
    expect(licenseCalls()).toEqual([])
    expect(core.info).toHaveBeenCalledWith(
      expect.stringMatching(/Unity_lic\.ulf already holds this serial: activation skipped$/)
    )
  })

  it.each([
    ['another serial', ulf('SC-9999'), {}],
    ['an expired license', ulf(SERIAL, '2001-01-01T00:00:00'), {}],
    ['license-retries: 0 (no way to recover)', ulf(SERIAL), { 'license-retries': '0' }]
  ])('activates with %s on the machine', async (_name, content, extra) => {
    await start('ok', host(extra), machine(content))
    expect(licenseCalls()).toEqual([expect.stringMatching(ACTIVATE)])
  })

  it('activates again before a license retry of the build', async () => {
    const report = await start('license-then-ok', host(), machine(ulf(SERIAL)))
    expect(report.status).toBe('success')
    expect(output('attempts')).toBe('2')
    expect(licenseCalls()).toEqual([expect.stringMatching(ACTIVATE)])
  })

  it('return-license true: returns the seat after a successful build', async () => {
    const report = await start('ok', host({ 'return-license': 'true' }), machine())
    expect(report.status).toBe('success')
    expect(licenseCalls()).toEqual([expect.stringMatching(ACTIVATE), expect.stringMatching(RETURN)])
  })

  it('return-license true: returns the seat after a failed build', async () => {
    const report = await start('compile', host({ 'return-license': 'true' }), machine())
    expect(report.status).toBe('failure')
    expect(licenseCalls()[1]).toMatch(RETURN)
  })

  it('return-license true: returns the seat after a timeout', async () => {
    const report = await start(
      'hang',
      host({ 'return-license': 'true', timeout: '400ms', 'idle-timeout': '0' }),
      machine()
    )
    expect(output('failure-kind')).toBe('timeout')
    expect(report.status).toBe('failure')
    expect(licenseCalls()[1]).toMatch(RETURN)
  }, 20_000)

  it('return-license true: a failed return is a redacted warning, not a failure', async () => {
    process.env.FAKE_UNITY_RETURN = 'fail'
    const report = await start('ok', host({ 'return-license': 'true' }), machine())
    expect(report.status).toBe('success')
    const warning = warnings().find(w => w.includes('Could not return the Unity license'))
    expect(warning).toContain('Error: Code 400 while processing request for *** (password ***)')
    for (const s of [SERIAL, EMAIL, PASSWORD]) expect(warning).not.toContain(s)
  })

  it('return-license true after a failed activation: tries the return, says so only as info', async () => {
    process.env.FAKE_UNITY_ACTIVATE = 'fail'
    process.env.FAKE_UNITY_RETURN = 'fail'
    const report = await start(
      'ok',
      host({ 'return-license': 'true', 'license-retries': '0' }),
      machine()
    )
    expect(report.status).toBe('failure')
    expect(licenseCalls()).toEqual([expect.stringMatching(ACTIVATE), expect.stringMatching(RETURN)])
    expect(warnings().filter(w => w.includes('return'))).toEqual([])
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining('Could not return the Unity license')
    )
  })

  it('a failed re-activation before a build retry is retried, then fails as a license error', async () => {
    process.env.FAKE_UNITY_ACTIVATE = 'fail'
    const report = await start('license', host({ 'license-retries': '2' }), machine(ulf(SERIAL)))
    expect(report.status).toBe('failure')
    // Attempt 1 skipped activation and built; attempts 2 and 3 failed to re-activate.
    expect(buildRuns()).toBe(1)
    expect(licenseCalls()).toHaveLength(2)
    expect(output('attempts')).toBe('3')
    expect(output('failure-kind')).toBe('license')
    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('Failed to activate the Unity license')
    )
  })

  it('return-license false: keeps the seat', async () => {
    await start('ok', host({ 'return-license': 'false' }), machine())
    expect(licenseCalls()).toEqual([expect.stringMatching(ACTIVATE)])
  })

  it('rejects unity-serial without the account', async () => {
    await expect(
      start('ok', host({ 'unity-email': '', 'unity-password': '' }), machine())
    ).rejects.toThrow(
      /unity-email: is required with unity-serial\n.*unity-password: is required with unity-serial/
    )
    await expect(start('ok', host({ 'unity-password': '' }), machine())).rejects.toThrow(
      /^(?!.*unity-email).*unity-password: is required/s
    )
    expect(licenseCalls()).toEqual([])
  })

  it('warns that unity-license-file is docker-only and that return-license needs a serial', async () => {
    const report = await start(
      'ok',
      host({ 'unity-serial': '', 'unity-license-file': 'x.ulf', 'return-license': 'true' }),
      machine()
    )
    expect(report.status).toBe('success')
    expect(report.steps.map(s => s.name)).not.toContain('activate Unity license')
    expect(warnings()).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^unity-license-file is used in mode: docker only/),
        'return-license: true needs unity-serial in mode: host; nothing is returned'
      ])
    )
    expect(licenseCalls()).toEqual([])
  })

  it('docker mode: return-license false is ignored with a warning', async () => {
    process.env.PATH = dir // no docker CLI in here
    await start('ok', { mode: 'docker', 'return-license': 'false' })
    expect(warnings()).toContainEqual(
      'return-license applies to mode: host only; in mode: docker the container always returns its seat'
    )
  })
})

describe('childEnv', () => {
  it('drops action inputs and runner tokens, keeps the rest', async () => {
    const { childEnv } = await import('../src/main.js')
    const env = childEnv(
      { UNITY_KEYSTORE_PASS: 'x' },
      {
        PATH: '/bin',
        INPUT_KEYSTORE_PASSWORD: 's',
        ACTIONS_RUNTIME_TOKEN: 't',
        ACTIONS_ID_TOKEN_REQUEST_URL: 'u',
        ACTIONS_CACHE_URL: 'c',
        ACTIONS_RESULTS_URL: 'r',
        ACTIONS_STEP_DEBUG: 'true'
      }
    )
    expect(env).toEqual({ PATH: '/bin', ACTIONS_STEP_DEBUG: 'true', UNITY_KEYSTORE_PASS: 'x' })
  })
})
