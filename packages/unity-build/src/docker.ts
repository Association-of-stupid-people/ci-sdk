import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CiError, exec } from '../../sdk/src/index.js'

/** Where the project is mounted inside the container. */
export const CONTAINER_PROJECT = '/project'
/** Where Unity looks for a manual-activation license as root on Linux. */
export const CONTAINER_ULF = '/root/.local/share/unity3d/Unity/Unity_lic.ulf'

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
 * activated before and returned after the build; files are chowned back to
 * the runner user so the self-hosted workspace stays cleanable.
 *
 * Activation/return log to their own files (Unity echoes its command line,
 * serial included, at the top of a log). On `docker stop` the init process
 * signals the whole group (TINI_KILL_PROCESS_GROUP), Unity exits and the trap
 * still returns the seat and fixes ownership.
 */
export const CONTAINER_SCRIPT = [
  'code=0',
  'pid=',
  'cleaned=',
  'cleanup() {',
  '  [ -n "$cleaned" ] && return 0',
  '  cleaned=1',
  '  if [ -n "${UNITY_SERIAL:-}" ]; then',
  '    unity-editor -batchmode -nographics -quit -logFile /tmp/ci-return.log -returnlicense -username "${UNITY_EMAIL:-}" -password "${UNITY_PASSWORD:-}" >/dev/null 2>&1 || echo "ci-unity: could not return the license seat"',
  '  fi',
  '  if [ -n "${HOST_UID:-}" ]; then chown -R "$HOST_UID:${HOST_GID:-$HOST_UID}" /project 2>/dev/null || true; fi',
  '}',
  'trap \'[ -n "$pid" ] && kill -TERM "$pid" 2>/dev/null && wait "$pid"; cleanup; exit 143\' TERM INT',
  'if [ -n "${UNITY_SERIAL:-}" ]; then',
  '  unity-editor -batchmode -nographics -quit -logFile /tmp/ci-activate.log -serial "$UNITY_SERIAL" -username "${UNITY_EMAIL:-}" -password "${UNITY_PASSWORD:-}" >/dev/null 2>&1 || code=$?',
  '  if [ "$code" -ne 0 ]; then',
  '    echo "Failed to activate the Unity license (exit $code)"',
  '    grep -iE "licen|error" /tmp/ci-activate.log | grep -v -e "-serial" -e "-password" | tail -n 20',
  '  fi',
  'fi',
  'if [ "$code" -eq 0 ]; then unity-editor "$@" & pid=$!; wait "$pid"; code=$?; fi',
  'cleanup',
  'exit "$code"'
].join('\n')

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
  mounts?: readonly Mount[]
  envNames?: readonly string[]
  gradleVolume?: string
  unityArgs: readonly string[]
}): string[] {
  const args = ['run', '--rm', '--init', '--name', o.name, '-w', CONTAINER_PROJECT]
  // docker stop: the init process signals the whole group, so Unity (not only sh) gets SIGTERM.
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

export interface EnsureImageOptions {
  tag: string
  /** Build the image when it is missing (otherwise pull it). */
  build: boolean
  version: string
  /** Resolved only when the image has to be built. */
  changeset: () => Promise<string | undefined>
  modules: readonly string[]
  dockerfile: string
  timeoutMs: number
  signal?: AbortSignal
}

/** Make sure `tag` exists locally: reuse it, else build it from the Dockerfile (or pull a given image). */
export async function ensureImage(o: EnsureImageOptions): Promise<'cached' | 'built' | 'pulled'> {
  const inspect = await exec('docker', ['image', 'inspect', '--format', '{{.Id}}', o.tag], {
    silent: true,
    allowFailure: true,
    signal: o.signal
  })
  if (inspect.exitCode === 0) return 'cached'
  if (!o.build) {
    await exec('docker', ['pull', o.tag], { timeout: o.timeoutMs, signal: o.signal })
    return 'pulled'
  }
  const changeset = await o.changeset()
  if (!changeset) {
    throw new CiError(
      'E_UNITY_CHANGESET',
      `Building a Unity ${o.version} image needs its changeset: set the "changeset" input ` +
        '(see ProjectSettings/ProjectVersion.txt, m_EditorVersionWithRevision)'
    )
  }
  await exec(
    'docker',
    [
      'build',
      '--tag',
      o.tag,
      '--build-arg',
      `UNITY_VERSION=${o.version}`,
      '--build-arg',
      `UNITY_CHANGESET=${changeset}`,
      '--build-arg',
      `UNITY_MODULES=${o.modules.join(' ')}`,
      '--label',
      `ci-sdk.unity.version=${o.version}`,
      '--file',
      o.dockerfile,
      path.dirname(o.dockerfile)
    ],
    { timeout: o.timeoutMs, signal: o.signal }
  )
  return 'built'
}

/** Stop a container left running after the docker CLI was killed (timeout, hang, cancel). */
export async function stopContainer(name: string, graceSeconds: number): Promise<void> {
  const quiet = { silent: true, allowFailure: true } as const
  // The in-container trap gets graceSeconds to return the license and chown the workspace.
  await exec('docker', ['stop', '--time', String(graceSeconds), name], {
    ...quiet,
    timeout: (graceSeconds + 15) * 1000
  })
  await exec('docker', ['rm', '--force', name], { ...quiet, timeout: 30_000 })
}
