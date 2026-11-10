import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { CiError, exec, retry, withoutCommands, type ExecResult } from '../../sdk/src/index.js'

/**
 * BIBG Debug View for QA builds: the client file goes into Assets/ and Firebase.Analytics.dll is
 * patched so every managed Firebase call is mirrored. Release safety rests on `cleanDebugView`,
 * which runs before every build (a persistent workspace may hold a killed QA run's leftovers).
 */

/** The client folder (relative to the Unity project); its `.meta` sits next to it. */
export const DEBUG_VIEW_DIR = 'Assets/BibgDebugView'
export const CLIENT_FILE = 'BibgDebugView.cs'
export const PATCH_TOOL_FILE = 'BibgFirebasePatch.cs'
export const DEFAULT_DEBUG_VIEW_URL = 'https://bi.blackgems.org'
export const DEFAULT_FIREBASE_DLL = 'Assets/Firebase/Plugins/Firebase.Analytics.dll'
export const URL_PLACEHOLDER = '__BIBG_DEBUGVIEW_URL__'
export const BUILD_PLACEHOLDER = '__BIBG_DEBUGVIEW_BUILD__'
/** The type the Firebase patch adds: never present in an original Firebase.Analytics.dll. */
export const PATCH_MARKER = 'BibgDebugViewHooks'
/** Temp file the patch tool writes next to the DLL before it moves it in place. */
export const PATCH_TMP_SUFFIX = '.bibg.tmp'

const DOWNLOAD_TIMEOUT_MS = 60_000
const PATCH_TIMEOUT_MS = 15 * 60_000
const MAX_LABEL = 100

export type Fetch = typeof fetch

export const clientUrl = (base: string): string => `${base}/api/v1/sdk/debugview/${CLIENT_FILE}`
export const patchToolUrl = (base: string): string =>
  `${base}/api/v1/sdk/debugview/${PATCH_TOOL_FILE}`

/**
 * The BIBG base URL: https only, no credentials, query or fragment, no trailing slash. It is
 * written into a C# string literal, so it must hold no quote, backslash or control character.
 */
export function parseBaseUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new Error(`not a URL: ${raw}`)
  }
  if (url.protocol !== 'https:') throw new Error(`must be an https URL: ${raw}`)
  if (url.username || url.password) throw new Error('must not contain credentials')
  if (url.search || url.hash) throw new Error('must not have a query or fragment')
  const base = url.href.replace(/\/+$/, '')
  if (/\/api\/v1$/i.test(base)) throw new Error('is the base URL, without /api/v1')
  if (!/^https:\/\/[A-Za-z0-9._~:/@!$&'()*+,;=%-]+$/.test(base)) {
    throw new Error(`has characters that cannot go into the client: ${raw}`)
  }
  return base
}

/**
 * Build label shown in the Debug View tab: `<ref>@<sha7> #<run>`, reduced to the characters the
 * BIBG sample keeps (it lands in a C# literal). Runs of `_` are collapsed and a leading `_` dropped,
 * so a branch name can never bring back a placeholder or start like one (`__BIBG_` = unset).
 */
export function buildLabel(parts: {
  refName?: string
  sha?: string
  runNumber?: number | string
}): string {
  const raw = `${parts.refName ?? ''}@${(parts.sha ?? '').slice(0, 7)} #${parts.runNumber ?? ''}`
  return raw
    .replace(/[^A-Za-z0-9._@#/ +-]/g, '')
    .replace(/_{2,}/g, '_')
    .replace(/^_+/, '')
    .slice(0, MAX_LABEL)
}

/** Replace both placeholders; fails when the file lacks one or one survives. */
export function fillPlaceholders(source: string, url: string, label: string): string {
  for (const p of [URL_PLACEHOLDER, BUILD_PLACEHOLDER]) {
    if (!source.includes(p)) {
      throw new CiError('E_DEBUG_VIEW_CLIENT', `${CLIENT_FILE} has no ${p} placeholder`)
    }
  }
  // Function replacers: `$'`, `$&` or `$$` in a value must stay literal text.
  const out = source
    .replaceAll(URL_PLACEHOLDER, () => url)
    .replaceAll(BUILD_PLACEHOLDER, () => label)
  if (out.includes(URL_PLACEHOLDER) || out.includes(BUILD_PLACEHOLDER)) {
    throw new CiError('E_DEBUG_VIEW_CLIENT', `${CLIENT_FILE} still holds a placeholder`)
  }
  return out
}

export type GateResult = { inject: true } | { inject: false; reason: 'off' | 'tag' }

/** Inject only when asked for, and never on a tag (a release), whatever the caller passed. */
export function debugViewGate(opts: {
  enabled: boolean
  refType: string | undefined
  ref: string | undefined
}): GateResult {
  if (!opts.enabled) return { inject: false, reason: 'off' }
  if (opts.refType === 'tag' || opts.ref?.startsWith('refs/tags/')) {
    return { inject: false, reason: 'tag' }
  }
  return { inject: true }
}

export interface DllPath {
  /** Relative to the project, `/` separated (what git gets). */
  rel: string
  abs: string
  /** Given by the input or FIREBASE_ANALYTICS_DLL (a missing file is then worth a warning). */
  explicit: boolean
}

/** File name the patch accepts, so every build's cleanup finds a patched copy by name. */
export const FIREBASE_DLL_NAME = 'Firebase.Analytics.dll'

/**
 * The Firebase.Analytics.dll to patch and restore: the input, else FIREBASE_ANALYTICS_DLL, else the
 * default, relative to the project. `none` = the game has no committed Firebase DLL (LogBridge
 * fallback). Must stay inside the project.
 */
export function resolveFirebaseDll(
  raw: string | undefined,
  envValue: string | undefined,
  projectDir: string
): DllPath | undefined {
  const given = raw?.trim() || envValue?.trim() || ''
  if (given.toLowerCase() === 'none') return undefined
  const value = given || DEFAULT_FIREBASE_DLL
  const abs = path.resolve(projectDir, value)
  const rel = path.relative(projectDir, abs)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`must be a file inside the project (${projectDir}): ${value}`)
  }
  return { rel: rel.split(path.sep).join('/'), abs, explicit: Boolean(given) }
}

export interface DebugViewIo {
  log: (message: string) => void
  warn: (message: string) => void
  signal?: AbortSignal
}

/** A path git must take as is (no glob or pathspec magic, whatever the input holds). */
const literal = (rel: string): string => `:(literal)${rel}`

/** git in the project; no git on the runner is an exit code null with a message, not a throw. */
async function git(projectDir: string, args: string[], signal?: AbortSignal): Promise<ExecResult> {
  try {
    return await exec('git', args, {
      cwd: projectDir,
      allowFailure: true,
      silent: true,
      timeout: 120_000,
      signal
    })
  } catch (err) {
    if (err instanceof CiError && err.code === 'E_EXEC_SPAWN') {
      return {
        command: `git ${args.join(' ')}`,
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: 'no git on the runner',
        durationMs: 0
      }
    }
    throw err
  }
}

type GitState = { kind: 'tracked' } | { kind: 'untracked' } | { kind: 'unknown'; reason: string }

async function gitState(projectDir: string, rel: string, signal?: AbortSignal): Promise<GitState> {
  const res = await git(projectDir, ['ls-files', '--error-unmatch', '--', literal(rel)], signal)
  if (res.exitCode === 0) return { kind: 'tracked' }
  // 1 = not in the index; anything else (not a repository, dubious ownership, no git) is unknown.
  if (res.exitCode === 1) return { kind: 'untracked' }
  return { kind: 'unknown', reason: res.stderr.trim() || `git exit code ${res.exitCode}` }
}

const gitStateText = (state: GitState): string =>
  state.kind === 'unknown'
    ? `git cannot tell if it is tracked (${state.reason})`
    : 'not tracked by git'

async function hasPatchMarker(file: string): Promise<boolean> {
  return (await readFile(file)).includes(PATCH_MARKER)
}

/** `git checkout HEAD -- <rel>`, then fail unless the file equals HEAD and holds no patch. */
async function restoreFromGit(
  projectDir: string,
  rel: string,
  signal?: AbortSignal
): Promise<void> {
  await rm(path.join(projectDir, `${rel}${PATCH_TMP_SUFFIX}`), { force: true })
  const co = await git(projectDir, ['checkout', 'HEAD', '--', literal(rel)], signal)
  if (co.exitCode !== 0) {
    throw new CiError(
      'E_DEBUG_VIEW_STALE',
      `git checkout HEAD -- ${rel} failed: ${co.stderr.trim() || `exit code ${co.exitCode}`}`
    )
  }
  const diff = await git(projectDir, ['diff', '--quiet', 'HEAD', '--', literal(rel)], signal)
  if (diff.exitCode !== 0) {
    throw new CiError(
      'E_DEBUG_VIEW_STALE',
      diff.exitCode === 1
        ? `${rel} still differs from git after the restore (patched Firebase.Analytics.dll)`
        : `git diff -- ${rel} failed: ${diff.stderr.trim() || `exit code ${diff.exitCode}`}`
    )
  }
}

const patchedError = (rel: string): CiError =>
  new CiError(
    'E_DEBUG_VIEW_STALE',
    `${rel} contains the BIBG Debug View patch (${PATCH_MARKER}): restore the original Firebase.Analytics.dll`
  )

/**
 * Before every build (release included): remove the client and restore Firebase.Analytics.dll from
 * git (HEAD), and fail when either cannot be made clean. Besides the configured DLL, every tracked
 * `Firebase.Analytics.dll` of the project that holds the patch is restored too, so a QA build that
 * patched another path (or a release with `none`) cannot leave it behind. A DLL git does not track
 * cannot be restored: it only has to be free of the patch. Also the post-build removal.
 */
export async function cleanDebugView(
  opts: { projectDir: string; dll: DllPath | undefined } & DebugViewIo
): Promise<void> {
  const { projectDir, dll, signal } = opts
  const dir = path.join(projectDir, DEBUG_VIEW_DIR)
  const meta = `${dir}.meta`
  await rm(dir, { recursive: true, force: true, maxRetries: 3 })
  await rm(meta, { force: true, maxRetries: 3 })
  for (const p of [dir, meta]) {
    if (existsSync(p)) throw new CiError('E_DEBUG_VIEW_STALE', `Stale BIBG Debug View client: ${p}`)
  }

  if (dll) {
    const state = await gitState(projectDir, dll.rel, signal)
    if (state.kind === 'tracked') {
      await restoreFromGit(projectDir, dll.rel, signal)
    } else {
      await rm(`${dll.abs}${PATCH_TMP_SUFFIX}`, { force: true })
      if (existsSync(dll.abs)) {
        opts.warn(
          `${dll.rel}: ${gitStateText(state)}, so it cannot be restored, only checked for the patch`
        )
      } else if (dll.explicit) {
        // No Firebase DLL here (a game without Firebase): nothing can be patched.
        opts.warn(`${dll.rel} does not exist: no Firebase.Analytics.dll to restore`)
      }
    }
  }

  // Every other tracked Firebase.Analytics.dll (the patch only accepts that name): restored when patched.
  const listed = await git(
    projectDir,
    ['ls-files', '-z', '--', `:(glob,icase)**/${FIREBASE_DLL_NAME}`],
    signal
  )
  if (listed.exitCode === 0) {
    for (const rel of listed.stdout.split('\0').filter(Boolean)) {
      if (rel === dll?.rel) continue
      const abs = path.join(projectDir, rel)
      if (!existsSync(abs) || !(await hasPatchMarker(abs))) continue
      await restoreFromGit(projectDir, rel, signal)
      if (await hasPatchMarker(abs)) throw patchedError(rel)
      opts.log(`${rel}: held the Debug View patch, restored from git`)
    }
  } else {
    // git cannot list them: nothing can be restored, but a patched copy must still stop the build.
    for (const rel of await findByName(path.join(projectDir, 'Assets'), FIREBASE_DLL_NAME)) {
      if (await hasPatchMarker(path.join(projectDir, 'Assets', rel))) {
        throw patchedError(`Assets/${rel.split(path.sep).join('/')}`)
      }
    }
  }

  // Last, so the sweep above can restore a configured path git lists with another case.
  // Also catches a patched DLL that was committed or staged by mistake.
  if (dll && existsSync(dll.abs)) {
    if (await hasPatchMarker(dll.abs)) throw patchedError(dll.rel)
    opts.log(`${dll.rel}: original Firebase.Analytics.dll`)
  }
}

/** Files named `name` (any case) under `dir`, relative to it; none when `dir` does not exist. */
async function findByName(dir: string, name: string): Promise<string[]> {
  if (!existsSync(dir)) return []
  const wanted = name.toLowerCase()
  return (await readdir(dir, { recursive: true })).filter(
    rel => path.basename(rel).toLowerCase() === wanted
  )
}

class DownloadError extends CiError {
  constructor(
    message: string,
    readonly retryable: boolean
  ) {
    super('E_DEBUG_VIEW_DOWNLOAD', message)
  }
}

/** GET a public BIBG file over https (fail closed: non-empty, holds every `mustContain`). */
export async function download(
  url: string,
  mustContain: readonly string[],
  opts: { fetchImpl?: Fetch; signal?: AbortSignal; minDelay?: number | string } & Pick<
    DebugViewIo,
    'warn'
  >
): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const name = url.split('/').pop() ?? url
  return retry(
    async () => {
      let res: Response
      try {
        const timeout = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
        res = await fetchImpl(url, {
          signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout
        })
      } catch (err) {
        if (opts.signal?.aborted) throw err
        throw new DownloadError(
          `${name} download failed: ${err instanceof Error ? err.message : String(err)} (${url})`,
          true
        )
      }
      // A redirect must not downgrade to cleartext.
      if (res.url && !res.url.startsWith('https://')) {
        throw new DownloadError(`${name} download was redirected off https: ${res.url}`, false)
      }
      if (!res.ok) {
        // Not awaited: a cancel can wait on a tee'd branch; the body only has to be released.
        void res.body?.cancel().catch(() => undefined)
        const retryable = res.status >= 500 || res.status === 408 || res.status === 429
        throw new DownloadError(`${name} download failed: HTTP ${res.status} (${url})`, retryable)
      }
      let text: string
      try {
        text = await res.text()
      } catch (err) {
        if (opts.signal?.aborted) throw err
        throw new DownloadError(
          `${name} download failed while reading: ${err instanceof Error ? err.message : String(err)} (${url})`,
          true
        )
      }
      if (text.trim() === '') throw new DownloadError(`${name} download is empty (${url})`, true)
      const missing = mustContain.filter(s => !text.includes(s))
      if (missing.length) {
        throw new DownloadError(
          `${name} download does not look like ${name} (no ${missing.join(', ')}) (${url})`,
          false
        )
      }
      return text
    },
    {
      attempts: 3,
      minDelay: opts.minDelay ?? '2s',
      signal: opts.signal,
      retryIf: err => err instanceof DownloadError && err.retryable,
      onRetry: (err, attempt) =>
        opts.warn(`${err instanceof Error ? err.message : String(err)}; retry ${attempt}`)
    }
  )
}

/** Download the client into Assets/BibgDebugView and fill in the URL and build label. */
export async function injectClient(
  opts: {
    projectDir: string
    baseUrl: string
    label: string
    fetchImpl?: Fetch
    retryDelay?: number | string
  } & DebugViewIo
): Promise<string> {
  const source = await download(clientUrl(opts.baseUrl), [URL_PLACEHOLDER, BUILD_PLACEHOLDER], {
    fetchImpl: opts.fetchImpl,
    signal: opts.signal,
    minDelay: opts.retryDelay,
    warn: opts.warn
  })
  const code = fillPlaceholders(source, opts.baseUrl, opts.label)
  const dir = path.join(opts.projectDir, DEBUG_VIEW_DIR)
  const file = path.join(dir, CLIENT_FILE)
  await mkdir(dir, { recursive: true })
  await writeFile(file, code)
  opts.log(`BIBG Debug View client injected: ${file} (url ${opts.baseUrl}, build "${opts.label}")`)
  return file
}

/** `dotnet` from DOTNET_ROOT (setup-dotnet sets it), else from PATH. */
export function dotnetCommand(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.DOTNET_ROOT
  if (root) {
    const bin = path.join(root, process.platform === 'win32' ? 'dotnet.exe' : 'dotnet')
    if (existsSync(bin)) return bin
  }
  return 'dotnet'
}

const NO_DOTNET =
  'The Firebase patch needs the .NET 10 SDK: add actions/setup-dotnet (dotnet-version 10.0.x) before ' +
  'this step or preinstall it on the runner, or set firebase-analytics-dll: none (LogBridge fallback)'

const PATCH_EXIT: Record<number, string> = {
  1: 'the DLL does not look as the tool expects, was patched by another tool version (restore the original), or could not be read/written',
  2: 'usage error'
}

/**
 * Patch Firebase.Analytics.dll with BibgFirebasePatch.cs (a .NET 10 file-based app) before Unity
 * starts. The tool lives in `toolDir`, outside Assets/ so Unity never imports it. The DLL must be
 * tracked by git: the next cleanup restores it from there.
 */
export async function patchFirebaseDll(
  opts: {
    projectDir: string
    dll: DllPath
    baseUrl: string
    toolDir: string
    dotnet?: string
    env?: Record<string, string | undefined>
    fetchImpl?: Fetch
    retryDelay?: number | string
  } & DebugViewIo
): Promise<void> {
  const { dll, signal } = opts
  if (path.basename(dll.abs).toLowerCase() !== FIREBASE_DLL_NAME.toLowerCase()) {
    // The cleanup of every build finds a patched DLL by this name, whatever its inputs say.
    throw new CiError(
      'E_DEBUG_VIEW_PATCH',
      `firebase-analytics-dll must be a ${FIREBASE_DLL_NAME}: ${dll.rel}`
    )
  }
  const assets = path.join(opts.projectDir, 'Assets')
  const toolRel = path.relative(assets, opts.toolDir)
  if (!toolRel.startsWith('..') && !path.isAbsolute(toolRel)) {
    throw new CiError(
      'E_DEBUG_VIEW_PATCH',
      `The patch tool must not go under Assets/: ${opts.toolDir}`
    )
  }
  if (!existsSync(dll.abs)) {
    throw new CiError(
      'E_DEBUG_VIEW_PATCH',
      `Missing ${dll.rel}: set firebase-analytics-dll to the committed Firebase.Analytics.dll, or none to use the LogBridge fallback`
    )
  }
  const state = await gitState(opts.projectDir, dll.rel, signal)
  if (state.kind !== 'tracked') {
    throw new CiError(
      'E_DEBUG_VIEW_PATCH',
      `${dll.rel}: ${gitStateText(state)}, so the patched DLL could not be restored after the build. Commit it, or set firebase-analytics-dll: none`
    )
  }

  const dotnet = opts.dotnet ?? dotnetCommand()
  let sdks: string
  try {
    const res = await exec(dotnet, ['--list-sdks'], {
      allowFailure: true,
      silent: true,
      timeout: 60_000,
      signal
    })
    sdks = res.exitCode === 0 ? res.stdout : ''
  } catch (err) {
    if (err instanceof CiError && err.code === 'E_EXEC_SPAWN') {
      throw new CiError('E_DEBUG_VIEW_DOTNET', `${NO_DOTNET} (${err.message})`)
    }
    throw err
  }
  if (!/^10\./m.test(sdks)) {
    throw new CiError(
      'E_DEBUG_VIEW_DOTNET',
      `${NO_DOTNET}. Installed SDKs: ${sdks.trim().replace(/\s*\r?\n\s*/g, ', ') || 'none'}`
    )
  }

  const source = await download(patchToolUrl(opts.baseUrl), [PATCH_MARKER], {
    fetchImpl: opts.fetchImpl,
    signal,
    minDelay: opts.retryDelay,
    warn: opts.warn
  })
  await mkdir(opts.toolDir, { recursive: true })
  const tool = path.join(opts.toolDir, PATCH_TOOL_FILE)
  await writeFile(tool, source)

  opts.log(`dotnet run --file ${tool} -- ${dll.abs}`)
  // The tool's output is downloaded code's output: shown, never run as workflow commands.
  const res = await withoutCommands(async () =>
    exec(dotnet, ['run', '--file', tool, '--', dll.abs], {
      cwd: opts.toolDir,
      env: {
        ...opts.env,
        DOTNET_CLI_TELEMETRY_OPTOUT: '1',
        DOTNET_NOLOGO: '1',
        DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1'
      },
      inheritEnv: opts.env === undefined,
      allowFailure: true,
      timeout: PATCH_TIMEOUT_MS,
      signal
    })
  )
  if (res.exitCode !== 0) {
    const why = (res.exitCode !== null && PATCH_EXIT[res.exitCode]) || 'see the log above'
    throw new CiError(
      'E_DEBUG_VIEW_PATCH',
      `Firebase patch failed (exit code ${res.exitCode ?? res.signal}): ${why}`
    )
  }
  if (!(await hasPatchMarker(dll.abs))) {
    throw new CiError(
      'E_DEBUG_VIEW_PATCH',
      `Firebase patch exited 0 but ${dll.rel} has no ${PATCH_MARKER}`
    )
  }
  opts.log(`${dll.rel} patched: Firebase Analytics calls are mirrored to the Debug View`)
}
