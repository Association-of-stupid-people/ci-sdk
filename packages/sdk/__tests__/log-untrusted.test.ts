import * as core from '@actions/core'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@actions/core', async importOriginal => ({
  ...(await importOriginal<typeof import('@actions/core')>()),
  info: vi.fn()
}))

const { printUntrusted, withoutCommands } = await import('../src/index.js')

const lines = (): string[] => vi.mocked(core.info).mock.calls.map(([l]) => l)

describe('untrusted output', () => {
  it('wraps text in stop-commands with a matching random token', () => {
    printUntrusted('::error::fake\nok\n')
    const [stop, text, resume] = lines()
    const token = /^::stop-commands::(ci-sdk-[\w-]+)$/.exec(stop ?? '')?.[1]
    expect(token).toBeDefined()
    expect(text).toBe('::error::fake\nok')
    expect(resume).toBe(`::${token}::`)
  })

  it('prints nothing for empty text', () => {
    printUntrusted('')
    expect(lines()).toEqual([])
  })

  it('re-enables commands even when fn throws', async () => {
    await expect(
      withoutCommands(async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    const [stop, resume] = lines()
    expect(resume).toBe(`\n::${stop?.slice('::stop-commands::'.length)}::`)
  })

  it('returns the value of fn', async () => {
    await expect(withoutCommands(async () => 42)).resolves.toBe(42)
  })
})
