import * as core from '@actions/core'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

  it('rejects a missing license file before Docker can create it as a directory', async () => {
    await expect(
      start('ok', { mode: 'docker', 'unity-license-file': 'missing.ulf' })
    ).rejects.toThrow(/unity-license-file: not found/)
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
