import * as core from '@actions/core'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  InputError,
  exec,
  getCiContext,
  input,
  mask,
  readInputs,
  withoutCommands
} from '../../sdk/src/index.js'
import {
  buildPreamble,
  buildSshArgs,
  parseEnvLines,
  parseResultLines,
  type RemoteConfig
} from './ssh.js'

/** Bundled remote script (sources: ../assets; bundle: <action>/dist/index.js -> ../assets). */
export const DEPLOY_SCRIPT = fileURLToPath(new URL('../assets/deploy.sh', import.meta.url))

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/
const HOST = /^[A-Za-z0-9_.:%[\]-]+$/
const USER = /^[^\s@-][^\s@]*$/

export interface DeployConfig extends RemoteConfig {
  host: string
  port: number
  username: string
  password?: string | undefined
  sshKey?: string | undefined
  knownHosts?: string | undefined
  timeout: number
}

export function readConfig(): DeployConfig {
  const c = readInputs({
    host: input.string({ required: true, pattern: HOST }),
    port: input.number({ default: 22, min: 1, max: 65535, integer: true }),
    username: input.string({ required: true, pattern: USER }),
    password: input.string({ secret: true }),
    sshKey: input.string({ name: 'ssh-key', secret: true }),
    knownHosts: input.string({ name: 'known-hosts' }),
    directory: input.string({ required: true }),
    composeFile: input.string({ name: 'compose-file', default: 'compose.yaml' }),
    projectName: input.string({ name: 'project-name', pattern: NAME }),
    service: input.string({ default: 'app', pattern: NAME }),
    pull: input.lines(),
    env: input.lines(),
    registry: input.string(),
    registryUsername: input.string({ name: 'registry-username' }),
    registryPassword: input.string({ name: 'registry-password', secret: true }),
    backup: input.oneOf(['none', 'postgres'] as const, { default: 'none' }),
    dbService: input.string({ name: 'db-service', default: 'db', pattern: NAME }),
    backupDir: input.string({ name: 'backup-dir', default: 'backups' }),
    backupKeep: input.number({ name: 'backup-keep', default: 10, min: 1, integer: true }),
    healthCommand: input.string({ name: 'health-command' }),
    healthUrl: input.string({ name: 'health-url' }),
    healthRetries: input.number({
      name: 'health-retries',
      default: 30,
      min: 1,
      max: 1000,
      integer: true
    }),
    healthInterval: input.duration({ name: 'health-interval', default: '5s' }),
    rollback: input.boolean({ default: true }),
    logLines: input.number({ name: 'log-lines', default: 120, min: 0, integer: true }),
    timeout: input.duration({ default: '20m' })
  })

  const issues: { input: string; message: string }[] = []
  if (c.password && c.sshKey) {
    issues.push({ input: 'password', message: 'set only one of password / ssh-key' })
  } else if (!c.password && !c.sshKey) {
    issues.push({ input: 'password', message: 'one of password / ssh-key is required' })
  }
  if (c.healthCommand && c.healthUrl) {
    issues.push({ input: 'health-command', message: 'cannot be combined with health-url' })
  }
  if (c.registryUsername && !c.registryPassword) {
    issues.push({ input: 'registry-password', message: 'is required with registry-username' })
  }
  if (c.registryPassword && !c.registryUsername) {
    issues.push({ input: 'registry-username', message: 'is required with registry-password' })
  }
  if (c.registry && !c.registryUsername) {
    issues.push({ input: 'registry-username', message: 'is required with registry' })
  }
  const pull = c.pull ?? []
  for (const p of pull) {
    if (!NAME.test(p)) issues.push({ input: 'pull', message: `invalid service name "${p}"` })
  }
  let env: [string, string][] = []
  try {
    env = parseEnvLines(c.env ?? [])
  } catch (err) {
    if (err instanceof InputError) issues.push(...err.issues)
    else throw err
  }
  if (issues.length > 0) throw new InputError(issues)

  return {
    host: c.host,
    port: c.port,
    username: c.username,
    password: c.password,
    sshKey: c.sshKey,
    knownHosts: c.knownHosts,
    directory: c.directory,
    composeFile: c.composeFile,
    projectName: c.projectName,
    service: c.service,
    pull: pull.length > 0 ? pull : [c.service],
    env,
    registry: c.registry,
    registryUsername: c.registryUsername,
    registryPassword: c.registryPassword,
    backup: c.backup,
    dbService: c.dbService,
    backupDir: c.backupDir,
    backupKeep: c.backupKeep,
    healthCommand: c.healthCommand,
    healthUrl: c.healthUrl,
    healthRetries: c.healthRetries,
    healthIntervalSeconds: c.healthInterval / 1000,
    rollback: c.rollback,
    logLines: c.logLines,
    timeout: c.timeout
  }
}

export interface DeployResult {
  status: 'deployed' | 'rolled-back' | 'failed'
  previousImageId: string
  imageId: string
  backupFile: string
}

async function writeSummary(cfg: DeployConfig, r: DeployResult): Promise<void> {
  if (!process.env['GITHUB_STEP_SUMMARY']) return
  const code = (v: string): string => (v ? `\`${v}\`` : '-')
  await core.summary
    .addHeading('Compose deploy', 2)
    .addTable([
      [
        { data: 'Field', header: true },
        { data: 'Value', header: true }
      ],
      ['Host', code(cfg.host)],
      ['Directory', code(cfg.directory)],
      ['Service', code(cfg.service)],
      ['Status', r.status],
      ['Backup file', code(r.backupFile)],
      ['Previous image', code(r.previousImageId)],
      ['Image', code(r.imageId)]
    ])
    .write()
}

/** Open an SSH session to the VPS and run deploy.sh with settings piped via stdin. */
export async function run(): Promise<DeployResult> {
  const cfg = readConfig()
  // A multi-line key or password would not be masked line by line otherwise.
  for (const s of [cfg.password, cfg.sshKey, cfg.registryPassword]) {
    for (const part of (s ?? '').split(/\r?\n/)) if (part.trim()) mask(part.trim())
  }

  const script = await readFile(DEPLOY_SCRIPT, 'utf8')
  const stdin = buildPreamble(cfg) + script

  const dir = await mkdtemp(path.join(getCiContext().runner.temp ?? tmpdir(), 'ci-sdk-deploy-'))
  let result: DeployResult = { status: 'failed', previousImageId: '', imageId: '', backupFile: '' }
  try {
    const knownHostsFile = path.join(dir, 'known_hosts')
    await writeFile(knownHostsFile, cfg.knownHosts ? `${cfg.knownHosts.trim()}\n` : '', {
      mode: 0o600
    })
    if (!cfg.knownHosts) {
      core.warning(
        'known-hosts is not set: the host key is accepted on first use. Set known-hosts to pin it.'
      )
    }

    const env: Record<string, string> = {}
    let keyFile: string | undefined
    if (cfg.sshKey) {
      keyFile = path.join(dir, 'id_key')
      await writeFile(keyFile, cfg.sshKey.endsWith('\n') ? cfg.sshKey : `${cfg.sshKey}\n`, {
        mode: 0o600
      })
      await chmod(keyFile, 0o600)
    } else {
      const askpass = path.join(dir, 'askpass.sh')
      await writeFile(askpass, '#!/bin/sh\nprintf \'%s\\n\' "$CI_SDK_SSH_PASSWORD"\n', {
        mode: 0o700
      })
      await chmod(askpass, 0o700)
      env['SSH_ASKPASS'] = askpass
      env['SSH_ASKPASS_REQUIRE'] = 'force'
      if (!process.env['DISPLAY']) env['DISPLAY'] = ':0'
      env['CI_SDK_SSH_PASSWORD'] = cfg.password ?? ''
    }

    const args = buildSshArgs({
      host: cfg.host,
      port: cfg.port,
      username: cfg.username,
      knownHostsFile,
      strictHostKey: Boolean(cfg.knownHosts),
      keyFile
    })

    // Remote output is untrusted: keep workflow commands off while it streams.
    const res = await withoutCommands(async () =>
      exec('ssh', args, { input: stdin, env, timeout: cfg.timeout, allowFailure: true })
    )
    const out = parseResultLines(res.stdout)
    const status = out['status']
    result = {
      status:
        res.exitCode === 0 && status === 'deployed'
          ? 'deployed'
          : status === 'rolled-back'
            ? 'rolled-back'
            : 'failed',
      previousImageId: out['previous-image-id'] ?? '',
      imageId: out['image-id'] ?? '',
      backupFile: out['backup-file'] ?? ''
    }
    if (result.status === 'failed') {
      core.setFailed(
        res.exitCode === 255
          ? 'SSH connection or authentication failed'
          : `Deploy failed (exit code ${String(res.exitCode)})`
      )
    } else if (result.status === 'rolled-back') {
      core.setFailed(
        'Deploy failed (compose up or health check); rolled back to the previous image'
      )
    }
    return result
  } finally {
    core.setOutput('status', result.status)
    core.setOutput('previous-image-id', result.previousImageId)
    core.setOutput('image-id', result.imageId)
    core.setOutput('backup-file', result.backupFile)
    await writeSummary(cfg, result).catch(() => undefined)
    await rm(dir, { recursive: true, force: true })
  }
}
