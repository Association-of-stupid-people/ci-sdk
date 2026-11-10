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
  exec,
  getCiContext,
  input,
  readInputs,
  type PipelineReport,
  type StepContext
} from '../../sdk/src/index.js'
import { DEFAULT_ARGS, buildUnityArgs, modulesForTarget } from './args.js'
import {
  DEFAULT_DEBUG_VIEW_URL,
  buildLabel,
  cleanDebugView,
  debugViewGate,
  injectClient,
  parseBaseUrl,
  patchFirebaseDll,
  resolveFirebaseDll,
  type Fetch
} from './debug-view.js'
import {
  CI_ENV_NAMES,
  CONTAINER_PROJECT,
  CONTAINER_ULF,
  DEFAULT_DOCKERFILE,
  STOP_GRACE_SECONDS,
  containerPath,
  dockerRunArgs,
  dockerWarnings,
  ensureImage,
  imagePlan,
  imageTag,
  signalContainer,
  stopContainer,
  type Mount
} from './docker.js'
import { hubErrors, installArgs, installModulesArgs, runHub } from './hub.js'
import {
  LicenseError,
  machineLicenseFile,
  runLicense,
  ulfHasSerial,
  type LicenseAccount
} from './license.js'
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

/** Time limit for returning the seat in host mode (the container caps it at about 3 min too). */
const RETURN_TIMEOUT_MS = 3 * 60_000

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
  mode: input.oneOf(['docker', 'host'] as const, { default: 'docker' }),
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
  imageSource: input.oneOf(['auto', 'gameci', 'build'] as const, {
    name: 'docker-image-source',
    default: 'auto'
  }),
  gameciVersion: input.string({
    name: 'gameci-version',
    default: '3',
    pattern: /^\d+(\.\d+){0,2}$/
  }),
  dockerPlatform: input.string({ name: 'docker-platform', default: 'linux/amd64' }),
  dockerRepo: input.string({ name: 'docker-image-repo', default: 'ci-unity-editor' }),
  dockerfile: input.string({ name: 'dockerfile' }),
  dockerEnv: input.list({ name: 'docker-env', default: [] }),
  gradleVolume: input.string({ name: 'docker-gradle-volume', default: 'ci-unity-gradle' }),
  licenseFile: input.string({ name: 'unity-license-file' }),
  serial: input.string({ name: 'unity-serial', secret: true }),
  email: input.string({ name: 'unity-email', secret: true }),
  password: input.string({ name: 'unity-password', secret: true }),
  returnLicense: input.oneOf(['auto', 'true', 'false'] as const, {
    name: 'return-license',
    default: 'auto'
  }),
  cleanGradle: input.oneOf(['auto', 'true', 'false'] as const, {
    name: 'clean-gradle-cache',
    default: 'auto'
  }),
  summary: input.boolean({ default: true }),
  debugView: input.boolean({ name: 'debug-view', default: false }),
  debugViewUrl: input.string({ name: 'debug-view-url', default: DEFAULT_DEBUG_VIEW_URL }),
  firebaseDll: input.string({ name: 'firebase-analytics-dll' })
}

interface State {
  editor?: string
  image?: string
  attempts: number
  failureKind?: FailureKind
  /** Host mode: the last activation failed (a return then has nothing to give back). */
  activationFailed?: boolean
  issues: UnityIssue[]
  totalIssues: number
  error?: string
  /** Build label when the BIBG Debug View client was injected (and the DLL patched, unless none). */
  debugView?: string
}

export interface RunOptions {
  host?: HostEnv
  /** Debug View downloads (tests). */
  fetch?: Fetch
  /** dotnet binary for the Firebase patch (tests); default DOTNET_ROOT, then PATH. */
  dotnet?: string
  /** First retry delay of the Debug View downloads (tests). */
  downloadRetryDelay?: number | string
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

  // BIBG Debug View: the cleanup runs in every build; inject/patch only when asked, never on a tag.
  const firebaseDll = (() => {
    try {
      return resolveFirebaseDll(cfg.firebaseDll, process.env.FIREBASE_ANALYTICS_DLL, projectDir)
    } catch (err) {
      throw new InputError([{ input: 'firebase-analytics-dll', message: (err as Error).message }])
    }
  })()
  const gate = debugViewGate({ enabled: cfg.debugView, refType: ci.refType, ref: ci.ref })
  if (!gate.inject && gate.reason === 'tag') {
    core.warning('debug-view is ignored on a tag build: a release never gets the BIBG Debug View')
  }
  // Only validated when used, like obfuscate-assemblies.
  const debugViewUrl = gate.inject
    ? (() => {
        try {
          return parseBaseUrl(cfg.debugViewUrl)
        } catch (err) {
          throw new InputError([{ input: 'debug-view-url', message: (err as Error).message }])
        }
      })()
    : ''

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
  if (inDocker) {
    const hostOnlyInputs = [
      cfg.editorPath && 'editor-path',
      cfg.editorsDir.length > 0 && 'editors-dir',
      cfg.hubPath && 'hub-path'
    ].filter((n): n is string => Boolean(n))
    for (const w of dockerWarnings({
      argv: unity.argv,
      buildTarget: unity.buildTarget,
      // docker-image overrides the image modules would pick.
      autoModules: cfg.modules.includes('auto') && !cfg.dockerImage,
      hostOnlyInputs
    }))
      core.warning(w)
  }
  // A -logFile written with $(pwd) points into the container in docker mode; resolve it on the host.
  const hostLogArg = inDocker ? buildUnityArgs({ ...argsInput, projectDir }).logFile : unity.logFile
  const logFile = path.resolve(
    projectDir,
    hostLogArg ?? path.join(ci.runner.temp ?? os.tmpdir(), `${ci.uniqueName('unity-build')}.log`)
  )

  const gradleVolume = cfg.gradleVolume === 'none' ? undefined : cfg.gradleVolume
  // An empty input means the default (linux/amd64): `none` leaves the platform to the daemon.
  const platform = cfg.dockerPlatform === 'none' ? undefined : cfg.dockerPlatform
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
  // Unity activates and returns a serial with the account: without it every attempt fails.
  if (cfg.serial && (!cfg.email || !cfg.password)) {
    throw new InputError(
      [
        !cfg.email && { input: 'unity-email', message: 'is required with unity-serial' },
        !cfg.password && { input: 'unity-password', message: 'is required with unity-serial' }
      ].filter((i): i is { input: string; message: string } => Boolean(i))
    )
  }
  // Host mode with a serial: activate on the runner before the build.
  const account: LicenseAccount | undefined =
    !inDocker && cfg.serial && cfg.email && cfg.password
      ? { serial: cfg.serial, email: cfg.email, password: cfg.password }
      : undefined
  // auto keeps the seat on a persistent host: other runners on it may be building with it.
  const returnHostLicense = account !== undefined && cfg.returnLicense === 'true'
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
    if (cfg.returnLicense === 'false') {
      core.warning(
        'return-license applies to mode: host only; in mode: docker the container always returns its seat'
      )
    }
  } else {
    // A .ulf is bound to the machine it was made for; copying it over the machine-wide one could
    // also replace a license other runners on this machine use.
    if (cfg.licenseFile) {
      core.warning(
        'unity-license-file is used in mode: docker only; in mode: host set unity-serial, unity-email ' +
          'and unity-password, or activate the runner machine once by hand'
      )
    }
    if (cfg.returnLicense === 'true' && !account) {
      core.warning('return-license: true needs unity-serial in mode: host; nothing is returned')
    }
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
  const licenseTemp = ci.runner.temp ?? os.tmpdir()

  /**
   * Host mode: activate the serial with the editor. `skipIfActive` trusts a
   * machine-wide license that already holds this serial, only when a license
   * error can still re-activate (license-retries > 0).
   */
  const activate = async (ctx: StepContext<State>, skipIfActive: boolean): Promise<void> => {
    if (!account) return
    if (skipIfActive && cfg.licenseRetries > 0) {
      const ulf = machineLicenseFile(host)
      if (ulfHasSerial(host.read(ulf), account.serial)) {
        core.info(`${ulf} already holds this serial: activation skipped`)
        Object.assign(ctx.state, { activationFailed: false, failureKind: undefined })
        return
      }
    }
    core.info(
      'Activating the Unity license (the editor gets the serial and account on its command line)'
    )
    try {
      await runLicense({
        action: 'activate',
        editor: ctx.state.editor ?? '',
        account,
        tempDir: licenseTemp,
        env: childEnv({}),
        secrets,
        signal: ctx.signal
      })
    } catch (err) {
      ctx.state.activationFailed = true
      if (err instanceof LicenseError) ctx.state.failureKind = 'license'
      throw err
    }
    // A failed earlier attempt must not label a later, non-license failure.
    Object.assign(ctx.state, { activationFailed: false, failureKind: undefined })
    core.info('Unity license activated')
  }

  const returnLicense = async (ctx: StepContext<State>): Promise<void> => {
    if (!account || !ctx.state.editor) return
    try {
      await runLicense({
        action: 'return',
        editor: ctx.state.editor,
        account,
        tempDir: licenseTemp,
        env: childEnv({}),
        secrets,
        timeoutMs: RETURN_TIMEOUT_MS,
        signal: ctx.signal
      })
      core.info('Unity license returned')
    } catch (err) {
      // Usually nothing to return after a failed activation (still tried, as in docker mode).
      if (err instanceof LicenseError && ctx.state.activationFailed) {
        core.info(err.message)
        return
      }
      throw err
    }
  }
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
    const plan = imagePlan({
      dockerImage: cfg.dockerImage,
      source: cfg.imageSource,
      version,
      modules,
      gameciVersion: cfg.gameciVersion,
      build: {
        tag: imageTag(cfg.dockerRepo, version, modules),
        version,
        changeset: resolveChangeset,
        modules,
        dockerfile: path.resolve(cfg.dockerfile || DEFAULT_DOCKERFILE)
      }
    })
    try {
      const image = await ensureImage({
        ...plan,
        platform,
        timeoutMs: cfg.installTimeout,
        signal: ctx.signal,
        onWarning: m => core.warning(m)
      })
      ctx.state.image = image.tag
      core.setOutput('image', image.tag)
      core.info(`Docker image ${image.tag}: ${image.how}`)
      // v2 built every docker-mode image from `dockerfile`; auto now prefers GameCI.
      if (cfg.dockerfile && image.tag !== plan.build?.tag) {
        core.warning(
          cfg.dockerImage
            ? `dockerfile is not used: docker-image (${cfg.dockerImage}) is set and overrides ` +
                `docker-image-source; remove docker-image${cfg.imageSource === 'build' ? '' : ' and set docker-image-source: build'} ` +
                'to build from the Dockerfile.'
            : `dockerfile is not used: the image is ${image.tag}. It is used by docker-image-source: ` +
                'build, and by auto only when GameCI has no image; set docker-image-source: build to ' +
                'always build from it.'
        )
      }
    } catch (err) {
      if (err instanceof CiError && err.code === 'E_EXEC_SPAWN') {
        throw new CiError(
          'E_DOCKER_MISSING',
          `mode: docker (the default since v3) needs Docker on the runner: ${err.message}. ` +
            'Install Docker, or set mode: host to build with an editor installed on the runner.',
          { cause: err }
        )
      }
      throw err
    }
  }

  const build = async (ctx: StepContext<State>): Promise<void> => {
    ctx.state.attempts = ctx.attempt
    // Only license errors are retried: activate again (the seat may have been revoked, or
    // returned by another runner on this machine).
    if (account && ctx.attempt > 1) await activate(ctx, false)
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
        platform,
        mounts,
        envNames: [
          ...new Set([
            ...Object.keys(secretsEnv),
            ...CI_ENV_NAMES.filter(n => process.env[n] !== undefined),
            ...cfg.dockerEnv
          ])
        ],
        gradleVolume,
        unityArgs: unity.argv
      })
      // The docker CLI forwarded SIGTERM already. Timeout/hang: it stays attached while the
      // container returns the seat (stopGraceMs); stop what outlived it. Cancel: the runner kills
      // us within ~10 s, so the container finishes on its own.
      onKilled = async reason => (reason === 'cancel' ? signalContainer(name) : stopContainer(name))
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
        onKilled,
        stopGraceMs: inDocker ? (STOP_GRACE_SECONDS + 15) * 1000 : undefined
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
  // Docker builds keep Gradle in a named volume, not in the runner's ~/.gradle.
  const cleanGradleCache = async (ctx: StepContext<State>): Promise<void> => {
    if (!inDocker) {
      await rm(path.join(host.home, '.gradle', 'caches'), { recursive: true, force: true })
    } else if (gradleVolume) {
      const res = await exec('docker', ['volume', 'rm', '--force', gradleVolume], {
        allowFailure: true,
        signal: ctx.signal,
        timeout: 120_000
      })
      // e.g. "volume is in use" while another job on this daemon builds with it.
      if (res.exitCode !== 0) {
        core.warning(
          `Gradle cache not cleaned: docker volume rm ${gradleVolume} failed: ` +
            (res.stderr.trim() || `exit code ${res.exitCode}`)
        )
      }
    }
  }

  const licenseRetry = {
    attempts: cfg.licenseRetries + 1,
    minDelay: cfg.licenseRetryDelay,
    maxDelay: '10m',
    jitter: false // as documented: the delay doubles, a busy license seat needs the wait
  }
  const debugViewIo = {
    log: (m: string) => core.info(m),
    warn: (m: string) => core.warning(m)
  }
  const pipeline = new Pipeline<State>({ name: 'unity-build', state, ci })
    // First, in every build: a QA run killed before its removal must not leak into this build.
    .step('remove stale Debug View', async ctx =>
      cleanDebugView({ projectDir, dll: firebaseDll, ...debugViewIo, signal: ctx.signal })
    )
  if (gate.inject) {
    const label = buildLabel({ refName: ci.refName, sha: ci.sha, runNumber: ci.runNumber })
    pipeline.step('inject Debug View', async ctx => {
      await injectClient({
        projectDir,
        baseUrl: debugViewUrl,
        label,
        fetchImpl: options.fetch,
        retryDelay: options.downloadRetryDelay,
        ...debugViewIo,
        signal: ctx.signal
      })
      // Before Unity starts: Unity must not have the DLL loaded.
      if (firebaseDll) {
        await patchFirebaseDll({
          projectDir,
          dll: firebaseDll,
          baseUrl: debugViewUrl,
          toolDir: path.join(ci.runner.temp ?? os.tmpdir(), 'bibg-fbpatch'),
          dotnet: options.dotnet,
          env: childEnv({}),
          fetchImpl: options.fetch,
          retryDelay: options.downloadRetryDelay,
          ...debugViewIo,
          signal: ctx.signal
        })
      } else {
        core.info('firebase-analytics-dll: none: no Firebase patch (LogBridge fallback)')
      }
      ctx.state.debugView = label
    })
  }
  pipeline
    .step('clean gradle cache', cleanGradleCache, { if: () => cleanGradle, continueOnError: true })
    .step(
      inDocker ? `docker image (Unity ${version})` : `locate Unity ${version}`,
      inDocker ? prepareImage : resolveEditor
    )
  // Added only when used, so the other setups keep their step list.
  if (account) {
    pipeline.step('activate Unity license', async ctx => activate(ctx, true), {
      retry: { ...licenseRetry, retryIf: err => err instanceof LicenseError }
    })
  }
  pipeline.step(`build (Unity ${version})`, build, {
    retry: {
      ...licenseRetry,
      // LicenseError: the re-activation before a retry failed (host mode only).
      retryIf: err =>
        (err instanceof UnityBuildError && err.kind === 'license') || err instanceof LicenseError
    }
  })
  if (returnHostLicense) {
    pipeline.always('return Unity license', returnLicense, { continueOnError: true })
  }
  // Tidiness only (the stale cleanup of the next build is the guarantee); also after a failure.
  if (gate.inject) {
    pipeline.always(
      'remove Debug View',
      async ctx =>
        cleanDebugView({ projectDir, dll: firebaseDll, ...debugViewIo, signal: ctx.signal }),
      { continueOnError: true }
    )
  }
  const report = await pipeline.run()

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
  core.setOutput('debug-view', String(state.debugView !== undefined))

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
          logFile,
          debugView: state.debugView
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
