import * as core from '@actions/core'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

const start = async (mode: string, extra: Record<string, string> = {}): Promise<PipelineReport> => {
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
  return run()
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
