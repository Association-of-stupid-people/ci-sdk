import { describe, expect, it, vi } from 'vitest'
import { InputError, getCiContext, input, readInputs } from '../src/index.js'

const source =
  (values: Record<string, string>) =>
  (name: string): string =>
    values[name] ?? ''

describe('readInputs', () => {
  it('parses and types every kind of input', () => {
    const setSecret = vi.fn()
    const cfg = readInputs(
      {
        name: input.string({ required: true, pattern: /^[a-z]+$/ }),
        retries: input.number({ default: 0, min: 0, integer: true }),
        enabled: input.boolean({ default: false }),
        tags: input.list(),
        commands: input.lines(),
        mode: input.oneOf(['fast', 'safe'] as const, { default: 'safe' }),
        timeout: input.duration({ default: '5m' }),
        meta: input.json({
          validate: (v: unknown): v is { a: number } => typeof v === 'object' && v !== null
        }),
        token: input.string({ secret: true }),
        workingDirectory: input.string({ name: 'working-directory' })
      },
      {
        setSecret,
        getInput: source({
          name: 'build',
          retries: '2',
          enabled: 'Yes',
          tags: 'a, b,,c\nd',
          commands: 'npm ci\n# comment\n\nnpm test -- --a,b',
          meta: '{"a":1}',
          token: 'tkn',
          'working-directory': 'app'
        })
      }
    )
    expect(cfg).toEqual({
      name: 'build',
      retries: 2,
      enabled: true,
      tags: ['a', 'b', 'c', 'd'],
      commands: ['npm ci', 'npm test -- --a,b'],
      mode: 'safe',
      timeout: 300_000,
      meta: { a: 1 },
      token: 'tkn',
      workingDirectory: 'app'
    })
    expect(setSecret).toHaveBeenCalledWith('tkn')
  })

  it('applies defaults and leaves optional inputs undefined', () => {
    const cfg = readInputs(
      { a: input.number({ default: 3 }), b: input.string(), c: input.duration({ default: 1500 }) },
      { getInput: source({}) }
    )
    expect(cfg).toEqual({ a: 3, b: undefined, c: 1500 })
  })

  it('reports every invalid input in one error', () => {
    const err = (() => {
      try {
        readInputs(
          {
            req: input.string({ required: true }),
            num: input.number({ max: 5 }),
            flag: input.boolean(),
            mode: input.oneOf(['x', 'y'] as const),
            wait: input.duration({ max: '1m' })
          },
          { getInput: source({ num: '9', flag: 'maybe', mode: 'z', wait: '2m' }) }
        )
      } catch (e) {
        return e
      }
    })()
    expect(err).toBeInstanceOf(InputError)
    expect((err as InputError).issues.map(i => i.input)).toEqual([
      'req',
      'num',
      'flag',
      'mode',
      'wait'
    ])
    expect((err as InputError).message).toContain('must be one of: x, y')
  })
})

describe('getCiContext', () => {
  it('reads a push to a branch', () => {
    const ci = getCiContext({
      CI: 'true',
      GITHUB_ACTIONS: 'true',
      GITHUB_REPOSITORY: 'mirai/sdk',
      GITHUB_REF: 'refs/heads/develop',
      GITHUB_REF_NAME: 'develop',
      GITHUB_REF_TYPE: 'branch',
      GITHUB_EVENT_NAME: 'push',
      GITHUB_RUN_ID: '42',
      GITHUB_RUN_ATTEMPT: '2'
    })
    expect(ci.isCI && ci.isGitHubActions).toBe(true)
    expect(ci.repository).toEqual({ owner: 'mirai', repo: 'sdk', fullName: 'mirai/sdk' })
    expect(ci.branch).toBe('develop')
    expect(ci.isPullRequest).toBe(false)
    expect(ci.runUrl).toBe('https://github.com/mirai/sdk/actions/runs/42')
    expect(ci.uniqueName('db')).toBe('db-42-2')
  })

  it('reads a pull request', () => {
    const ci = getCiContext({
      GITHUB_REF: 'refs/pull/17/merge',
      GITHUB_HEAD_REF: 'feature/x',
      GITHUB_BASE_REF: 'develop',
      GITHUB_EVENT_NAME: 'pull_request'
    })
    expect(ci.isPullRequest).toBe(true)
    expect(ci.pullRequestNumber).toBe(17)
    expect(ci.branch).toBe('feature/x')
  })

  it('has no branch for a tag push', () => {
    expect(getCiContext({ GITHUB_REF: 'refs/tags/v1.0.0' }).branch).toBeUndefined()
  })
})
