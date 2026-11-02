import { InputError } from '../../sdk/src/index.js'

/** POSIX single-quote escaping: safe for any bytes, including newlines and `$`. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Parse `KEY=VALUE` lines (split on the first `=`); keys must be valid shell names. */
export function parseEnvLines(lines: readonly string[]): [string, string][] {
  const issues: { input: string; message: string }[] = []
  const out: [string, string][] = []
  for (const [i, line] of lines.entries()) {
    const eq = line.indexOf('=')
    const key = eq === -1 ? line : line.slice(0, eq)
    if (eq === -1 || !ENV_KEY.test(key)) {
      issues.push({
        input: 'env',
        message: `invalid line ${i + 1}: expected KEY=VALUE (value not shown)`
      })
    } else if (key.startsWith('CD_')) {
      issues.push({ input: 'env', message: `key "${key}" uses the reserved CD_ prefix` })
    } else {
      out.push([key, line.slice(eq + 1)])
    }
  }
  if (issues.length > 0) throw new InputError(issues)
  return out
}

/** Settings handed to deploy.sh as CD_* variables. */
export interface RemoteConfig {
  directory: string
  composeFile: string
  projectName?: string | undefined
  service: string
  pull: readonly string[]
  env: readonly (readonly [string, string])[]
  registry?: string | undefined
  registryUsername?: string | undefined
  registryPassword?: string | undefined
  backup: 'none' | 'postgres'
  dbService: string
  backupDir: string
  backupKeep: number
  healthCommand?: string | undefined
  healthUrl?: string | undefined
  healthRetries: number
  /** Seconds between health attempts. */
  healthIntervalSeconds: number
  rollback: boolean
  logLines: number
}

const exportLine = (key: string, value: string): string => `export ${key}=${shellQuote(value)}\n`

// Plain assignment (no export): docker and compose children must not inherit the password.
const assignLine = (key: string, value: string): string => `${key}=${shellQuote(value)}\n`

/** `export` lines for the remote shell. Values travel via stdin only, never via argv. */
export function buildPreamble(cfg: RemoteConfig): string {
  const cd: [string, string][] = [
    ['CD_DIRECTORY', cfg.directory],
    ['CD_COMPOSE_FILE', cfg.composeFile],
    ['CD_PROJECT', cfg.projectName ?? ''],
    ['CD_SERVICE', cfg.service],
    ['CD_PULL', cfg.pull.join(' ')],
    ['CD_REGISTRY', cfg.registry ?? ''],
    ['CD_REGISTRY_USERNAME', cfg.registryUsername ?? ''],
    ['CD_BACKUP', cfg.backup],
    ['CD_DB_SERVICE', cfg.dbService],
    ['CD_BACKUP_DIR', cfg.backupDir],
    ['CD_BACKUP_KEEP', String(cfg.backupKeep)],
    ['CD_HEALTH_COMMAND', cfg.healthCommand ?? ''],
    ['CD_HEALTH_URL', cfg.healthUrl ?? ''],
    ['CD_HEALTH_RETRIES', String(cfg.healthRetries)],
    ['CD_HEALTH_INTERVAL', String(cfg.healthIntervalSeconds)],
    ['CD_ROLLBACK', String(cfg.rollback)],
    ['CD_LOG_LINES', String(cfg.logLines)]
  ]
  return (
    [...cfg.env, ...cd].map(([k, v]) => exportLine(k, v)).join('') +
    assignLine('CD_REGISTRY_PASSWORD', cfg.registryPassword ?? '')
  )
}

export interface SshArgsOptions {
  host: string
  port: number
  username: string
  knownHostsFile: string
  /** true = StrictHostKeyChecking=yes (known-hosts given), false = accept-new. */
  strictHostKey: boolean
  /** Private key file for key auth; omit for password auth. */
  keyFile?: string | undefined
}

/** ssh argv. No secrets: the password goes through SSH_ASKPASS env, the key through a file. */
export function buildSshArgs(o: SshArgsOptions): string[] {
  const args = [
    '-p',
    String(o.port),
    '-o',
    'ConnectTimeout=20',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=4',
    '-o',
    `UserKnownHostsFile=${o.knownHostsFile}`,
    '-o',
    `StrictHostKeyChecking=${o.strictHostKey ? 'yes' : 'accept-new'}`,
    '-o',
    'LogLevel=ERROR'
  ]
  if (o.keyFile) {
    args.push('-i', o.keyFile, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes')
  } else {
    args.push(
      '-o',
      'PreferredAuthentications=password,keyboard-interactive',
      '-o',
      'PubkeyAuthentication=no',
      '-o',
      'NumberOfPasswordPrompts=1'
    )
  }
  args.push(`${o.username}@${o.host}`, 'sh -s')
  return args
}

/** Collect `@@ci-sdk@@ key=value` lines printed by deploy.sh (last value wins). */
export function parseResultLines(stdout: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of stdout.split('\n')) {
    const m = /^@@ci-sdk@@ ([a-z][a-z-]*)=(.*?)\r?$/.exec(line)
    if (m) out[m[1] as string] = m[2] as string
  }
  return out
}
