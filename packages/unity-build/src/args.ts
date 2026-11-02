import { parseCommandLine } from '../../sdk/src/index.js'

export const DEFAULT_ARGS =
  '-batchmode -nographics -silent-crashes -quit -logFile - -executeMethod BuildScript.BuildCLI'

/** Flags that put a secret on the Unity command line (visible in process lists). */
const SECRET_FLAGS = new Set([
  '-keystorepass',
  '-keystorepassword',
  '-keystorealiaspassword',
  '-keyaliaspass',
  '-keyaliaspassword',
  '-password',
  '-serial'
])

export interface UnityArgs {
  argv: string[]
  /** Path given with `-logFile <path>` (Unity now logs to stdout and the action tees it there). */
  logFile: string | undefined
  /** Secret-looking flags found on the command line. */
  secretFlags: string[]
  /** Their values, to redact from the log file. */
  secretValues: string[]
  /** `$NAME` / `${NAME}` references with no such environment variable (kept literally). */
  unresolved: string[]
  /** Value of `-buildTarget`, if any. */
  buildTarget: string | undefined
}

const lower = (s: string): string => s.toLowerCase()

/**
 * Build the Unity argv from the `default-args-override` and `args` inputs.
 *
 * - No shell: values are passed verbatim. For compatibility with the old
 *   composite (which ran through bash), `$(pwd)`/`$PWD`/`${PWD}` become
 *   `projectDir`, other `$NAME`/`${NAME}` come from `env`, and a `\` at the
 *   end of a line continues it. Expansion happens per argument, after
 *   splitting, so a value with spaces stays one argument.
 * - `-logFile <file>` becomes `-logFile -` so the action can stream and scan
 *   the log; the action writes the file itself.
 * - `-projectPath` is appended when missing.
 */
export function buildUnityArgs(o: {
  defaultArgs: string
  args: string
  projectDir: string
  env?: Readonly<Record<string, string | undefined>>
}): UnityArgs {
  const unresolved = new Set<string>()
  const expand = (s: string): string =>
    s
      .replace(/\$\(pwd\)/g, o.projectDir)
      .replace(
        /\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g,
        (whole, braced?: string, bare?: string) => {
          const name = braced ?? bare ?? ''
          if (name === 'PWD') return o.projectDir
          const value = o.env?.[name]
          if (value === undefined) {
            unresolved.add(name)
            return whole
          }
          return value
        }
      )
  const split = (s: string): string[] => {
    const joined = s.replace(/\\\r?\n/g, ' ')
    return joined.trim() ? parseCommandLine(joined).map(expand) : []
  }
  const argv = [...split(o.defaultArgs), ...split(o.args)]

  let logFile: string | undefined
  let hasLog = false
  for (let i = 0; i < argv.length; i++) {
    if (lower(argv[i] ?? '') !== '-logfile') continue
    hasLog = true
    const next = argv[i + 1]
    if (next === '-') continue
    if (next === undefined || next.startsWith('-')) {
      // "-logFile" with no value means stdout on Linux but the default file elsewhere.
      argv.splice(i + 1, 0, '-')
    } else {
      logFile = next
      argv[i + 1] = '-'
    }
  }
  if (!hasLog) argv.push('-logFile', '-')
  if (!argv.some(a => lower(a) === '-projectpath')) argv.push('-projectPath', o.projectDir)

  const secretFlags: string[] = []
  const secretValues: string[] = []
  argv.forEach((a, i) => {
    if (!SECRET_FLAGS.has(lower(a))) return
    secretFlags.push(a)
    const value = argv[i + 1]
    if (value && !value.startsWith('-')) secretValues.push(value)
  })
  const targetAt = argv.findIndex(a => lower(a) === '-buildtarget')
  return {
    argv,
    logFile,
    secretFlags,
    secretValues,
    unresolved: [...unresolved],
    buildTarget: targetAt >= 0 ? argv[targetAt + 1] : undefined
  }
}

/** Hub module ids needed for a `-buildTarget` on any host. */
const TARGET_MODULES: Readonly<Record<string, string>> = {
  android: 'android',
  ios: 'ios',
  tvos: 'appletv',
  webgl: 'webgl'
}

/** Standalone targets: the support module is only needed when the host OS differs. */
const STANDALONE: Readonly<Record<string, [NodeJS.Platform, string]>> = {
  standalonewindows: ['win32', 'windows-mono'],
  standalonewindows64: ['win32', 'windows-mono'],
  win: ['win32', 'windows-mono'],
  win64: ['win32', 'windows-mono'],
  standaloneosx: ['darwin', 'mac-mono'],
  osxuniversal: ['darwin', 'mac-mono'],
  standalonelinux64: ['linux', 'linux-mono'],
  linux64: ['linux', 'linux-mono']
}

export function modulesForTarget(
  buildTarget: string | undefined,
  hostPlatform: NodeJS.Platform
): string[] {
  if (!buildTarget) return []
  const key = lower(buildTarget)
  const module = TARGET_MODULES[key]
  if (module) return [module]
  const standalone = STANDALONE[key]
  return standalone && standalone[0] !== hostPlatform ? [standalone[1]] : []
}
