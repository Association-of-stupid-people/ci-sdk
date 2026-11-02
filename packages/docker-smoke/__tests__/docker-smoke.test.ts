import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import * as core from '@actions/core'
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
  saveState: vi.fn(),
  getState: vi.fn(),
  getInput: vi.fn()
}))

const { buildRunArgs, httpProbe, matchesStatus, parseEnvLines, removeResources, waitForHealthy } =
  await import('../src/docker.js')
const { cleanup, defaultName, run } = await import('../src/main.js')
type Runner = import('../src/docker.js').DockerRunner
type CleanupInfo = import('../src/docker.js').CleanupInfo
type State = import('../src/docker.js').ContainerState

const ok = { exitCode: 0, stdout: '', stderr: '' }
const running: State = { status: 'running', running: true, exitCode: 0 }

describe('parseEnvLines', () => {
  it('splits on the first = and keeps empty values', () => {
    expect(parseEnvLines(['A=1', 'B=x=y', 'C='])).toEqual([
      ['A', '1'],
      ['B', 'x=y'],
      ['C', '']
    ])
  })
  it('rejects bad keys, missing = and duplicates without echoing values', () => {
    expect(() => parseEnvLines(['1A=x'])).toThrow(/valid KEY/)
    expect(() => parseEnvLines(['topsecret'])).toThrow(/KEY=VALUE/)
    expect(() => parseEnvLines(['A=1', 'topsecret'], 'secret-env')).toThrow(
      /^secret-env line 2: expected KEY=VALUE/
    )
    expect(() => parseEnvLines(['topsecret'])).not.toThrow(/topsecret/)
    expect(() => parseEnvLines(['A=1', 'A=2'])).toThrow(/duplicate/)
    expect(() => parseEnvLines(['PATH=/x'])).toThrow(/reserved/)
  })
})

describe('buildRunArgs', () => {
  it('keeps env values out of argv', () => {
    const { argv, env } = buildRunArgs({
      image: 'img:1',
      name: 'c1',
      env: [['MODE', 'prod']],
      secretEnv: [['TOKEN', 's3cr3t-value']],
      ports: ['127.0.0.1:18080:8080'],
      network: 'net',
      networkAlias: ['api'],
      args: ['--cap-drop', 'ALL'],
      command: ['serve', '--fast']
    })
    expect(argv.join(' ')).not.toContain('s3cr3t-value')
    expect(argv.join(' ')).not.toContain('prod')
    expect(env).toEqual({ MODE: 'prod', TOKEN: 's3cr3t-value' })
    expect(argv).toEqual([
      'run',
      '-d',
      '--name',
      'c1',
      '--pull',
      'missing',
      '--network',
      'net',
      '--network-alias',
      'api',
      '-p',
      '127.0.0.1:18080:8080',
      '-e',
      'MODE',
      '-e',
      'TOKEN',
      '--cap-drop',
      'ALL',
      'img:1',
      'serve',
      '--fast'
    ])
  })
  it('rejects aliases without a network and duplicate keys across env lists', () => {
    expect(() => buildRunArgs({ image: 'i', name: 'n', networkAlias: ['a'] })).toThrow(/network/)
    expect(() =>
      buildRunArgs({ image: 'i', name: 'n', env: [['A', '1']], secretEnv: [['A', '2']] })
    ).toThrow(/twice/)
  })
})

describe('matchesStatus', () => {
  it('matches classes and exact codes', () => {
    expect(matchesStatus(204, '2xx')).toBe(true)
    expect(matchesStatus(301, '2xx')).toBe(false)
    expect(matchesStatus(204, '200,204')).toBe(true)
    expect(matchesStatus(201, '200,204')).toBe(false)
    expect(matchesStatus(503, '2xx, 503')).toBe(true)
  })
  it('rejects invalid specs', () => {
    expect(() => matchesStatus(200, 'ok')).toThrow(/invalid/)
    expect(() => matchesStatus(200, '')).toThrow(/empty/)
  })
})

describe('waitForHealthy', () => {
  const base = { intervalMs: 5, getState: async () => running, sleep: async () => undefined }

  it('succeeds on the first healthy probe', async () => {
    const r = await waitForHealthy({ ...base, retries: 3, probe: async () => true })
    expect(r).toEqual({ healthy: true, attempts: 1 })
  })
  it('retries until the probe passes', async () => {
    const probe = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const sleeper = vi.fn(async () => undefined)
    const r = await waitForHealthy({ ...base, retries: 5, probe, sleep: sleeper })
    expect(r).toEqual({ healthy: true, attempts: 2 })
    expect(sleeper).toHaveBeenCalledTimes(1)
    expect(sleeper).toHaveBeenCalledWith(5)
  })
  it('reports exhaustion after the last attempt without a trailing sleep', async () => {
    const sleeper = vi.fn(async () => undefined)
    const r = await waitForHealthy({
      ...base,
      retries: 3,
      probe: async () => false,
      sleep: sleeper
    })
    expect(r).toEqual({ healthy: false, attempts: 3 })
    expect(sleeper).toHaveBeenCalledTimes(2)
  })
  it('stops early with the exit code when the container exited', async () => {
    const probe = vi.fn(async () => false)
    await expect(
      waitForHealthy({
        ...base,
        retries: 10,
        probe,
        getState: async () => ({ status: 'exited', running: false, exitCode: 137 })
      })
    ).rejects.toThrow(/exited with exit code 137/)
    expect(probe).not.toHaveBeenCalled()
  })
})

describe('httpProbe', () => {
  let server: Server
  let url: string
  beforeEach(async () => {
    server = createServer((req, res) => {
      if (req.url === '/slow') return // never answers
      res.statusCode = req.url === '/down' ? 503 : 200
      res.end('service is READY')
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterEach(async () => {
    server.closeAllConnections()
    await new Promise(r => server.close(r))
  })

  it('checks status and body', async () => {
    expect(await httpProbe({ url, status: '2xx' })).toBe(true)
    expect(await httpProbe({ url, status: '2xx', body: 'READY' })).toBe(true)
    expect(await httpProbe({ url, status: '2xx', body: 'nope' })).toBe(false)
    expect(await httpProbe({ url: `${url}/down`, status: '2xx' })).toBe(false)
    expect(await httpProbe({ url: `${url}/down`, status: '503' })).toBe(true)
  })
  it('is false on timeout and on connection errors', async () => {
    expect(await httpProbe({ url: `${url}/slow`, status: '2xx', timeoutMs: 50 })).toBe(false)
    expect(await httpProbe({ url: 'http://127.0.0.1:1', status: '2xx' })).toBe(false)
  })
})

describe('defaultName', () => {
  it('appends a sanitised step id', () => {
    expect(
      defaultName({ GITHUB_RUN_ID: '7', GITHUB_RUN_ATTEMPT: '2', GITHUB_ACTION: 'my step!' })
    ).toBe('smoke-7-2-my-step-')
    expect(defaultName({ GITHUB_RUN_ID: '7', GITHUB_RUN_ATTEMPT: '2' })).toBe('smoke-7-2')
  })
})

describe('removeResources and cleanup', () => {
  beforeEach(() => {
    vi.mocked(core.getState).mockReset()
    vi.mocked(core.saveState).mockReset()
    vi.mocked(core.warning).mockReset()
  })

  const labelled =
    (label: string | undefined, calls: string[][] = []): Runner =>
    async args => {
      calls.push(args)
      if (args[0] === 'container') {
        return label === undefined
          ? { exitCode: 1, stdout: '', stderr: 'Error: No such container: c' }
          : {
              exitCode: 0,
              stdout: `${label}
`,
              stderr: ''
            }
      }
      return ok
    }
  const info = (createdNetwork: boolean): CleanupInfo => ({
    container: 'c',
    network: 'n',
    createdNetwork,
    label: 'mine'
  })

  it('removes our container, and the network only when created here', async () => {
    const calls: string[][] = []
    await removeResources(labelled('mine', calls), info(true), vi.fn())
    expect(calls.map(c => c[0])).toEqual(['container', 'rm', 'network'])
    expect(calls[1]).toEqual(['rm', '-f', '-v', 'c'])
    calls.length = 0
    await removeResources(labelled('mine', calls), info(false), vi.fn())
    expect(calls.map(c => c[0])).toEqual(['container', 'rm'])
  })
  it('never removes a container with a foreign or missing label', async () => {
    for (const label of ['someone-else', '', undefined]) {
      const calls: string[][] = []
      await removeResources(labelled(label, calls), info(false), vi.fn())
      expect(calls.map(c => c[0])).toEqual(['container'])
    }
  })
  it('only warns when removal fails', async () => {
    const warn = vi.fn()
    const docker: Runner = async args =>
      args[0] === 'container'
        ? { exitCode: 0, stdout: 'mine', stderr: '' }
        : { exitCode: 1, stdout: '', stderr: 'boom' }
    await removeResources(docker, info(true), warn)
    expect(warn).toHaveBeenCalledTimes(2)
  })
  it('post is a no-op with empty state', async () => {
    vi.mocked(core.getState).mockReturnValue('')
    const docker = vi.fn<Runner>(async () => ok)
    await cleanup({ docker })
    expect(docker).not.toHaveBeenCalled()
  })
  it('post is a no-op when already cleaned, and cleans once otherwise', async () => {
    const state: Record<string, string> = {
      cleanup: JSON.stringify({
        container: 'c',
        network: 'n',
        createdNetwork: true,
        label: 'mine'
      }),
      cleaned: 'true'
    }
    vi.mocked(core.getState).mockImplementation(k => state[k] ?? '')
    const docker = vi.fn<Runner>(labelled('mine'))
    await cleanup({ docker })
    expect(docker).not.toHaveBeenCalled()

    state.cleaned = ''
    await cleanup({ docker })
    expect(docker).toHaveBeenCalledTimes(3)
    expect(core.saveState).toHaveBeenCalledWith('cleaned', 'true')
  })
})

describe('run', () => {
  const inputs = (values: Record<string, string>): void => {
    vi.mocked(core.getInput).mockImplementation(name => values[name] ?? '')
  }
  const output = (name: string): unknown =>
    vi.mocked(core.setOutput).mock.calls.findLast(([n]) => n === name)?.[1]

  beforeEach(() => {
    vi.mocked(core.setOutput).mockReset()
    vi.mocked(core.saveState).mockReset()
    vi.mocked(core.info).mockReset()
  })

  const labelOf = (calls: string[][]): string =>
    calls
      .find(c => c[0] === 'run')
      ?.find(a => a.startsWith('ci-sdk.smoke='))
      ?.slice('ci-sdk.smoke='.length) ?? ''

  const fakeDocker =
    (state: State | (() => State), calls: string[][]): Runner =>
    async (args, opts) => {
      calls.push(args)
      if (args[0] === 'container') {
        return {
          exitCode: 0,
          stdout: `${labelOf(calls)}
`,
          stderr: ''
        }
      }
      if (args[0] === 'run') {
        expect(opts?.env).toEqual({ TOKEN: 'abc' })
        return { exitCode: 0, stdout: 'cid123\n', stderr: '' }
      }
      if (args[0] === 'network' && args[1] === 'inspect')
        return { exitCode: 1, stdout: '', stderr: '' }
      if (args[0] === 'inspect') {
        const s = typeof state === 'function' ? state() : state
        return {
          exitCode: 0,
          stdout: JSON.stringify({ Status: s.status, Running: s.running, ExitCode: s.exitCode }),
          stderr: ''
        }
      }
      if (args[0] === 'logs') return { exitCode: 0, stdout: 'boom log', stderr: '' }
      return ok
    }

  it('passes on a running container and removes it without keep', async () => {
    inputs({ image: 'img', name: 'c', network: 'n', 'secret-env': 'TOKEN=abc' })
    const calls: string[][] = []
    await run({ docker: fakeDocker(running, calls), sleep: async () => undefined })
    expect(output('healthy')).toBe('true')
    expect(output('container-id')).toBe('cid123')
    expect(calls.map(c => c.slice(0, 2).join(' '))).toEqual([
      'network inspect',
      'network create',
      'run -d',
      'inspect --format',
      'container inspect',
      'rm -f',
      'network rm'
    ])
    expect(core.saveState).toHaveBeenCalledWith('cleaned', 'true')
  })

  it('keeps the container when asked and leaves cleanup to the post step', async () => {
    inputs({ image: 'img', name: 'c', keep: 'true', 'secret-env': 'TOKEN=abc' })
    const calls: string[][] = []
    await run({ docker: fakeDocker(running, calls), sleep: async () => undefined })
    expect(calls.some(c => c[0] === 'rm')).toBe(false)
    const saved = JSON.parse(
      String(vi.mocked(core.saveState).mock.calls.find(([k]) => k === 'cleanup')?.[1])
    ) as { container: string; label: string }
    expect(saved.container).toBe('c')
    expect(saved.label).toBe(labelOf(calls))
    expect(saved.label).toMatch(/^[0-9a-f-]{36}$/)
    expect(core.saveState).not.toHaveBeenCalledWith('cleaned', 'true')
  })

  it('never removes or dumps logs of a foreign container on a name conflict', async () => {
    inputs({ image: 'img', name: 'taken' })
    const calls: string[][] = []
    const docker: Runner = async args => {
      calls.push(args)
      if (args[0] === 'run') return { exitCode: 125, stdout: '', stderr: 'name already in use' }
      if (args[0] === 'container') return { exitCode: 0, stdout: 'foreign-label', stderr: '' }
      return ok
    }
    await expect(run({ docker, sleep: async () => undefined })).rejects.toThrow(/docker run failed/)
    expect(calls.map(c => c[0])).toEqual(['run', 'container', 'container'])
    expect(calls.some(c => c[0] === 'rm' || c[0] === 'logs')).toBe(false)
  })

  it('removes our own Created container when start fails', async () => {
    inputs({ image: 'img', name: 'c' })
    const calls: string[][] = []
    const docker: Runner = async args => {
      calls.push(args)
      if (args[0] === 'run') return { exitCode: 127, stdout: '', stderr: 'exec not found' }
      if (args[0] === 'container')
        return {
          exitCode: 0,
          stdout: `${labelOf(calls)}
`,
          stderr: ''
        }
      return ok
    }
    await expect(run({ docker, sleep: async () => undefined })).rejects.toThrow(/docker run failed/)
    expect(calls.some(c => c[0] === 'rm')).toBe(true)
  })

  it('prints container logs inside stop-commands', async () => {
    inputs({ image: 'img', name: 'c', 'secret-env': 'TOKEN=abc' })
    const exited: State = { status: 'exited', running: false, exitCode: 1 }
    await expect(
      run({ docker: fakeDocker(exited, []), sleep: async () => undefined })
    ).rejects.toThrow()
    const lines = vi.mocked(core.info).mock.calls.map(c => String(c[0]))
    const i = lines.findIndex(l => l.startsWith('::stop-commands::'))
    expect(i).toBeGreaterThanOrEqual(0)
    expect(lines[i + 1]).toBe('boom log')
    expect(lines[i + 2]).toMatch(/^::ci-sdk-.*::$/)
  })

  it('dumps logs and cleans up when the container exits', async () => {
    inputs({ image: 'img', name: 'c', keep: 'true', 'secret-env': 'TOKEN=abc', 'log-lines': '50' })
    const calls: string[][] = []
    const exited: State = { status: 'exited', running: false, exitCode: 3 }
    await expect(
      run({ docker: fakeDocker(exited, calls), sleep: async () => undefined })
    ).rejects.toThrow(/exit code 3/)
    expect(calls).toContainEqual(['logs', '--tail', '50', 'c'])
    expect(calls.some(c => c[0] === 'rm')).toBe(true)
    expect(output('healthy')).toBe('false')
    expect(core.saveState).toHaveBeenCalledWith('cleaned', 'true')
  })
})
