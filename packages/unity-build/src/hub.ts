import { CiError, exec, type ExecResult } from '../../sdk/src/index.js'
import { which, type HostEnv } from './locate.js'

/** Hub CLI argv: Electron needs `--` before `--headless` on Windows/macOS; Linux takes it directly. */
export function hubArgs(
  platform: NodeJS.Platform,
  sub: readonly string[],
  isRoot: boolean
): string[] {
  if (platform === 'linux') return [...(isRoot ? ['--no-sandbox'] : []), '--headless', ...sub]
  return ['--', '--headless', ...sub]
}

export function installArgs(
  version: string,
  changeset: string | undefined,
  modules: readonly string[]
): string[] {
  return [
    'install',
    '--version',
    version,
    ...(changeset ? ['--changeset', changeset] : []),
    ...modules.flatMap(m => ['--module', m]),
    ...(modules.length ? ['--childModules'] : [])
  ]
}

export function installModulesArgs(version: string, modules: readonly string[]): string[] {
  return [
    'install-modules',
    '--version',
    version,
    ...modules.flatMap(m => ['--module', m]),
    '--childModules'
  ]
}

export interface HubRunOptions {
  host: HostEnv
  hub: string
  sub: readonly string[]
  timeoutMs: number
  signal?: AbortSignal
}

/**
 * Run a Unity Hub headless command. Hub often exits 0 after a failed
 * download, so the caller must verify the result (editor/module on disk);
 * this only fails on a non-zero exit, with Hub's error lines in the message.
 */
export async function runHub(o: HubRunOptions): Promise<ExecResult> {
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0
  let command = o.hub
  let args = hubArgs(o.host.platform, o.sub, isRoot)
  // Headless Linux runners have no display; Hub (Electron) still wants one.
  const xvfb =
    o.host.platform === 'linux' && !o.host.env.DISPLAY ? which(o.host, 'xvfb-run') : undefined
  if (xvfb) {
    args = ['-a', command, ...args]
    command = xvfb
  }
  const res = await exec(command, args, {
    timeout: o.timeoutMs,
    signal: o.signal,
    allowFailure: true
  })
  if (res.exitCode !== 0) {
    throw new CiError(
      'E_UNITY_HUB',
      `Unity Hub "${o.sub.join(' ')}" exited with code ${res.exitCode}${hubErrors(res)}`
    )
  }
  return res
}

/** Hub's own error lines, for messages. */
export function hubErrors(res: Pick<ExecResult, 'stdout' | 'stderr'>): string {
  const lines = `${res.stdout}\n${res.stderr}`
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => /\berror\b|failed/i.test(l))
  return lines.length ? `: ${[...new Set(lines)].slice(0, 5).join(' | ')}` : ''
}
