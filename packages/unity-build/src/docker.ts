import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AbortError, CiError, ExecError, InputError, exec } from '../../sdk/src/index.js'

/** Where the project is mounted inside the container. */
export const CONTAINER_PROJECT = '/project'
/** Where Unity looks for a manual-activation license as root on Linux. */
export const CONTAINER_ULF = '/root/.local/share/unity3d/Unity/Unity_lic.ulf'

/**
 * How long a stopping container gets before SIGKILL: the trap takes up to
 * 30 s to stop Unity and up to about 3 min to return the seat, then restores
 * ownership. After a timeout or a hung editor the docker CLI stays attached
 * this long (+15 s), so the cleanup's output reaches the log; `docker stop`
 * uses it for a container that outlives the CLI, `--stop-timeout` when the
 * Docker daemon shuts down. Stopping ends as soon as the container exits.
 */
export const STOP_GRACE_SECONDS = 300

/**
 * Bundled Dockerfile. Resolves both from the sources
 * (packages/unity-build/src -> ../assets) and from the published bundle
 * (<action>/dist/index.js -> ../assets): scripts/build.mjs copies assets/.
 */
export const DEFAULT_DOCKERFILE = fileURLToPath(new URL('../assets/Dockerfile', import.meta.url))

/**
 * Runs inside the container as `sh -c SCRIPT ci-unity <unity args...>`.
 * Secrets arrive as environment variables (`docker run -e NAME`, value taken
 * from the docker CLI's env), never on the docker command line. A serial is
 * activated before and returned after the build.
 *
 * - Activation and return open an empty project (/tmp/ci-blank): with the
 *   working directory at /project, Unity would import the real project there
 *   with its output hidden.
 * - Personal serials (F...) are tied to the machine id, which every container
 *   of a GameCI image shares, so they get a fresh one (as GameCI does).
 * - git may read the mounted checkout, which root does not own.
 * - Files go back to the owner of the /project mount: the runner user on
 *   rootful Docker, a no-op on rootless Docker (where chowning to the host
 *   uid would lock the runner out of its workspace).
 *
 * Activation/return log to their own files (Unity echoes its command line,
 * serial included, at the top of a log). A failed return prints `ci-unity: `
 * lines (the reason, then the end of its log), which the action turns into a
 * warning; not after a failed activation, which usually left no seat to
 * return (the return is still tried in case it did). The blank line before
 * them ends an unterminated last line of Unity's output.
 *
 * Stopping (SIGTERM forwarded by the docker CLI, then `docker stop`/`kill`):
 * - Every editor runs in its own session (setsid), so the init process's
 *   group-wide SIGTERM (TINI_KILL_PROCESS_GROUP) reaches only sh. The trap
 *   signals the editor's group and waits until all of it is gone (GameCI's
 *   unity-editor wrapper does not exec Unity, so waiting for the wrapper is
 *   not enough), SIGKILLs what is left after 30 s (CI_UNITY_STOP_WAIT, for
 *   tests), then cleans up.
 * - Cleanup ignores further signals and returns the seat in a session of its
 *   own, capped at about 3 min, so a second SIGTERM cannot cut it short; the
 *   chown runs last.
 * - Without setsid (not in GameCI or the bundled image) the editor shares
 *   sh's group and the init process signals it directly.
 */
export const CONTAINER_SCRIPT = [
  'code=0',
  'pid=',
  'cleaned=',
  'unactivated=',
  'blank=/tmp/ci-blank',
  'detach=',
  'limit=',
  'setsid -w true 2>/dev/null && detach=setsid',
  'timeout -k 1 5 true 2>/dev/null && limit="timeout -k 10 180"',
  "git config --global --add safe.directory '*' 2>/dev/null || true",
  'stop_editor() {',
  '  [ -n "$pid" ] || return 0',
  '  kill -TERM -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null',
  '  n=0',
  '  while [ "$n" -lt "${CI_UNITY_STOP_WAIT:-30}" ] && { kill -0 -"$pid" || kill -0 "$pid"; } 2>/dev/null; do sleep 1; n=$((n + 1)); done',
  '  kill -KILL -"$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true',
  '  wait "$pid" 2>/dev/null',
  '}',
  'cleanup() {',
  '  [ -n "$cleaned" ] && return 0',
  '  cleaned=1',
  "  trap '' TERM INT",
  '  if [ -n "${UNITY_SERIAL:-}" ]; then',
  '    $detach ${detach:+-w} $limit unity-editor -batchmode -nographics -quit -logFile /tmp/ci-return.log -projectPath "$blank" -returnlicense -username "${UNITY_EMAIL:-}" -password "${UNITY_PASSWORD:-}" >/dev/null 2>&1 || {',
  '      rc=$?',
  '      if [ -z "$unactivated" ]; then',
  '        echo',
  '        echo "ci-unity: could not return the license seat (exit $rc)"',
  '        grep -iE "licen|error" /tmp/ci-return.log 2>/dev/null | grep -v -e "-serial" -e "-password" -e "^-" | tail -n 10 | sed "s/^/ci-unity:   /"',
  '      fi',
  '    }',
  '  fi',
  '  owner=$(stat -c %u:%g /project 2>/dev/null) && chown -R "$owner" /project 2>/dev/null || true',
  '}',
  'trap \'trap "" TERM INT; [ -n "$cleaned" ] || { stop_editor; cleanup; exit 143; }\' TERM INT',
  'mkdir -p "$blank/Assets"',
  'if [ -n "${UNITY_SERIAL:-}" ]; then',
  '  case "$UNITY_SERIAL" in F*) tr -d - </proc/sys/kernel/random/uuid >/etc/machine-id && mkdir -p /var/lib/dbus && ln -sf /etc/machine-id /var/lib/dbus/machine-id ;; esac',
  '  $detach ${detach:+-w} unity-editor -batchmode -nographics -quit -logFile /tmp/ci-activate.log -projectPath "$blank" -serial "$UNITY_SERIAL" -username "${UNITY_EMAIL:-}" -password "${UNITY_PASSWORD:-}" >/dev/null 2>&1 &',
  '  pid=$!',
  '  wait "$pid" || code=$?',
  '  if [ "$code" -ne 0 ]; then',
  '    unactivated=1',
  '    echo "Failed to activate the Unity license (exit $code)"',
  '    grep -iE "licen|error" /tmp/ci-activate.log | grep -v -e "-serial" -e "-password" | tail -n 20',
  '  fi',
  'fi',
  'if [ "$code" -eq 0 ]; then',
  '  $detach ${detach:+-w} unity-editor "$@" &',
  '  pid=$!',
  '  wait "$pid"',
  '  code=$?',
  'fi',
  'cleanup',
  'exit "$code"'
].join('\n')

/**
 * GitHub context a BuildScript may read inside the container (build number,
 * commit, branch). None is a secret; paths (GITHUB_WORKSPACE, RUNNER_TEMP)
 * are left out on purpose: they do not exist in the container.
 */
export const CI_ENV_NAMES = [
  'CI',
  'GITHUB_ACTIONS',
  'GITHUB_RUN_ID',
  'GITHUB_RUN_NUMBER',
  'GITHUB_RUN_ATTEMPT',
  'GITHUB_SHA',
  'GITHUB_REF',
  'GITHUB_REF_NAME',
  'GITHUB_REF_TYPE',
  'GITHUB_HEAD_REF',
  'GITHUB_BASE_REF',
  'GITHUB_REPOSITORY',
  'GITHUB_REPOSITORY_OWNER',
  'GITHUB_EVENT_NAME',
  'GITHUB_WORKFLOW',
  'GITHUB_JOB',
  'GITHUB_ACTOR',
  'GITHUB_SERVER_URL'
] as const

/** Local image tag for one Unity version + module set, e.g. `ci-unity-editor:2022.3.20f1-android`. */
export function imageTag(repo: string, version: string, modules: readonly string[]): string {
  const suffix = [...modules].sort().join('-') || 'base'
  return `${repo}:${version}-${suffix}`
}

export interface Mount {
  host: string
  container: string
  readonly?: boolean
}

export function dockerRunArgs(o: {
  name: string
  image: string
  projectHost: string
  /** `--platform` for the container (unset = the daemon's default). */
  platform?: string
  mounts?: readonly Mount[]
  envNames?: readonly string[]
  gradleVolume?: string
  unityArgs: readonly string[]
}): string[] {
  const args = ['run', '--rm', '--init', '--name', o.name, '-w', CONTAINER_PROJECT]
  // Also how long the daemon waits for it when it shuts down (e.g. an ARC pod deleted after a cancel).
  args.push('--stop-timeout', String(STOP_GRACE_SECONDS))
  if (o.platform) args.push('--platform', o.platform)
  // The init process signals sh's whole group; the trap stops the editors (see CONTAINER_SCRIPT).
  args.push('-e', 'TINI_KILL_PROCESS_GROUP=1')
  args.push('-v', `${o.projectHost}:${CONTAINER_PROJECT}`)
  for (const m of o.mounts ?? [])
    args.push('-v', `${m.host}:${m.container}${m.readonly ? ':ro' : ''}`)
  if (o.gradleVolume) args.push('-v', `${o.gradleVolume}:/root/.gradle`)
  for (const name of o.envNames ?? []) args.push('-e', name)
  args.push(o.image, 'sh', '-c', CONTAINER_SCRIPT, 'ci-unity', ...o.unityArgs)
  return args
}

/** Container path for a host file: inside the project it maps under /project, else it gets a mount. */
export function containerPath(
  hostFile: string,
  projectHost: string,
  mountDir: string
): { path: string; mount?: Mount } {
  const rel = path.relative(projectHost, hostFile)
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    return { path: path.posix.join(CONTAINER_PROJECT, ...rel.split(path.sep)) }
  }
  const target = path.posix.join(mountDir, path.basename(hostFile))
  return { path: target, mount: { host: hostFile, container: target, readonly: true } }
}

/**
 * Unity arguments (already expanded for the container) that are absolute
 * paths outside /project: host paths from `$VAR`/`${{ }}` or a `..` that
 * leaves the project. The container cannot read them and loses what it
 * writes there.
 */
export function pathsOutsideProject(argv: readonly string[]): string[] {
  return argv.filter(a => {
    if (/^[A-Za-z]:[\\/]/.test(a) || a.startsWith('\\\\')) return true
    if (!a.startsWith('/')) return false
    const p = path.posix.normalize(a)
    // /dev/stdout, /dev/null: not files the build needs back.
    if (p.startsWith('/dev/')) return false
    return p !== CONTAINER_PROJECT && !p.startsWith(`${CONTAINER_PROJECT}/`)
  })
}

/** Warnings for docker mode, from settings that worked with an editor on the runner. */
export function dockerWarnings(o: {
  argv: readonly string[]
  buildTarget: string | undefined
  /** `modules: auto` (modules come from -buildTarget). */
  autoModules: boolean
  /** Names of the host-mode-only inputs that are set. */
  hostOnlyInputs: readonly string[]
}): string[] {
  const out: string[] = []
  if (o.autoModules && !o.buildTarget) {
    out.push(
      'No -buildTarget in the Unity arguments: the container gets the base editor (Linux standalone ' +
        'only, no Android/iOS/WebGL support). Add -buildTarget <target> to args, or set modules.'
    )
  }
  if (o.hostOnlyInputs.length) {
    out.push(
      `${o.hostOnlyInputs.join(', ')} only apply to mode: host and are ignored in mode: docker (the default since v3)`
    )
  }
  for (const p of pathsOutsideProject(o.argv)) {
    out.push(
      `"${p}" is outside the project: in mode: docker only workdir is mounted (at /project), so Unity ` +
        'cannot read it and what it writes there is lost with the container. Use a path under $(pwd), ' +
        'e.g. $(pwd)/Builds/...'
    )
  }
  return out
}

/** Prebuilt Unity editor images maintained by GameCI (https://game.ci/docs/docker/docker-images). */
export const GAMECI_REPO = 'unityci/editor'

/**
 * GameCI image for a version, e.g. `unityci/editor:ubuntu-2022.3.20f1-android-3`.
 * Each GameCI image holds exactly one module (`base` = none), so a module set of
 * two or more has no GameCI image: undefined.
 */
export function gameciTag(
  version: string,
  modules: readonly string[],
  gameciVersion: string,
  repo: string = GAMECI_REPO
): string | undefined {
  if (modules.length > 1) return undefined
  return `${repo}:ubuntu-${version}-${modules[0] ?? 'base'}-${gameciVersion}`
}

export interface BuildImageOptions {
  tag: string
  version: string
  /** Resolved only when the image has to be built. */
  changeset: () => Promise<string | undefined>
  modules: readonly string[]
  dockerfile: string
}

export type ImageSource = 'auto' | 'gameci' | 'build'

/**
 * What to pull and/or build, from the `docker-image` and `docker-image-source`
 * inputs: `docker-image` wins; `build` never asks a registry; `gameci` pulls
 * only; `auto` pulls GameCI and builds when GameCI has no such image.
 */
export function imagePlan(o: {
  dockerImage?: string
  source: ImageSource
  version: string
  modules: readonly string[]
  gameciVersion: string
  build: BuildImageOptions
}): { pull?: string; build?: BuildImageOptions } {
  if (o.dockerImage) return { pull: o.dockerImage }
  if (o.source === 'build') return { build: o.build }
  const pull = gameciTag(o.version, o.modules, o.gameciVersion)
  if (o.source === 'auto') return pull ? { pull, build: o.build } : { build: o.build }
  if (!pull) {
    throw new InputError([
      {
        input: 'docker-image-source',
        message: `GameCI images hold one module, this build needs ${o.modules.join(', ')}: use auto or build`
      }
    ])
  }
  return { pull }
}

export interface EnsureImageOptions {
  /** Image to reuse when local, else pull (a GameCI image or the `docker-image` input). */
  pull?: string
  /** Built from the Dockerfile when `pull` is unset, or when the registry does not have it. */
  build?: BuildImageOptions
  /** `--platform` for pull and build (the Unity Linux editor is x86_64 only). Unset = daemon default. */
  platform?: string
  timeoutMs: number
  signal?: AbortSignal
  onWarning?: (message: string) => void
  /** For tests. */
  run?: typeof exec
}

export interface EnsuredImage {
  tag: string
  how: 'cached' | 'pulled' | 'built'
}

/**
 * Registry answers that mean "no such tag": `docker manifest inspect`, and
 * `docker pull` with the classic or the containerd image store. Network, auth
 * and rate-limit errors do not match.
 */
export const NOT_PUBLISHED =
  /no such manifest|manifest unknown|failed to resolve reference[^\n]*: not found/i

/**
 * Make sure an image exists locally.
 * - `pull` only: reuse it, else pull it.
 * - `pull` + `build` (auto): reuse `pull`, else reuse an earlier fallback
 *   build, else pull, else (the registry has no such tag) build.
 * - `build` only: reuse it, else build it.
 */
export async function ensureImage(o: EnsureImageOptions): Promise<EnsuredImage> {
  const run = o.run ?? exec
  const quiet = { silent: true, allowFailure: true, signal: o.signal } as const
  const platform = o.platform ? ['--platform', o.platform] : []
  const isLocal = async (tag: string): Promise<boolean> =>
    (await run('docker', ['image', 'inspect', '--format', '{{.Id}}', tag], quiet)).exitCode === 0
  const pull = async (tag: string): Promise<EnsuredImage> => {
    await run('docker', ['pull', ...platform, tag], { timeout: o.timeoutMs, signal: o.signal })
    return { tag, how: 'pulled' }
  }
  const b = o.build

  if (o.pull) {
    if (await isLocal(o.pull)) return { tag: o.pull, how: 'cached' }
    if (!b) return pull(o.pull)
    // A fallback image an earlier run built: no registry round trip at all.
    if (await isLocal(b.tag)) return { tag: b.tag, how: 'cached' }
    // The CLI asks the registry itself. Only a clear "no such tag" skips the pull: on a network,
    // auth or rate-limit error (or a timeout) the pull decides, through the daemon's own route.
    let missing = false
    try {
      const probe = await run('docker', ['manifest', 'inspect', o.pull], {
        ...quiet,
        timeout: 120_000
      })
      missing = probe.exitCode !== 0 && NOT_PUBLISHED.test(`${probe.stderr}\n${probe.stdout}`)
    } catch (err) {
      if (err instanceof AbortError) throw err
    }
    if (!missing) {
      try {
        return await pull(o.pull)
      } catch (err) {
        if (!(err instanceof ExecError && NOT_PUBLISHED.test(`${err.stderr}\n${err.stdout}`))) {
          throw err
        }
      }
    }
    o.onWarning?.(
      `${o.pull} is not published: building ${b.tag} from the Dockerfile instead ` +
        '(once per Docker daemon; it installs Unity with Unity Hub)'
    )
    return buildImage(b, platform, o, run)
  }

  if (!b) throw new CiError('E_DOCKER_IMAGE', 'No Docker image to pull or build')
  if (await isLocal(b.tag)) return { tag: b.tag, how: 'cached' }
  return buildImage(b, platform, o, run)
}

async function buildImage(
  b: BuildImageOptions,
  platform: readonly string[],
  o: Pick<EnsureImageOptions, 'timeoutMs' | 'signal'>,
  run: typeof exec
): Promise<EnsuredImage> {
  const changeset = await b.changeset()
  if (!changeset) {
    throw new CiError(
      'E_UNITY_CHANGESET',
      `Building a Unity ${b.version} image needs its changeset: set the "changeset" input ` +
        '(see ProjectSettings/ProjectVersion.txt, m_EditorVersionWithRevision)'
    )
  }
  await run(
    'docker',
    [
      'build',
      ...platform,
      '--tag',
      b.tag,
      '--build-arg',
      `UNITY_VERSION=${b.version}`,
      '--build-arg',
      `UNITY_CHANGESET=${changeset}`,
      '--build-arg',
      `UNITY_MODULES=${b.modules.join(' ')}`,
      '--label',
      `ci-sdk.unity.version=${b.version}`,
      '--file',
      b.dockerfile,
      path.dirname(b.dockerfile)
    ],
    { timeout: o.timeoutMs, signal: o.signal }
  )
  return { tag: b.tag, how: 'built' }
}

/** Stop a container that outlived its docker CLI after a timeout or a hung editor. */
export async function stopContainer(
  name: string,
  graceSeconds: number = STOP_GRACE_SECONDS
): Promise<void> {
  const quiet = { silent: true, allowFailure: true } as const
  // -t: --time on older CLIs, --timeout on newer ones.
  await exec('docker', ['stop', '-t', String(graceSeconds), name], {
    ...quiet,
    timeout: (graceSeconds + 15) * 1000
  })
  await exec('docker', ['rm', '--force', name], { ...quiet, timeout: 30_000 })
}

/**
 * On cancel the runner force-kills the action about 10 s after SIGINT: too
 * soon to wait for the license return, and `docker stop` would SIGKILL the
 * container when its grace ran out. Signal it instead (a repeat of the SIGTERM
 * the docker CLI forwarded) and let it clean up and remove itself (`--rm`).
 */
export async function signalContainer(name: string): Promise<void> {
  await exec('docker', ['kill', '--signal', 'TERM', name], {
    silent: true,
    allowFailure: true,
    timeout: 15_000
  })
}
