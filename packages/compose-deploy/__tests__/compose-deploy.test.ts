import * as core from '@actions/core'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
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
  setSecret: vi.fn(),
  getInput: vi.fn()
}))

const { DEPLOY_SCRIPT, readConfig } = await import('../src/main.js')
const { buildPreamble, buildSshArgs, parseEnvLines, parseResultLines, shellQuote } =
  await import('../src/ssh.js')
type RemoteConfig = import('../src/ssh.js').RemoteConfig

const inputs = (values: Record<string, string>): void => {
  vi.mocked(core.getInput).mockImplementation(name => values[name] ?? '')
}

const base: RemoteConfig = {
  directory: '/srv/app',
  composeFile: 'compose.yaml',
  service: 'app',
  pull: ['app'],
  env: [],
  backup: 'none',
  dbService: 'db',
  backupDir: 'backups',
  backupKeep: 10,
  healthRetries: 3,
  healthIntervalSeconds: 0,
  rollback: true,
  logLines: 120
}

/** Evaluate a preamble in sh and print a variable, to prove the quoting round-trips. */
const hasSh = spawnSync('sh', ['-c', 'true']).status === 0
const roundTrip = (value: string): string =>
  spawnSync('sh', ['-s'], { input: `V=${shellQuote(value)}\nprintf %s "$V"\n`, encoding: 'utf8' })
    .stdout

describe('shellQuote', () => {
  it('wraps in single quotes and escapes embedded quotes', () => {
    expect(shellQuote('abc')).toBe("'abc'")
    expect(shellQuote("it's")).toBe("'it'\\''s'")
    expect(shellQuote("''")).toBe("''\\'''\\'''")
    expect(shellQuote('')).toBe("''")
  })
  it('keeps $, backticks and newlines literal', () => {
    expect(shellQuote('$HOME `id` $(id)')).toBe("'$HOME `id` $(id)'")
    expect(shellQuote('a\nb')).toBe("'a\nb'")
  })
  it.skipIf(!hasSh)('round-trips through sh', () => {
    for (const v of ["it's", '$HOME `id`', 'a\nb', '"x" \\ y', "'"]) expect(roundTrip(v)).toBe(v)
  })
})

describe('parseEnvLines', () => {
  it('splits on the first = only', () => {
    expect(parseEnvLines(['A=1', 'URL=http://x/?a=b', 'E='])).toEqual([
      ['A', '1'],
      ['URL', 'http://x/?a=b'],
      ['E', '']
    ])
  })
  it('never echoes the offending line', () => {
    expect(() => parseEnvLines(['A=1', 'sekret-token'])).toThrow(/invalid line 2/)
    expect(() => parseEnvLines(['sekret-token'])).not.toThrow(/sekret/)
  })
  it('rejects bad keys and reserved prefix', () => {
    expect(() => parseEnvLines(['1A=x'])).toThrow(/invalid line/)
    expect(() => parseEnvLines(['A-B=x'])).toThrow(/invalid line/)
    expect(() => parseEnvLines(['NOEQUALS'])).toThrow(/KEY=VALUE/)
    expect(() => parseEnvLines(['CD_SERVICE=x'])).toThrow(/reserved/)
  })
})

describe('buildPreamble', () => {
  it('exports every CD_ variable quoted, after user env', () => {
    const p = buildPreamble({
      ...base,
      env: [['DOCKER_IMAGE', "repo/app:it's"]],
      pull: ['app', 'worker'],
      healthCommand: 'curl -f localhost/$PORT'
    })
    expect(p.startsWith("export DOCKER_IMAGE='repo/app:it'\\''s'\n")).toBe(true)
    expect(p).toContain("export CD_DIRECTORY='/srv/app'\n")
    expect(p).toContain("export CD_PULL='app worker'\n")
    expect(p).toContain("export CD_HEALTH_COMMAND='curl -f localhost/$PORT'\n")
    expect(p).toContain("export CD_ROLLBACK='true'\n")
    expect(p).toContain("export CD_PROJECT=''\n")
  })
})

describe('registry password', () => {
  it('is a plain assignment, not exported', () => {
    const p = buildPreamble({ ...base, registryPassword: "p'w" })
    expect(p).toContain("\nCD_REGISTRY_PASSWORD='p'\\''w'\n")
    expect(p).not.toContain('export CD_REGISTRY_PASSWORD')
  })
})

describe('buildSshArgs', () => {
  const common = {
    host: 'vps.example.com',
    port: 2222,
    username: 'deploy',
    knownHostsFile: '/tmp/kh'
  }
  it('key auth', () => {
    const args = buildSshArgs({ ...common, strictHostKey: true, keyFile: '/tmp/key' })
    expect(args.slice(0, 2)).toEqual(['-p', '2222'])
    expect(args).toContain('StrictHostKeyChecking=yes')
    expect(args).toContain('UserKnownHostsFile=/tmp/kh')
    expect(args).toEqual(expect.arrayContaining(['-i', '/tmp/key', 'IdentitiesOnly=yes']))
    expect(args).toContain('BatchMode=yes')
    expect(args).not.toContain('PubkeyAuthentication=no')
    expect(args.slice(-2)).toEqual(['deploy@vps.example.com', 'sh -s'])
  })
  it('password auth uses accept-new and no key', () => {
    const args = buildSshArgs({ ...common, strictHostKey: false })
    expect(args).toContain('StrictHostKeyChecking=accept-new')
    expect(args).toContain('PubkeyAuthentication=no')
    expect(args).toContain('NumberOfPasswordPrompts=1')
    expect(args).not.toContain('-i')
    expect(args).not.toContain('BatchMode=yes')
  })
})

describe('parseResultLines', () => {
  it('extracts key=value lines and ignores noise', () => {
    const out = parseResultLines(
      '[deploy] hi\n@@ci-sdk@@ status=deployed\r\n@@ci-sdk@@ backup-file=\n  @@ci-sdk@@ x=1\n' +
        '@@ci-sdk@@ image-id=sha256:abc=\n@@ci-sdk@@ status=failed\n'
    )
    expect(out).toEqual({ status: 'failed', 'backup-file': '', 'image-id': 'sha256:abc=' })
  })
})

describe('readConfig', () => {
  const ok = { host: 'h.example', username: 'u', directory: '/d', password: 'pw' }

  it('applies defaults and pull falls back to the service', () => {
    inputs({ ...ok, service: 'web', env: 'A=1\n# c\nB=two' })
    const cfg = readConfig()
    expect(cfg).toMatchObject({
      port: 22,
      composeFile: 'compose.yaml',
      pull: ['web'],
      env: [
        ['A', '1'],
        ['B', 'two']
      ],
      healthIntervalSeconds: 5,
      timeout: 20 * 60_000,
      rollback: true
    })
  })
  it('requires exactly one of password / ssh-key', () => {
    inputs({ host: 'h', username: 'u', directory: '/d' })
    expect(() => readConfig()).toThrow(/one of password \/ ssh-key is required/)
    inputs({ ...ok, 'ssh-key': 'KEY' })
    expect(() => readConfig()).toThrow(/only one of/)
  })
  it('rejects bad env keys and conflicting health checks', () => {
    inputs({ ...ok, env: 'bad-key=1', 'health-url': 'u', 'health-command': 'c' })
    expect(() => readConfig()).toThrow(/cannot be combined[\s\S]*invalid line/)
  })
  it('rejects option-like hosts', () => {
    inputs({ ...ok, host: '-oProxyCommand=x' })
    expect(() => readConfig()).toThrow(/host:/)
  })
})

describe('deploy.sh', () => {
  it.skipIf(!hasSh)('passes sh -n', () => {
    const r = spawnSync('sh', ['-n', DEPLOY_SCRIPT], { encoding: 'utf8' })
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
  })

  const SHIM = `#!/bin/sh
printf '%s\\n' "$*" >> "$SHIM_LOG"
case "$*" in
  "tag "*) touch "$SHIM_LOG.tagged" ;;
  *"image inspect"*) for a; do last=$a; done; echo "sha256:\${last#sha256:}" ;;
  *"images -q"*) echo old ;;
  *"up -d --remove-orphans"*) [ -z "$SHIM_UP_FAIL" ] || exit 1 ;;
  *"config --images"*) printf '%s\\n' postgres:16 "\${SHIM_CONFIG_REF:-repo/app:latest}" redis:7 ;;
  *" config app"*) printf '%s\\n' 'name: x' 'services:' '  db:' '    image: postgres:16' '  app:' '    depends_on:' '      db:' '        condition: service_started' "    image: \${SHIM_CONFIG_REF:-repo/app:latest}" ;;
  *"ps -q"*) if [ -z "$SHIM_UP_FAIL" ] || [ -n "$SHIM_KEEP_CID" ] || [ -f "$SHIM_LOG.tagged" ]; then echo cid1; fi ;;
  *"inspect"*"Health"*) echo "\${SHIM_HEALTH:-healthy}" ;;
  *"inspect"*"Config.Image"*) echo "\${SHIM_REF:-repo/app:latest}" ;;
  *"inspect"*"{{.Image}}"*) if [ -f "$SHIM_LOG.tagged" ] && [ -z "$SHIM_BAD_ROLLBACK" ]; then echo sha256:old; else echo sha256:new; fi ;;
  *"login"*) echo "DC=$DOCKER_CONFIG" >> "$SHIM_LOG"; [ ! -f "$DOCKER_CONFIG/config.json" ] || echo HASCFG >> "$SHIM_LOG"; cat >/dev/null ;;
esac
exit 0
`

  const runDeploy = (
    health: string,
    extra: Partial<RemoteConfig> = {},
    shim: Record<string, string> = {}
  ): { status: number | null; stdout: string; results: Record<string, string>; calls: string } => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cd-test-'))
    try {
      const bin = path.join(dir, 'bin')
      const app = path.join(dir, 'app')
      spawnSync('mkdir', ['-p', bin, app])
      writeFileSync(path.join(app, 'compose.yaml'), 'services: {}\n')
      writeFileSync(path.join(bin, 'docker'), SHIM)
      chmodSync(path.join(bin, 'docker'), 0o755)
      const log = path.join(dir, 'docker.log')
      writeFileSync(log, '')
      const stdin =
        buildPreamble({
          ...base,
          directory: app,
          registryUsername: 'bob',
          registryPassword: 'secret-pw',
          ...extra
        }) + readFileSync(DEPLOY_SCRIPT, 'utf8')
      const r = spawnSync('sh', ['-s'], {
        input: stdin,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env['PATH'] ?? ''}`,
          SHIM_LOG: log,
          SHIM_HEALTH: health,
          ...shim
        }
      })
      return {
        status: r.status,
        stdout: r.stdout,
        results: parseResultLines(r.stdout),
        calls: readFileSync(log, 'utf8')
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it.skipIf(process.platform === 'win32')('deploys when healthy', () => {
    const r = runDeploy('healthy')
    expect(r.status).toBe(0)
    expect(r.results).toEqual({
      status: 'deployed',
      'previous-image-id': 'sha256:old',
      'image-id': 'sha256:new',
      'backup-file': ''
    })
    expect(r.calls).toContain('compose -f compose.yaml pull app')
    expect(r.calls).toContain('up -d --remove-orphans')
    expect(r.calls).not.toContain('logout')
    expect(r.calls).toMatch(/DC=\S+/)
    expect(r.calls).not.toContain('secret-pw')
    expect(r.calls).not.toContain('tag ')
  })

  it.skipIf(process.platform === 'win32')('rolls back when health fails', () => {
    const r = runDeploy('unhealthy', { healthRetries: 2 })
    expect(r.status).toBe(1)
    expect(r.results['status']).toBe('rolled-back')
    expect(r.calls).toContain('logs --tail=120 app')
    expect(r.calls).toContain('tag sha256:old repo/app:latest')
    expect(r.calls).toContain('up -d --no-deps app')
    expect(r.results['image-id']).toBe('sha256:old')
  })

  it.skipIf(process.platform === 'win32')('rolls back when compose up fails', () => {
    const r = runDeploy('healthy', {}, { SHIM_UP_FAIL: '1' })
    expect(r.status).toBe(1)
    expect(r.results['status']).toBe('rolled-back')
    expect(r.results['image-id']).toBe('sha256:old')
    expect(r.calls).toContain('logs --tail=120 app')
    expect(r.calls).toContain('config app')
    expect(r.calls).toContain('tag sha256:old repo/app:latest')
  })

  it.skipIf(process.platform === 'win32')(
    'retags the configured ref when the old container still runs',
    () => {
      const r = runDeploy(
        'healthy',
        {},
        { SHIM_UP_FAIL: '1', SHIM_KEEP_CID: '1', SHIM_REF: 'repo/app:old' }
      )
      expect(r.results['status']).toBe('rolled-back')
      expect(r.calls).toContain('tag sha256:old repo/app:latest')
      expect(r.calls).not.toContain('tag sha256:old repo/app:old')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'reports failed when the rollback runs another image',
    () => {
      const r = runDeploy('unhealthy', { healthRetries: 1 }, { SHIM_BAD_ROLLBACK: '1' })
      expect(r.status).toBe(1)
      expect(r.results['status']).toBe('failed')
      expect(r.results['image-id']).toBe('sha256:new')
    }
  )

  it.skipIf(process.platform === 'win32')('does not retag a digest-pinned image', () => {
    const r = runDeploy(
      'unhealthy',
      { healthRetries: 1 },
      { SHIM_CONFIG_REF: 'repo/app@sha256:abc' }
    )
    expect(r.status).toBe(1)
    expect(r.results['status']).toBe('failed')
    expect(r.calls).not.toContain('tag ')
    expect(r.calls).not.toContain('--no-deps')
  })

  it.skipIf(process.platform === 'win32')('never retags a dependency image', () => {
    const r = runDeploy('unhealthy', { healthRetries: 1 })
    expect(r.results['status']).toBe('rolled-back')
    expect(r.calls).toContain('tag sha256:old repo/app:latest')
    expect(r.calls).not.toContain('tag sha256:old postgres')
    expect(r.calls).not.toContain('tag sha256:old redis')
  })

  it.skipIf(process.platform === 'win32')('skips config.json with a credential helper', () => {
    const cfgDir = mkdtempSync(path.join(tmpdir(), 'cd-cfg-'))
    try {
      writeFileSync(path.join(cfgDir, 'config.json'), '{"auths":{"x":{}}}')
      expect(runDeploy('healthy', {}, { DOCKER_CONFIG: cfgDir }).calls).toContain('HASCFG')
      writeFileSync(path.join(cfgDir, 'config.json'), '{"credsStore":"ecr-login"}')
      const r = runDeploy('healthy', {}, { DOCKER_CONFIG: cfgDir })
      expect(r.calls).not.toContain('HASCFG')
      expect(r.stdout).toContain('empty temp config')
    } finally {
      rmSync(cfgDir, { recursive: true, force: true })
    }
  })
})
