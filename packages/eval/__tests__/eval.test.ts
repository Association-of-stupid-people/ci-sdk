import { describe, expect, it } from 'vitest'
import { evaluate, getPath } from '../src/eval.js'

describe('evaluate', () => {
  it('single match (v1 behaviour)', () => {
    expect(evaluate('https://{secrets:GITHUB_PAT}', { secrets: { GITHUB_PAT: '123' } }).value).toBe(
      'https://123'
    )
  })

  it('multiple matches (v1 behaviour)', () => {
    const r = evaluate('https://{secrets:GITHUB_PAT}/{secrets:GITHUB}', {
      secrets: { GITHUB_PAT: '123', GITHUB: '456' }
    })
    expect(r.value).toBe('https://123/456')
    expect(r.secretsUsed.sort()).toEqual(['123', '456'])
  })

  it('reads nested github and vars paths', () => {
    const r = evaluate('{github:repo.owner}/{github:payload.commits[0].id} {vars:ENV}', {
      github: { repo: { owner: 'mirai' }, payload: { commits: [{ id: 'abc' }] } },
      vars: { ENV: 'prod' }
    })
    expect(r.value).toBe('mirai/abc prod')
    expect(r.secretsUsed).toEqual([])
  })

  it('keeps unknown providers, missing values and shell syntax untouched', () => {
    const r = evaluate('${HOME} {foo:bar} {vars:MISSING} {secrets:EMPTY}', {
      vars: {},
      secrets: { EMPTY: '' }
    })
    expect(r.value).toBe('${HOME} {foo:bar} {vars:MISSING} {secrets:EMPTY}')
    expect(r.unresolved).toEqual(['{vars:MISSING}', '{secrets:EMPTY}'])
  })

  it('substitutes non-string values (v1 dropped 0 and false)', () => {
    expect(evaluate('{vars:N}-{vars:B}', { vars: { N: 0, B: false } }).value).toBe('0-false')
  })
})

describe('getPath', () => {
  it('handles dots and brackets', () => {
    expect(getPath({ a: { b: [{ c: 1 }] } }, 'a.b[0].c')).toBe(1)
    expect(getPath({ a: 1 }, 'a.b.c')).toBeUndefined()
    expect(getPath(null, 'a')).toBeUndefined()
  })
})
