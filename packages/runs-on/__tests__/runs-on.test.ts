import * as core from '@actions/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isBranchAllowed, patternToRegExp } from '../src/branch.js'

vi.mock('@actions/core', async importOriginal => ({
  ...(await importOriginal<typeof import('@actions/core')>()),
  info: vi.fn(),
  notice: vi.fn(),
  setOutput: vi.fn(),
  getInput: vi.fn()
}))

const { run } = await import('../src/main.js')

describe('isBranchAllowed', () => {
  const patterns = ['main', 'develop*', 'release/**', '!develop_old']
  it.each([
    ['main', true],
    ['develop', true],
    ['develop_mode_2', true],
    ['release/1.0/hotfix', true],
    ['develop_old', false],
    ['develop/x', false], // `*` does not cross `/`
    ['feature/main', false],
    ['mainline', false]
  ])('%s -> %s', (branch, expected) => {
    expect(isBranchAllowed(branch, patterns)).toBe(expected)
  })

  it('escapes regex characters in literal names', () => {
    expect(patternToRegExp('v1.0+x').test('v1.0+x')).toBe(true)
    expect(patternToRegExp('v1.0+x').test('v1a0+x')).toBe(false)
  })
})

describe('runs-on action', () => {
  const env = { ...process.env }
  const inputs = (values: Record<string, string>): void => {
    vi.mocked(core.getInput).mockImplementation(name => values[name] ?? '')
  }

  beforeEach(() => {
    delete process.env.GITHUB_HEAD_REF
  })
  afterEach(() => {
    process.env = { ...env }
  })

  it('allows a matching branch', async () => {
    process.env.GITHUB_REF = 'refs/heads/develop_test'
    inputs({ branch: 'develop, develop_test' })
    run()
    expect(core.setOutput).toHaveBeenCalledWith('allowed', 'true')
  })

  it('fails on another branch', async () => {
    process.env.GITHUB_REF = 'refs/heads/feature/x'
    inputs({ branch: 'develop' })
    expect(() => run()).toThrow('Not allowed to run on branch "feature/x"')
    expect(core.setOutput).toHaveBeenCalledWith('allowed', 'false')
  })

  it('uses the PR head branch', async () => {
    process.env.GITHUB_REF = 'refs/pull/3/merge'
    process.env.GITHUB_HEAD_REF = 'develop'
    inputs({ branch: 'develop' })
    run()
    expect(core.setOutput).toHaveBeenCalledWith('allowed', 'true')
  })

  it('only sets the output in silent mode', async () => {
    process.env.GITHUB_REF = 'refs/tags/v1.0.0'
    inputs({ branch: 'main', silent: 'true' })
    run()
    expect(core.setOutput).toHaveBeenCalledWith('allowed', 'false')
    expect(core.notice).toHaveBeenCalled()
  })
})
