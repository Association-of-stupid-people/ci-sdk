import { CiError, exec } from '../../sdk/src/index.js'

export interface DockerResult {
  exitCode: number | null
  stdout: string
  stderr: string
}

export interface DockerCallOptions {
  /** Extra variables for the docker CLI process (used to pass `-e KEY` values). */
  env?: Record<string, string>
  timeout?: number
}

/** Runs `docker <args>`; never throws on a non-zero exit. Injectable for tests. */
export type DockerRunner = (args: string[], options?: DockerCallOptions) => Promise<DockerResult>

export const dockerRunner: DockerRunner = async (args, options = {}) => {
  const r = await exec('docker', args, {
    env: options.env,
    timeout: options.timeout,
    silent: true,
    allowFailure: true
  })
  return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }
}

export type PullPolicy = 'missing' | 'always' | 'never'

export interface RunSpec {
  image: string
  name: string
  command?: string[]
  args?: string[]
  env?: [string, string][]
  secretEnv?: [string, string][]
  ports?: string[]
  network?: string
  networkAlias?: string[]
  pull?: PullPolicy
  /** Ownership token, set as the `ci-sdk.smoke` label. */
  label?: string
}

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/
/** Keys that would change how the docker CLI itself behaves when set in its environment. */
const RESERVED_KEY = /^(DOCKER_.*|PATH|HOME|USERPROFILE|SYSTEMROOT)$/i

/** Parse `KEY=VALUE` lines (split on the first `=`; empty values allowed). */
export function parseEnvLines(lines: readonly string[], label = 'env'): [string, string][] {
  const seen = new Set<string>()
  return lines.map((line, n) => {
    const i = line.indexOf('=')
    const key = i < 0 ? line : line.slice(0, i)
    if (i < 0 || !KEY.test(key)) {
      // Never echo the line or key: a malformed line may be a bare secret value.
      throw new CiError('E_INPUT', `${label} line ${n + 1}: expected KEY=VALUE with a valid KEY`)
    }
    if (RESERVED_KEY.test(key)) throw new CiError('E_INPUT', `${label}: key ${key} is reserved`)
    if (seen.has(key)) throw new CiError('E_INPUT', `${label}: duplicate key ${key}`)
    seen.add(key)
    return [key, line.slice(i + 1)]
  })
}

/** `docker run` argv plus the env for the docker process. Env values are never in argv. */
export function buildRunArgs(spec: RunSpec): { argv: string[]; env: Record<string, string> } {
  const envPairs = [...(spec.env ?? []), ...(spec.secretEnv ?? [])]
  const keys = envPairs.map(([k]) => k)
  if (new Set(keys).size !== keys.length) {
    throw new CiError('E_INPUT', 'env and secret-env define the same key twice')
  }
  if ((spec.networkAlias?.length ?? 0) > 0 && !spec.network) {
    throw new CiError('E_INPUT', 'network-alias requires network')
  }

  const argv = ['run', '-d', '--name', spec.name, '--pull', spec.pull ?? 'missing']
  if (spec.label) argv.push('--label', `${LABEL_KEY}=${spec.label}`)
  if (spec.network) argv.push('--network', spec.network)
  for (const alias of spec.networkAlias ?? []) argv.push('--network-alias', alias)
  for (const port of spec.ports ?? []) argv.push('-p', port)
  for (const key of keys) argv.push('-e', key)
  argv.push(...(spec.args ?? []), spec.image, ...(spec.command ?? []))
  return { argv, env: Object.fromEntries(envPairs) }
}

/** True when `code` is allowed by `spec`: classes (`2xx`) and/or exact codes (`200,204`). */
export function matchesStatus(code: number, spec: string): boolean {
  const tokens = spec
    .split(',')
    .map(t => t.trim().toLowerCase())
    .filter(t => t !== '')
  if (tokens.length === 0) throw new CiError('E_INPUT', 'expect-status is empty')
  let ok = false
  for (const t of tokens) {
    if (/^[1-5]xx$/.test(t)) ok ||= Math.floor(code / 100) === Number(t[0])
    else if (/^\d{3}$/.test(t)) ok ||= code === Number(t)
    else throw new CiError('E_INPUT', `expect-status: invalid token "${t}" (use 2xx or 200,204)`)
  }
  return ok
}

export interface HttpProbeOptions {
  url: string
  status: string
  body?: string
  timeoutMs?: number
  fetch?: typeof fetch
}

/** One HTTP attempt: true when status and (optional) body match. Network errors are false. */
export async function httpProbe(o: HttpProbeOptions): Promise<boolean> {
  const doFetch = o.fetch ?? fetch
  try {
    const res = await doFetch(o.url, { signal: AbortSignal.timeout(o.timeoutMs ?? 5_000) })
    if (!matchesStatus(res.status, o.status)) {
      await res.body?.cancel()
      return false
    }
    if (o.body === undefined) {
      await res.body?.cancel()
      return true
    }
    return (await res.text()).includes(o.body)
  } catch {
    return false
  }
}

export interface ContainerState {
  status: string
  running: boolean
  exitCode: number
  /** Docker HEALTHCHECK status, when the image defines one. */
  health?: string
}

export async function inspectState(docker: DockerRunner, name: string): Promise<ContainerState> {
  const r = await docker(['inspect', '--format', '{{json .State}}', name])
  if (r.exitCode !== 0) {
    throw new CiError('E_DOCKER', `docker inspect ${name} failed: ${r.stderr.trim()}`)
  }
  const s = JSON.parse(r.stdout) as {
    Status?: string
    Running?: boolean
    ExitCode?: number
    Health?: { Status?: string }
  }
  return {
    status: s.Status ?? '',
    running: s.Running === true,
    exitCode: s.ExitCode ?? 0,
    health: s.Health?.Status
  }
}

export interface WaitOptions {
  retries: number
  intervalMs: number
  getState: () => Promise<ContainerState>
  probe: (state: ContainerState) => Promise<boolean>
  sleep: (ms: number) => Promise<void>
}

export interface WaitResult {
  healthy: boolean
  attempts: number
}

/**
 * Poll until `probe` succeeds or `retries` attempts are used.
 * @throws {CiError} as soon as the container has exited.
 */
export async function waitForHealthy(o: WaitOptions): Promise<WaitResult> {
  for (let attempt = 1; attempt <= o.retries; attempt++) {
    const state = await o.getState()
    if (state.status === 'exited' || state.status === 'dead') {
      throw new CiError(
        'E_CONTAINER_EXITED',
        `Container ${state.status} with exit code ${state.exitCode} (attempt ${attempt})`
      )
    }
    if (await o.probe(state)) return { healthy: true, attempts: attempt }
    if (attempt < o.retries) await o.sleep(o.intervalMs)
  }
  return { healthy: false, attempts: o.retries }
}

export interface CleanupInfo {
  container: string
  network?: string
  createdNetwork: boolean
  /** Random token put on the container as a label; only a container carrying it is ours. */
  label: string
}

export const LABEL_KEY = 'ci-sdk.smoke'

/** True when a container named `info.container` exists and carries our label. */
export async function ownsContainer(docker: DockerRunner, info: CleanupInfo): Promise<boolean> {
  const r = await docker([
    'container',
    'inspect',
    '-f',
    `{{index .Config.Labels "${LABEL_KEY}"}}`,
    info.container
  ])
  return r.exitCode === 0 && r.stdout.trim() === info.label
}

/** Remove the container, then the network if this action created it. Errors only warn. */
export async function removeResources(
  docker: DockerRunner,
  info: CleanupInfo,
  warn: (message: string) => void
): Promise<void> {
  const attempt = async (args: string[]): Promise<void> => {
    try {
      const r = await docker(args)
      if (r.exitCode !== 0 && !/no such/i.test(r.stderr)) {
        warn(`docker ${args.join(' ')} failed: ${r.stderr.trim()}`)
      }
    } catch (err) {
      warn(`docker ${args.join(' ')} failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  let owned = false
  try {
    owned = await ownsContainer(docker, info)
  } catch (err) {
    warn(`docker container inspect failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (owned) await attempt(['rm', '-f', '-v', info.container])
  if (info.createdNetwork && info.network) await attempt(['network', 'rm', info.network])
}
