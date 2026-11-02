import * as core from '@actions/core'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@actions/core', async importOriginal => ({
  ...(await importOriginal<typeof import('@actions/core')>()),
  setOutput: vi.fn(),
  setSecret: vi.fn(),
  warning: vi.fn(),
  debug: vi.fn(),
  getInput: vi.fn()
}))

const { run } = await import('../src/main.js')

describe('eval action', () => {
  const env = { ...process.env }
  afterEach(() => {
    process.env = { ...env }
  })

  const inputs = (values: Record<string, string>): void => {
    vi.mocked(core.getInput).mockImplementation(name => values[name] ?? '')
  }

  it('accepts an empty template (k8s-deploy passes submodules: "")', () => {
    inputs({ template: '' })
    run()
    expect(core.setOutput).toHaveBeenCalledWith('value', '')
  })

  it('substitutes and masks secrets', () => {
    process.env.GITHUB_REPOSITORY = 'mirai/sdk'
    inputs({ template: 'https://{secrets:T}@x/{github:repo.repo}', secrets: '{"T":"tok"}' })
    run()
    expect(core.setSecret).toHaveBeenCalledWith('tok')
    expect(core.setOutput).toHaveBeenCalledWith('value', 'https://tok@x/sdk')
  })

  it('tolerates a missing event payload file', () => {
    process.env.GITHUB_EVENT_PATH = '/definitely/not/here.json'
    inputs({ template: '{vars:A}', vars: '{"A":"1"}' })
    run()
    expect(core.setOutput).toHaveBeenCalledWith('value', '1')
  })
})
