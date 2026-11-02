import * as core from '@actions/core'
import { describe, expect, it, vi } from 'vitest'

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
  getInput: vi.fn()
}))

const { run, toArgv } = await import('../src/main.js')

const node = JSON.stringify(process.execPath)
const inputs = (values: Record<string, string>): void => {
  vi.mocked(core.getInput).mockImplementation(name => values[name] ?? '')
}
const output = (name: string): unknown =>
  vi.mocked(core.setOutput).mock.calls.find(([n]) => n === name)?.[1]

describe('toArgv', () => {
  it('splits without a shell by default', () => {
    expect(toArgv('npm run "build all"', 'none')).toEqual(['npm', ['run', 'build all']])
  })
  it('wraps the line for bash with strict flags', () => {
    expect(toArgv('a | b', 'bash')).toEqual([
      'bash',
      ['--noprofile', '--norc', '-eo', 'pipefail', '-c', 'a | b']
    ])
  })
})

describe('run action', () => {
  it('runs every line and reports success', async () => {
    inputs({ run: `${node} -e "1"\n# skipped comment\n${node} -e "2"`, summary: 'false' })
    const report = await run()
    expect(report.status).toBe('success')
    expect(report.steps).toHaveLength(2)
    expect(output('status')).toBe('success')
    expect(output('failed-steps')).toBe('[]')
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('retries then fails, and skips the remaining lines', async () => {
    inputs({
      run: `${node} -e "process.exit(2)"\n${node} -e "1"`,
      retries: '2',
      'retry-delay': '1ms',
      summary: 'false'
    })
    const report = await run()
    expect(report.steps.map(s => [s.status, s.attempts])).toEqual([
      ['failure', 3],
      ['skipped', 0]
    ])
    expect(core.setFailed).toHaveBeenCalledWith('Pipeline failure')
  })

  it('fails when run has only comments', async () => {
    inputs({ run: '# nothing here\n\n' })
    await expect(run()).rejects.toThrow(/contains no commands/)
  })

  it('rejects invalid inputs before running anything', async () => {
    inputs({ run: 'echo hi', retries: '99', shell: 'fish' })
    const err = await run().catch((e: unknown) => e)
    expect(String(err)).toContain('retries: must be <= 10')
    expect(String(err)).toContain('shell: "fish" must be one of')
  })
})
