import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@actions/core', async importOriginal => {
  const actual = await importOriginal<typeof import('@actions/core')>()
  return {
    ...actual,
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    notice: vi.fn(),
    debug: vi.fn(),
    startGroup: vi.fn(),
    endGroup: vi.fn()
  }
})

import {
  AbortError,
  ExecError,
  Pipeline,
  TimeoutError,
  exec,
  formatCommand,
  getCiContext,
  parseCommandLine,
  reportToMarkdown,
  sleep
} from '../src/index.js'

const node = process.execPath

describe('parseCommandLine', () => {
  it.each([
    ['npm ci', ['npm', 'ci']],
    ['  echo   a  b ', ['echo', 'a', 'b']],
    [`echo "hello world" 'it''s'`, ['echo', 'hello world', 'its']],
    [`echo "say \\"hi\\""`, ['echo', 'say "hi"']],
    ['echo a\\ b', ['echo', 'a b']],
    ['dir C:\\Users\\me', ['dir', 'C:\\Users\\me']],
    [`echo ""`, ['echo', '']],
    ['echo $HOME && rm -rf /', ['echo', '$HOME', '&&', 'rm', '-rf', '/']]
  ])('%s', (line, argv) => {
    expect(parseCommandLine(line)).toEqual(argv)
  })

  it('rejects unterminated quotes and empty lines', () => {
    expect(() => parseCommandLine('echo "oops')).toThrow(/Unterminated/)
    expect(() => parseCommandLine('   ')).toThrow(/Empty/)
  })
})

describe('exec', () => {
  it('captures output and exit code', async () => {
    const r = await exec(node, ['-e', 'console.log("out"); console.error("err")'], { silent: true })
    expect(r.exitCode).toBe(0)
    expect(r.stdout.trim()).toBe('out')
    expect(r.stderr.trim()).toBe('err')
  })

  it('passes stdin and env without a shell', async () => {
    const r = await exec(
      node,
      ['-e', 'process.stdin.on("data", d => process.stdout.write(d + process.env.X))'],
      { silent: true, input: 'in-', env: { X: '$(whoami)' } }
    )
    expect(r.stdout).toBe('in-$(whoami)')
  })

  it('throws ExecError on non-zero exit, unless allowFailure', async () => {
    const err = await exec(node, ['-e', 'process.exit(4)'], { silent: true }).catch(
      (e: unknown) => e
    )
    expect(err).toBeInstanceOf(ExecError)
    expect((err as ExecError).exitCode).toBe(4)
    const r = await exec(node, ['-e', 'process.exit(4)'], { silent: true, allowFailure: true })
    expect(r.exitCode).toBe(4)
  })

  it('kills the process on timeout', async () => {
    const started = Date.now()
    const err = await exec(node, ['-e', 'setTimeout(() => {}, 30000)'], {
      silent: true,
      timeout: 200
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TimeoutError)
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it('kills the process when the signal aborts', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 100)
    const err = await exec(node, ['-e', 'setTimeout(() => {}, 30000)'], {
      silent: true,
      signal: controller.signal
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AbortError)
  })

  it('does not hang when a background child keeps the output pipes open', async () => {
    const started = Date.now()
    const script = [
      "const { spawn } = require('node:child_process')",
      "spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'inherit' }).unref()",
      "console.log('started')"
    ].join(';')
    const r = await exec(node, ['-e', script], { silent: true })
    expect(r.stdout).toContain('started')
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it('formats arguments without escaping, so secrets stay maskable', () => {
    expect(formatCommand('curl', ['-u', 'user:p"w', "it's"])).toBe(`curl -u 'user:p"w' "it's"`)
  })

  it('reports a missing program', async () => {
    await expect(exec('definitely-not-a-real-binary-xyz', [], { silent: true })).rejects.toThrow()
  })
})

describe('Pipeline', () => {
  const ci = getCiContext({})
  const base = { handleSignals: false, ci }

  beforeEach(() => vi.clearAllMocks())

  it('runs steps in order and shares state', async () => {
    const report = await new Pipeline<{ version?: string }>({ ...base, state: {} })
      .step('compute', async ctx => {
        ctx.state.version = '1.2.3'
      })
      .step('use', async ctx => {
        expect(ctx.state.version).toBe('1.2.3')
      })
      .run()
    expect(report.status).toBe('success')
    expect(report.steps.map(s => s.status)).toEqual(['success', 'success'])
  })

  it('skips steps after a failure but runs always-steps', async () => {
    const cleanup = vi.fn()
    const report = await new Pipeline(base)
      .step('build', () => Promise.reject(new Error('compile error')))
      .step('test', vi.fn())
      .always('cleanup', async () => cleanup())
      .run()
    expect(report.status).toBe('failure')
    expect(report.steps.map(s => [s.name, s.status])).toEqual([
      ['build', 'failure'],
      ['test', 'skipped'],
      ['cleanup', 'success']
    ])
    expect(report.steps[0]?.error).toBe('compile error')
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('retries flaky steps and records attempts', async () => {
    let calls = 0
    const report = await new Pipeline(base)
      .step(
        'flaky',
        async () => {
          if (++calls < 3) throw new Error('network')
        },
        { retry: { attempts: 3, minDelay: 0 } }
      )
      .run()
    expect(report.steps[0]).toMatchObject({ status: 'success', attempts: 3 })
  })

  it('continueOnError keeps the pipeline green', async () => {
    const report = await new Pipeline(base)
      .step('lint', () => Promise.reject(new Error('warn')), { continueOnError: true })
      .step('test', async () => undefined)
      .run()
    expect(report.status).toBe('success')
    expect(report.steps.map(s => s.status)).toEqual(['soft-failure', 'success'])
  })

  it('evaluates if-conditions', async () => {
    const report = await new Pipeline(base)
      .step('pr-only', vi.fn(), { if: c => c.ci.isPullRequest })
      .step('on-failure', vi.fn(), { if: c => c.status === 'failure', always: true })
      .run()
    expect(report.steps.map(s => s.status)).toEqual(['skipped', 'skipped'])
  })

  it('times out a step and kills its process', async () => {
    const report = await new Pipeline(base)
      .step(
        'hang',
        async ctx => ctx.exec(node, ['-e', 'setTimeout(() => {}, 30000)'], { silent: true }),
        {
          timeout: 200
        }
      )
      .run()
    expect(report.steps[0]?.status).toBe('failure')
    expect(report.steps[0]?.error).toMatch(/timed out/)
  })

  it('cancellation stops the running step, cancels the rest and still runs cleanup', async () => {
    const controller = new AbortController()
    const cleanupSignal: AbortSignal[] = []
    const p = new Pipeline({ ...base, signal: controller.signal })
      .step('long', async ctx => sleep(30_000, ctx.signal))
      .step('next', vi.fn())
      .always('cleanup', async ctx => {
        cleanupSignal.push(ctx.signal)
      })
      .run()
    setTimeout(() => controller.abort(), 50)
    const report = await p
    expect(report.status).toBe('cancelled')
    expect(report.steps.map(s => s.status)).toEqual(['cancelled', 'cancelled', 'success'])
    expect(cleanupSignal[0]?.aborted).toBe(false)
  })

  it('pipeline timeout counts as failure', async () => {
    const report = await new Pipeline({ ...base, timeout: 50 })
      .step('slow', async ctx => sleep(30_000, ctx.signal))
      .run()
    expect(report.status).toBe('failure')
  })

  it('renders a markdown report', async () => {
    const report = await new Pipeline({ ...base, name: 'demo' })
      .step('a | b', async () => undefined)
      .step('bad', () => Promise.reject(new Error('line1\nline2')))
      .run()
    const md = reportToMarkdown(report)
    expect(md).toContain('### ❌ `demo`: failure')
    // Text is kept verbatim (no escaping) so secrets inside stay maskable.
    expect(md).toContain('✅ **success** · 1 attempt')
    expect(md).toContain('`a | b`')
    expect(md).toContain('~~~\n  line1\n  line2\n  ~~~')
  })

  it('a cleanup step survives a cancel that arrives while it runs', async () => {
    const controller = new AbortController()
    const report = await new Pipeline({ ...base, signal: controller.signal, cleanupTimeout: 5_000 })
      .always('cleanup', async ctx => {
        setTimeout(() => controller.abort(), 20)
        await sleep(100, ctx.signal)
      })
      .run()
    expect(report.steps[0]?.status).toBe('success')
    expect(report.status).toBe('cancelled')
  })

  it('a cleanup step is bounded by cleanupTimeout after a cancel', async () => {
    const controller = new AbortController()
    controller.abort()
    const report = await new Pipeline({ ...base, signal: controller.signal, cleanupTimeout: 50 })
      .always('stuck', async ctx => sleep(30_000, ctx.signal))
      .run()
    expect(report.steps[0]?.status).toBe('failure')
    expect(report.steps[0]?.error).toMatch(/cleanup budget/)
  })

  it('an AbortError thrown by the step itself is a failure, not a cancel', async () => {
    const report = await new Pipeline(base)
      .step('fetch', () =>
        Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      )
      .run()
    expect(report.steps[0]?.status).toBe('failure')
    expect(report.status).toBe('failure')
  })

  it('a caller signal does not disable the step timeout', async () => {
    const mine = new AbortController()
    const report = await new Pipeline(base)
      .step(
        'hang',
        async ctx =>
          ctx.exec(node, ['-e', 'setTimeout(() => {}, 30000)'], {
            silent: true,
            signal: mine.signal
          }),
        { timeout: 200 }
      )
      .run()
    expect(report.steps[0]?.error).toMatch(/timed out/)
  })
})
