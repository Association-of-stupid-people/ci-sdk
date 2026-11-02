import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as core from '@actions/core'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

vi.mock('@actions/core', async importOriginal => ({
  ...(await importOriginal<typeof import('@actions/core')>()),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  setOutput: vi.fn(),
  setFailed: vi.fn(),
  setSecret: vi.fn(),
  getInput: vi.fn()
}))

const { run } = await import('../src/main.js')
const { decide, parseVersion, parseWorkflowRef } = await import('../src/logic.js')

type Run = {
  id: number
  run_number: number
  event: string
  status: string
  conclusion: string | null
  html_url: string
}
const mk = (id: number, event: string, status: string, conclusion: string | null = null): Run => ({
  id,
  run_number: id,
  event,
  status,
  conclusion,
  html_url: `https://github.com/o/r/actions/runs/${id}`
})

const inputs = (values: Record<string, string>): void => {
  vi.mocked(core.getInput).mockImplementation(name => values[name] ?? '')
}
const output = (name: string): unknown =>
  vi.mocked(core.setOutput).mock.calls.find(([n]) => n === name)?.[1]

/** fetch stub answering with the next page of `responses` (last one repeats). */
type FakeFetch = Mock<(url: string) => Promise<Response>> & typeof fetch
const fakeFetch = (responses: Run[][]): FakeFetch => {
  let call = 0
  const fn = vi.fn(async (_url: string) => {
    const runs = responses[Math.min(call++, responses.length - 1)]
    return new Response(JSON.stringify({ workflow_runs: runs }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  })
  return fn as unknown as FakeFetch
}

const ENV = {
  GITHUB_REPOSITORY: 'o/r',
  GITHUB_SHA: 'abc123',
  GITHUB_RUN_ID: '99',
  GITHUB_WORKFLOW_REF: 'o/r/.github/workflows/ci.yml@refs/tags/v1',
  GITHUB_REF_TYPE: 'tag',
  GITHUB_REF_NAME: 'v1.2.3'
}
const saved = { ...process.env }

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(process.env, ENV)
  delete process.env.GITHUB_EVENT_PATH
  inputs({ token: 'tok', 'poll-interval': '5ms', timeout: '2s' })
})
afterEach(() => {
  process.env = { ...saved }
})

describe('parseWorkflowRef', () => {
  it('extracts the workflow file', () => {
    expect(parseWorkflowRef('o/r/.github/workflows/ci.yml@refs/tags/v1')).toBe('ci.yml')
    expect(parseWorkflowRef('')).toBeUndefined()
  })
})

describe('parseVersion', () => {
  it('reads Cargo.toml [package] and [workspace.package]', () => {
    expect(parseVersion('Cargo.toml', '[package]\nname = "a"\nversion = "1.2.3"\n')).toBe('1.2.3')
    const ws = '[workspace]\nmembers = []\n[workspace.package]\nversion = "0.4.0" # c\n'
    expect(parseVersion('sub/Cargo.toml', ws)).toBe('0.4.0')
    const dep =
      '[dependencies]\nserde = { version = "1" }\nversion = "9"\n[package]\nversion = "2.0.0"'
    expect(parseVersion('Cargo.toml', dep)).toBe('2.0.0')
  })
  it('reads package.json', () => {
    expect(parseVersion('package.json', '{"name":"x","version":"3.1.0"}')).toBe('3.1.0')
  })
  it('reads pyproject.toml [project] and [tool.poetry]', () => {
    expect(parseVersion('pyproject.toml', "[project]\nversion = '1.0.1'\n")).toBe('1.0.1')
    expect(parseVersion('pyproject.toml', '[tool.poetry]\nversion = "5.0.0"\n')).toBe('5.0.0')
  })
  it('ignores [[array.table]] sections', () => {
    const text = ['[tool.poetry]', 'name = "a"', '[[tool.poetry.source]]', 'version = "9"'].join(
      '\n'
    )
    expect(() => parseVersion('pyproject.toml', text)).toThrow(/No version/)
    const cargo = ['[package]', 'name = "a"', '[[bin]]', 'version = "9"'].join('\n')
    expect(() => parseVersion('Cargo.toml', cargo)).toThrow(/No version/)
  })
  it('rejects missing versions and unknown files', () => {
    expect(() => parseVersion('Cargo.toml', '[package]\nname = "a"')).toThrow(/No version/)
    expect(() => parseVersion('setup.py', '')).toThrow(/Unsupported/)
  })
})

describe('decide', () => {
  it('excludes the current run and other events', () => {
    const runs = [
      mk(99, 'push', 'completed', 'success'),
      mk(5, 'pull_request', 'completed', 'success')
    ]
    expect(decide(runs, '99', ['push']).kind).toBe('none')
  })
})

describe('release-gate run', () => {
  it('passes on a green run and sets outputs', async () => {
    const fetchMock = fakeFetch([[mk(12, 'push', 'completed', 'success')]])
    await run({ fetch: fetchMock, minDelay: 1 })
    expect(output('run-id')).toBe('12')
    expect(output('run-url')).toContain('/runs/12')
    const url = fetchMock.mock.calls[0]?.[0] ?? ''
    expect(url).toContain('/repos/o/r/actions/workflows/ci.yml/runs')
    expect(url).toContain('head_sha=abc123')
  })

  it('waits for a pending run, then succeeds', async () => {
    const fetchMock = fakeFetch([
      [mk(12, 'push', 'in_progress')],
      [mk(12, 'push', 'completed', 'success')]
    ])
    await run({ fetch: fetchMock, minDelay: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(core.info).toHaveBeenCalledWith(expect.stringContaining('#12 push=in_progress'))
    expect(output('run-id')).toBe('12')
  })

  it('fails when nothing is pending and nothing is green', async () => {
    const fetchMock = fakeFetch([[mk(12, 'push', 'completed', 'failure')]])
    const err = await run({ fetch: fetchMock, minDelay: 1 }).then(
      () => new Error('resolved'),
      (e: unknown) => e as Error
    )
    expect(err.message).toContain('#12 push=failure')
    expect(err.message).toContain('workflow_dispatch')
  })

  it('fails on timeout listing pending runs', async () => {
    inputs({ token: 'tok', 'poll-interval': '5ms', timeout: '30ms' })
    const fetchMock = fakeFetch([[mk(12, 'push', 'queued')]])
    const err = await run({ fetch: fetchMock, minDelay: 1 }).then(
      () => new Error('resolved'),
      (e: unknown) => e as Error
    )
    expect(err.message).toMatch(/Timed out.*#12 push=queued/)
  })

  it('does not count the current run', async () => {
    inputs({ token: 'tok', 'poll-interval': '5ms', 'no-run-grace': '0' })
    const fetchMock = fakeFetch([[mk(99, 'push', 'completed', 'success')]])
    await expect(run({ fetch: fetchMock, minDelay: 1 })).rejects.toThrow(/seen: none/)
  })

  it('waits for a run to appear within the grace period', async () => {
    const fetchMock = fakeFetch([[], [], [mk(12, 'push', 'completed', 'success')]])
    await run({ fetch: fetchMock, minDelay: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(output('run-id')).toBe('12')
  })

  it('fails after the grace period when no run appears', async () => {
    inputs({ token: 'tok', 'poll-interval': '5ms', 'no-run-grace': '30ms' })
    const err = await run({ fetch: fakeFetch([[]]), minDelay: 1 }).then(
      () => new Error('resolved'),
      (e: unknown) => e as Error
    )
    expect(err.message).toMatch(/seen: none.*workflow_dispatch/)
  })

  it('keeps polling through transient API errors', async () => {
    const ok = fakeFetch([[mk(12, 'push', 'completed', 'success')]])
    let n = 0
    const flaky = vi.fn(async (u: string) =>
      n++ < 3 ? new Response('boom', { status: 500 }) : ok(u)
    ) as unknown as typeof fetch
    await run({ fetch: flaky, minDelay: 1 })
    expect(output('run-id')).toBe('12')
    expect(core.warning).toHaveBeenCalled()
  })

  it('fails at once on 403 with a permissions hint', async () => {
    const denied = vi.fn(async () => new Response('no', { status: 403 })) as unknown as typeof fetch
    await expect(run({ fetch: denied, minDelay: 1 })).rejects.toThrow(/actions: read/)
    expect(denied).toHaveBeenCalledTimes(1)
  })

  it('treats a rate-limit 403 as transient', async () => {
    const ok = fakeFetch([[mk(12, 'push', 'completed', 'success')]])
    let n = 0
    const limited = vi.fn(async (u: string) =>
      n++ < 1
        ? new Response('API rate limit exceeded', { status: 403, headers: { 'retry-after': '0' } })
        : ok(u)
    ) as unknown as typeof fetch
    await run({ fetch: limited, minDelay: 1 })
    expect(output('run-id')).toBe('12')
    expect(core.warning).toHaveBeenCalled()
  })

  it('detects a rate-limit 403 by x-ratelimit-remaining', async () => {
    const ok = fakeFetch([[mk(12, 'push', 'completed', 'success')]])
    let n = 0
    const limited = vi.fn(async (u: string) =>
      n++ < 1
        ? new Response('Forbidden', { status: 403, headers: { 'x-ratelimit-remaining': '0' } })
        : ok(u)
    ) as unknown as typeof fetch
    await run({ fetch: limited, minDelay: 1 })
    expect(output('run-id')).toBe('12')
  })

  it('waits until x-ratelimit-reset', async () => {
    const ok = fakeFetch([[mk(12, 'push', 'completed', 'success')]])
    const reset = Math.ceil(Date.now() / 1000) + 1
    let n = 0
    const limited = vi.fn(async (u: string) =>
      n++ < 1
        ? new Response('Forbidden', {
            status: 403,
            headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }
          })
        : ok(u)
    ) as unknown as typeof fetch
    await run({ fetch: limited, minDelay: 1 })
    expect(Date.now()).toBeGreaterThanOrEqual(reset * 1000 - 5)
    expect(output('run-id')).toBe('12')
  })

  it('never waits past the deadline for retry-after', async () => {
    inputs({ token: 'tok', 'poll-interval': '5ms', timeout: '50ms' })
    const limited = vi.fn(
      async () =>
        new Response('secondary rate limit', { status: 403, headers: { 'retry-after': '3600' } })
    ) as unknown as typeof fetch
    const started = Date.now()
    await expect(run({ fetch: limited, minDelay: 1 })).rejects.toThrow(/Timed out/)
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('requires a workflow when GITHUB_WORKFLOW_REF is unset', async () => {
    delete process.env.GITHUB_WORKFLOW_REF
    await expect(run({ fetch: fakeFetch([[]]) })).rejects.toThrow(/workflow/)
  })
})

describe('version check', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'release-gate-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('accepts a matching tag and skips CI', async () => {
    const file = join(dir, 'package.json')
    writeFileSync(file, '{"version":"1.2.3"}')
    inputs({ 'version-file': file, 'skip-ci-check': 'true' })
    await run()
    expect(output('version')).toBe('1.2.3')
  })

  it('fails on tag mismatch, printing both', async () => {
    const file = join(dir, 'Cargo.toml')
    writeFileSync(file, '[package]\nversion = "1.2.4"\n')
    inputs({ 'version-file': file, 'skip-ci-check': 'true' })
    await expect(run()).rejects.toThrow(/"v1\.2\.3".*"v1\.2\.4"/)
  })

  it('prefers the release payload tag', async () => {
    const file = join(dir, 'package.json')
    writeFileSync(file, '{"version":"2.0.0"}')
    const event = join(dir, 'event.json')
    writeFileSync(event, JSON.stringify({ release: { tag_name: 'rel-2.0.0' } }))
    process.env.GITHUB_EVENT_PATH = event
    inputs({ 'version-file': file, 'tag-prefix': 'rel-', 'skip-ci-check': 'true' })
    await run()
    expect(output('version')).toBe('2.0.0')
  })
})
