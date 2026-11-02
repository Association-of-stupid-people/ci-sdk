import { randomUUID } from 'node:crypto'
import * as core from '@actions/core'
import {
  CiError,
  getCiContext,
  group,
  input,
  mask,
  parseCommandLine,
  printUntrusted,
  readInputs,
  sleep
} from '../../sdk/src/index.js'
import {
  buildRunArgs,
  dockerRunner,
  httpProbe,
  inspectState,
  matchesStatus,
  ownsContainer,
  parseEnvLines,
  removeResources,
  waitForHealthy,
  type CleanupInfo,
  type ContainerState,
  type DockerRunner
} from './docker.js'

export interface Deps {
  docker: DockerRunner
  sleep: (ms: number) => Promise<void>
  fetch: typeof fetch
}

const defaultDeps = (): Deps => ({ docker: dockerRunner, sleep: async ms => sleep(ms), fetch })

/** `smoke-<run>-<attempt>[-<step id>]`, so two steps in one job do not collide. */
export function defaultName(env: NodeJS.ProcessEnv = process.env): string {
  const base = getCiContext(env).uniqueName('smoke')
  const step = (env.GITHUB_ACTION ?? '').replace(/[^a-zA-Z0-9_.-]/g, '-')
  return step ? `${base}-${step}` : base
}

const PULL = ['missing', 'always', 'never'] as const

/** Run the container, wait for health, and clean up (unless `keep`). */
export async function run(overrides: Partial<Deps> = {}): Promise<void> {
  core.saveState('isPost', 'true')
  const deps = { ...defaultDeps(), ...overrides }
  const { docker } = deps

  const cfg = readInputs({
    image: input.string({ required: true }),
    name: input.string({ default: defaultName() }),
    command: input.string(),
    args: input.string(),
    env: input.lines(),
    secretEnv: input.lines({ name: 'secret-env' }),
    ports: input.lines(),
    network: input.string(),
    networkAlias: input.lines({ name: 'network-alias' }),
    pull: input.oneOf(PULL, { default: 'missing' }),
    healthUrl: input.string({ name: 'health-url' }),
    expectStatus: input.string({ name: 'expect-status', default: '2xx' }),
    expectBody: input.string({ name: 'expect-body' }),
    healthCommand: input.string({ name: 'health-command' }),
    healthRetries: input.number({ name: 'health-retries', default: 30, min: 1, integer: true }),
    healthInterval: input.duration({ name: 'health-interval', default: '2s' }),
    keep: input.boolean({ default: false }),
    logsOnFailure: input.boolean({ name: 'logs-on-failure', default: true }),
    logLines: input.number({ name: 'log-lines', default: 200, min: 1, integer: true })
  })

  // Validate everything before touching Docker.
  matchesStatus(200, cfg.expectStatus)
  const secretEnv = parseEnvLines(cfg.secretEnv ?? [], 'secret-env')
  for (const [, value] of secretEnv) mask(value)
  const label = randomUUID()
  const { argv, env } = buildRunArgs({
    label,
    image: cfg.image,
    name: cfg.name,
    command: cfg.command ? parseCommandLine(cfg.command) : undefined,
    args: cfg.args ? parseCommandLine(cfg.args) : undefined,
    env: parseEnvLines(cfg.env ?? []),
    secretEnv,
    ports: cfg.ports,
    network: cfg.network,
    networkAlias: cfg.networkAlias,
    pull: cfg.pull
  })

  const info: CleanupInfo = { container: cfg.name, createdNetwork: false, label }
  if (cfg.network) info.network = cfg.network
  core.setOutput('name', cfg.name)
  core.setOutput('healthy', 'false')
  core.setOutput('attempts', '0')

  let failed = true
  try {
    if (cfg.network) {
      const exists = await docker(['network', 'inspect', cfg.network])
      if (exists.exitCode !== 0) {
        const created = await docker(['network', 'create', cfg.network])
        if (created.exitCode !== 0) {
          throw new CiError('E_DOCKER', `docker network create failed: ${created.stderr.trim()}`)
        }
        info.createdNetwork = true
      }
    }
    // Saved before `docker run`; cleanup only removes a container carrying our label.
    core.saveState('cleanup', JSON.stringify(info))

    const started = await docker(argv, { env })
    if (started.exitCode !== 0) {
      throw new CiError('E_DOCKER', `docker run failed: ${started.stderr.trim()}`)
    }
    core.setOutput('container-id', started.stdout.trim().split(/\r?\n/).pop() ?? '')

    const probe = async (state: ContainerState): Promise<boolean> => {
      if (cfg.healthUrl) {
        return httpProbe({
          url: cfg.healthUrl,
          status: cfg.expectStatus,
          body: cfg.expectBody,
          fetch: deps.fetch
        })
      }
      if (cfg.healthCommand) {
        const r = await docker(['exec', cfg.name, 'sh', '-c', cfg.healthCommand])
        return r.exitCode === 0
      }
      return state.health !== undefined ? state.health === 'healthy' : state.running
    }

    const result = await waitForHealthy({
      retries: cfg.healthRetries,
      intervalMs: cfg.healthInterval,
      getState: async () => inspectState(docker, cfg.name),
      probe,
      sleep: deps.sleep
    })
    core.setOutput('attempts', String(result.attempts))
    if (!result.healthy) {
      throw new CiError(
        'E_UNHEALTHY',
        `Container ${cfg.name} not healthy after ${result.attempts} attempts`
      )
    }
    core.setOutput('healthy', 'true')
    core.info(`Container ${cfg.name} healthy after ${result.attempts} attempt(s)`)
    failed = false
  } catch (err) {
    if (cfg.logsOnFailure && (await ownsContainer(docker, info))) {
      await dumpLogs(docker, cfg.name, cfg.logLines)
    }
    throw err
  } finally {
    // Failures are always cleaned up at once; `keep` only protects a passing container.
    if (!cfg.keep || failed) {
      await removeResources(docker, info, core.warning)
      core.saveState('cleaned', 'true')
    }
  }
}

async function dumpLogs(docker: DockerRunner, name: string, lines: number): Promise<void> {
  try {
    await group(`Logs of ${name} (last ${lines} lines)`, async () => {
      const r = await docker(['logs', '--tail', String(lines), name])
      printUntrusted(`${r.stdout}${r.stderr}`)
    })
  } catch (err) {
    core.warning(`Could not read logs: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Post step: remove what the main step left behind. No-op when empty or already cleaned. */
export async function cleanup(overrides: Partial<Deps> = {}): Promise<void> {
  const raw = core.getState('cleanup')
  if (raw === '' || core.getState('cleaned') === 'true') return
  let info: CleanupInfo
  try {
    info = JSON.parse(raw) as CleanupInfo
  } catch {
    core.warning('Ignoring unreadable cleanup state')
    return
  }
  const docker = overrides.docker ?? dockerRunner
  await removeResources(docker, info, core.warning)
  core.saveState('cleaned', 'true')
}
