import * as core from '@actions/core'
import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  CiError,
  InputError,
  Pipeline,
  annotate,
  getCiContext,
  input,
  readInputs,
  type PipelineReport,
  type StepContext
} from '../../sdk/src/index.js'
import { DEFAULT_ARGS, buildUnityArgs, modulesForTarget } from './args.js'
import {
  CONTAINER_PROJECT,
  CONTAINER_ULF,
  DEFAULT_DOCKERFILE,
  containerPath,
  dockerRunArgs,
  ensureImage,
  imageTag,
  stopContainer,
  type Mount
} from './docker.js'
import { hubErrors, installArgs, installModulesArgs, runHub } from './hub.js'
import {
  currentHost,
  editorCandidates,
  findEditor,
  findHub,
  hubCandidates,
  missingModules,
  type HostEnv
} from './locate.js'
import type { UnityIssue } from './log-scan.js'
import { summaryMarkdown } from './summary.js'
import { UnityBuildError, runUnity, type FailureKind } from './unity.js'
import { UNITY_VERSION, lookupChangeset, parseProjectVersion } from './version.js'

/** Environment variables a BuildScript reads instead of command-line flags. */
export const KEYSTORE_ENV = {
  path: 'UNITY_KEYSTORE_PATH',
  password: 'UNITY_KEYSTORE_PASS',
  alias: 'UNITY_KEYALIAS_NAME',
  aliasPassword: 'UNITY_KEYALIAS_PASS'
} as const

const readSpecs = {
  workdir: input.string({ default: '.' }),
  version: input.string(),
  changeset: input.string({ pattern: /^[0-9a-f]{12}$/ }),
  mode: input.oneOf(['host', 'docker'] as const, { default: 'host' }),
  defaultArgs: input.string({ name: 'default-args-override', default: DEFAULT_ARGS }),
  args: input.string({ default: '' }),
  timeout: input.duration({ default: '3h' }),
  idleTimeout: input.duration({ name: 'idle-timeout', default: '30m' }),
  licenseRetries: input.number({
    name: 'license-retries',
    default: 2,
    min: 0,
    max: 10,
    integer: true
  }),
  licenseRetryDelay: input.duration({ name: 'license-retry-delay', default: '30s' }),
  licensePatterns: input.lines({ name: 'license-error-patterns', default: [] }),
  keystorePath: input.string({ name: 'keystore-path' }),
  keystorePassword: input.string({ name: 'keystore-password', secret: true }),
  keystoreAlias: input.string({ name: 'keystore-alias' }),
  keystoreAliasPassword: input.string({ name: 'keystore-alias-password', secret: true }),
  install: input.boolean({ default: true }),
  modules: input.list({ default: ['auto'] }),
  editorPath: input.string({ name: 'editor-path' }),
  editorsDir: input.list({ name: 'editors-dir', default: [] }),
  hubPath: input.string({ name: 'hub-path' }),
  installTimeout: input.duration({ name: 'install-timeout', default: '1h' }),
  dockerImage: input.string({ name: 'docker-image' }),
  dockerRepo: input.string({ name: 'docker-image-repo', default: 'ci-unity-editor' }),
  dockerfile: input.string({ name: 'dockerfile' }),
  dockerEnv: input.list({ name: 'docker-env', default: [] }),
  gradleVolume: input.string({ name: 'docker-gradle-volume', default: 'ci-unity-gradle' }),
  licenseFile: input.string({ name: 'unity-license-file' }),
  serial: input.string({ name: 'unity-serial', secret: true }),
  email: input.string({ name: 'unity-email', secret: true }),
  password: input.string({ name: 'unity-password', secret: true }),
  cleanGradle: input.oneOf(['auto', 'true', 'false'] as const, {
    name: 'clean-gradle-cache',
    default: 'auto'
  }),
  summary: input.boolean({ default: true })
}

interface State {
  editor?: string
  image?: string
  attempts: number
  failureKind?: FailureKind
  issues: UnityIssue[]
  totalIssues: number
  error?: string
}

export interface RunOptions {
  host?: HostEnv
}

/**
 * Variables a JavaScript action receives that a `run:` step never had: the
 * action's own inputs (secrets included) and the runner's cache/artifact/OIDC
 * tokens. Unity, editor scripts and Gradle plugins must not see them.
 */
const PRIVATE_ENV =
  /^(?:INPUT_|ACTIONS_RUNTIME_|ACTIONS_ID_TOKEN_REQUEST_|ACTIONS_CACHE_URL$|ACTIONS_RESULTS_URL$)/i

export function childEnv(
  extra: Record<string, string | undefined>,
  base: NodeJS.ProcessEnv = process.env
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(base)) if (!PRIVATE_ENV.test(k)) env[k] = v
  return { ...env, ...extra }
}

function parsePatterns(lines: readonly string[]): RegExp[] {
  const bad: string[] = []
  const out = lines.flatMap(l => {
    try {
      return [new RegExp(l, 'i')]
    } catch {
      bad.push(l)
      return []
    }
  })
  if (bad.length) {
    throw new InputError(
      bad.map(b => ({ input: 'license-error-patterns', message: `invalid regex: ${b}` }))
    )
  }
  return out
}

async function readProjectVersion(
  projectDir: string
): Promise<ReturnType<typeof parseProjectVersion>> {
  try {
    const file = path.join(projectDir, 'ProjectSettings', 'ProjectVersion.txt')
    return parseProjectVersion(await readFile(file, 'utf8'))
  } catch {
    return undefined
  }
}

export async function run(options: RunOptions = {}): Promise<PipelineReport> {
  const cfg = readInputs(readSpecs)
  const host = options.host ?? currentHost()
  const ci = getCiContext()
  const licensePatterns = parsePatterns(cfg.licensePatterns)
  const projectDir = path.resolve(process.cwd(), cfg.workdir)

  // Version: input, then the UNITY_VER variable, then the project itself.
  const project = await readProjectVersion(projectDir)
  const version = cfg.version || process.env.UNITY_VER?.trim() || project?.version
  if (!version) {
    throw new InputError([
      {
        input: 'version',
        message: `is required (no UNITY_VER and no ProjectSettings/ProjectVersion.txt in ${projectDir})`
      }
    ])
  }
  if (!UNITY_VERSION.test(version)) core.warning(`"${version}" does not look like a Unity version`)
  if (project && project.version !== version) {
    core.warning(
      `Building with Unity ${version} but the project is on ${project.version}; Unity will upgrade the project`
    )
  }
  let changeset = cfg.changeset || (project?.version === version ? project.changeset : undefined)
  const resolveChangeset = async (): Promise<string | undefined> =>
    (changeset ??= await lookupChangeset(version, { onWarning: m => core.warning(m) }))

  const inDocker = cfg.mode === 'docker'
  const unityProjectDir = inDocker ? CONTAINER_PROJECT : projectDir
  const argsInput = { defaultArgs: cfg.defaultArgs, args: cfg.args, env: process.env }
  const unity = buildUnityArgs({ ...argsInput, projectDir: unityProjectDir })
  for (const flag of unity.secretFlags) {
    core.warning(
      `${flag} is on the Unity command line (visible in process lists); use the keystore-* / unity-* inputs, which pass it through environment variables`
    )
  }
  for (const name of unity.unresolved) {
    core.warning(`$${name} in the Unity arguments is not set; it is passed literally (no shell)`)
  }
  const modules = cfg.modules.includes('auto')
    ? modulesForTarget(unity.buildTarget, inDocker ? 'linux' : host.platform)
    : cfg.modules.filter(m => m !== 'none')
  // A -logFile written with $(pwd) points into the container in docker mode; resolve it on the host.
  const hostLogArg = inDocker ? buildUnityArgs({ ...argsInput, projectDir }).logFile : unity.logFile
  const logFile = path.resolve(
    projectDir,
    hostLogArg ?? path.join(ci.runner.temp ?? os.tmpdir(), `${ci.uniqueName('unity-build')}.log`)
  )

  // Keystore and license secrets travel as environment variables only.
  const secretsEnv: Record<string, string> = {}
  const mounts: Mount[] = []
  if (cfg.keystorePath) {
    const hostFile = path.resolve(projectDir, cfg.keystorePath)
    if (!host.exists(hostFile)) core.warning(`keystore-path does not exist: ${hostFile}`)
    if (inDocker) {
      const mapped = containerPath(hostFile, projectDir, '/ci-keystore')
      if (mapped.mount) mounts.push(mapped.mount)
      secretsEnv[KEYSTORE_ENV.path] = mapped.path
    } else {
      secretsEnv[KEYSTORE_ENV.path] = hostFile
    }
  }
  if (cfg.keystorePassword) secretsEnv[KEYSTORE_ENV.password] = cfg.keystorePassword
  if (cfg.keystoreAlias) secretsEnv[KEYSTORE_ENV.alias] = cfg.keystoreAlias
  if (cfg.keystoreAliasPassword) secretsEnv[KEYSTORE_ENV.aliasPassword] = cfg.keystoreAliasPassword
  const licenseGiven = Boolean(cfg.licenseFile || cfg.serial)
  if (inDocker) {
    if (cfg.serial) secretsEnv.UNITY_SERIAL = cfg.serial
    if (cfg.email) secretsEnv.UNITY_EMAIL = cfg.email
    if (cfg.password) secretsEnv.UNITY_PASSWORD = cfg.password
    if (cfg.licenseFile) {
      const ulf = path.resolve(projectDir, cfg.licenseFile)
      // A missing bind source would be created by Docker as a root-owned directory.
      if (!host.exists(ulf)) {
        throw new InputError([{ input: 'unity-license-file', message: `not found: ${ulf}` }])
      }
      mounts.push({ host: ulf, container: CONTAINER_ULF, readonly: true })
    }
    if (!licenseGiven)
      core.warning(
        'mode: docker without unity-license-file or unity-serial: Unity will have no license'
      )
    if (typeof process.getuid === 'function' && typeof process.getgid === 'function') {
      secretsEnv.HOST_UID = String(process.getuid())
      secretsEnv.HOST_GID = String(process.getgid())
    }
  } else if (licenseGiven) {
    core.warning(
      'unity-license-file / unity-serial are used in mode: docker only; the host editor uses its own activation'
    )
  }

  // Redacted from the log file (Unity echoes its command line at the top of the log).
  const secrets = [
    cfg.keystorePassword,
    cfg.keystoreAliasPassword,
    cfg.serial,
    cfg.email,
    cfg.password,
    ...unity.secretValues
  ].filter((s): s is string => Boolean(s))

  const state: State = { attempts: 0, issues: [], totalIssues: 0 }
  const requireHub = (): string => {
    const hub = cfg.hubPath || findHub(host)
    if (!hub) {
      throw new CiError(
        'E_UNITY_HUB',
        `Unity Hub not found (looked in: ${hubCandidates(host).join(', ')}); install it on the runner or set hub-path`
      )
    }
    return hub
  }

  const resolveEditor = async (ctx: StepContext<State>): Promise<void> => {
    const explicit = cfg.editorPath ? path.resolve(process.cwd(), cfg.editorPath) : undefined
    let editor = explicit ?? findEditor(host, version, cfg.editorsDir)
    if (explicit && !host.exists(explicit)) {
      throw new CiError('E_UNITY_NOT_FOUND', `editor-path does not exist: ${explicit}`)
    }
    if (!editor) {
      if (!cfg.install) {
        throw new CiError(
          'E_UNITY_NOT_FOUND',
          `Unity ${version} not found. Looked in:\n  ${editorCandidates(host, version, cfg.editorsDir).join('\n  ')}\nSet install: true, editors-dir or editor-path.`
        )
      }
      const hub = requireHub()
      core.info(
        `Unity ${version} is not installed: installing with Unity Hub (${modules.join(', ') || 'no modules'})`
      )
      const res = await runHub({
        host,
        hub,
        sub: installArgs(version, await resolveChangeset(), modules),
        timeoutMs: cfg.installTimeout,
        signal: ctx.signal
      })
      editor = findEditor(host, version, cfg.editorsDir)
      if (!editor) {
        throw new CiError(
          'E_UNITY_INSTALL',
          `Unity Hub finished but Unity ${version} is still not found${hubErrors(res)}`
        )
      }
    }
    const missing = missingModules(host, editor, modules)
    if (missing.length) {
      if (!cfg.install) {
        throw new CiError(
          'E_UNITY_MODULE',
          `Unity ${version} is missing module(s): ${missing.join(', ')}`
        )
      }
      core.info(`Installing missing module(s) ${missing.join(', ')} with Unity Hub`)
      const res = await runHub({
        host,
        hub: requireHub(),
        sub: installModulesArgs(version, missing),
        timeoutMs: cfg.installTimeout,
        signal: ctx.signal
      })
      const still = missingModules(host, editor, missing)
      if (still.length) {
        throw new CiError(
          'E_UNITY_MODULE',
          `Unity Hub could not install module(s) ${still.join(', ')}${hubErrors(res)}`
        )
      }
    }
    ctx.state.editor = editor
    core.setOutput('editor-path', editor)
    core.info(`Using ${editor}`)
  }

  const prepareImage = async (ctx: StepContext<State>): Promise<void> => {
    const tag = cfg.dockerImage || imageTag(cfg.dockerRepo, version, modules)
    const how = await ensureImage({
      tag,
      build: !cfg.dockerImage,
      version,
      changeset: resolveChangeset,
      modules,
      dockerfile: path.resolve(cfg.dockerfile || DEFAULT_DOCKERFILE),
      timeoutMs: cfg.installTimeout,
      signal: ctx.signal
    })
    ctx.state.image = tag
    core.setOutput('image', tag)
    core.info(`Docker image ${tag}: ${how}`)
  }

  const build = async (ctx: StepContext<State>): Promise<void> => {
    ctx.state.attempts = ctx.attempt
    let command: string
    let args: string[]
    let onKilled: ((reason: 'timeout' | 'hang' | 'cancel') => Promise<void>) | undefined
    if (inDocker) {
      // Unique per job and attempt: matrix jobs of one run can share a Docker daemon.
      const job = (ci.job ?? 'job').replace(/[^a-zA-Z0-9_.-]/g, '-')
      const name = `${ci.uniqueName('unity-build')}-${job}-${ctx.attempt}-${randomUUID().slice(0, 8)}`
      command = 'docker'
      args = dockerRunArgs({
        name,
        image: ctx.state.image ?? '',
        projectHost: projectDir,
        mounts,
        envNames: [...Object.keys(secretsEnv), ...cfg.dockerEnv],
        gradleVolume: cfg.gradleVolume === 'none' ? undefined : cfg.gradleVolume,
        unityArgs: unity.argv
      })
      // On cancel the runner force-kills us within ~10s: keep the stop grace short then.
      onKilled = async reason => stopContainer(name, reason === 'cancel' ? 5 : 30)
    } else {
      command = ctx.state.editor ?? ''
      args = unity.argv
    }
    try {
      const res = await runUnity({
        command,
        args,
        cwd: projectDir,
        env: childEnv(secretsEnv),
        timeoutMs: cfg.timeout,
        idleTimeoutMs: cfg.idleTimeout,
        logFile,
        attempt: ctx.attempt,
        signal: ctx.signal,
        licensePatterns,
        secrets,
        onKilled
      })
      Object.assign(ctx.state, {
        issues: res.issues,
        totalIssues: res.totalIssues,
        failureKind: undefined
      })
    } catch (err) {
      if (err instanceof UnityBuildError) {
        Object.assign(ctx.state, {
          issues: err.result.issues,
          totalIssues: err.result.totalIssues,
          failureKind: err.kind
        })
      }
      throw err
    }
  }

  const cleanGradle =
    cfg.cleanGradle === 'true' ||
    (cfg.cleanGradle === 'auto' && !inDocker && host.platform === 'darwin')

  const report = await new Pipeline<State>({ name: 'unity-build', state, ci })
    .step(
      'clean gradle cache',
      async () => rm(path.join(host.home, '.gradle', 'caches'), { recursive: true, force: true }),
      { if: () => cleanGradle, continueOnError: true }
    )
    .step(
      inDocker ? `docker image (Unity ${version})` : `locate Unity ${version}`,
      inDocker ? prepareImage : resolveEditor
    )
    .step(`build (Unity ${version})`, build, {
      retry: {
        attempts: cfg.licenseRetries + 1,
        minDelay: cfg.licenseRetryDelay,
        maxDelay: '10m',
        jitter: false, // as documented: the delay doubles, a busy license seat needs the wait
        retryIf: err => err instanceof UnityBuildError && err.kind === 'license'
      }
    })
    .run()

  const failedStep = report.steps.find(s => s.status === 'failure' || s.status === 'cancelled')
  state.error = failedStep?.error

  for (const issue of state.issues.filter(i => i.kind === 'compile' && i.file).slice(0, 10)) {
    annotate.error(issue.message, {
      file: path
        .relative(ci.workspace ?? process.cwd(), path.join(projectDir, issue.file ?? ''))
        .replace(/\\/g, '/'),
      line: issue.line,
      column: issue.column,
      title: 'Unity compile error'
    })
  }

  core.setOutput('status', report.status)
  core.setOutput('unity-version', version)
  core.setOutput('attempts', String(state.attempts))
  core.setOutput('failure-kind', state.failureKind ?? '')
  core.setOutput('log-file', logFile)
  core.setOutput('errors', JSON.stringify(state.issues.map(i => i.message)))

  if (cfg.summary && process.env.GITHUB_STEP_SUMMARY) {
    await core.summary
      .addRaw(
        summaryMarkdown({
          report,
          version,
          mode: cfg.mode,
          runtime: inDocker ? state.image : state.editor,
          attempts: state.attempts,
          failureKind: state.failureKind,
          issues: state.issues,
          totalIssues: state.totalIssues,
          logFile
        }),
        true
      )
      .write()
  }

  if (report.status !== 'success') {
    core.setFailed(state.error ?? `Unity build ${report.status}`)
  }
  return report
}
