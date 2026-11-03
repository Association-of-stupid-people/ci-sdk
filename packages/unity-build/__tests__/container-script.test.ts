import { spawn, spawnSync, type ChildProcess, type SpawnSyncReturns } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CONTAINER_SCRIPT } from '../src/docker.js'
import { UnityLogScanner } from '../src/log-scan.js'

/**
 * CONTAINER_SCRIPT under POSIX sh (dash on Debian/Ubuntu, as in the GameCI images) with a fake
 * `unity-editor` shaped like GameCI's: a wrapper that runs the editor as a child (no exec), an
 * editor that needs 1 s to shut down after SIGTERM, and a license return that takes a while.
 * Outside a container the script only creates /tmp/ci-blank: there is no /project to chown, and
 * only F... serials touch the machine id.
 *
 * The signal tests start the script as a process group leader, as the init process does, and send
 * "docker stop" as a SIGTERM to that whole group (TINI_KILL_PROCESS_GROUP=1). They need setsid
 * (util-linux), as the images have, and a PID 1 that reaps orphans, as tini does: the editor
 * outlives its wrapper, and an orphan left as a zombie still counts as a member of its process
 * group (`tail -f /dev/null` as PID 1 in a GitHub `container:` job does not reap).
 */
const posix = process.platform !== 'win32'
const hasSetsid = posix && spawnSync('setsid', ['-w', 'true']).status === 0
const hasGit = posix && spawnSync('git', ['--version']).status === 0
const reapsOrphans = ((): boolean => {
  if (!posix) return false
  const r = spawnSync('sh', ['-c', 'sleep 0.2 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' })
  spawnSync('sleep', ['0.8'])
  try {
    // "<pid> (sleep) Z ...": exited, never reaped.
    return !/^\d+ \(.*\) Z /.test(readFileSync(`/proc/${r.stdout.trim()}/stat`, 'utf8'))
  } catch {
    return true // reaped, or no /proc (macOS: launchd reaps)
  }
})()
const signals = hasSetsid && reapsOrphans

const WRAPPER = [
  '#!/bin/sh',
  'case " $* " in',
  '  *" -serial "*)',
  '    FAKE_ARGS="$*" "$(dirname "$0")/fake-activation"',
  '    exit $? ;;',
  '  *" -returnlicense "*)',
  '    echo "return start $*" >>"$FAKE_LOG"',
  '    sleep "${FAKE_RETURN_SECS:-0}"',
  '    if [ -n "${FAKE_RETURN_EXIT:-}" ]; then',
  '      while [ $# -gt 1 ]; do [ "$1" = -logFile ] && printf "%s\n" "$FAKE_RETURN_LOG" >"$2"; shift; done',
  '      exit "$FAKE_RETURN_EXIT"',
  '    fi',
  '    echo "return done" >>"$FAKE_LOG"',
  '    exit 0 ;;',
  'esac',
  // FAKE_EXEC: a wrapper that execs the editor, which then leads the session itself.
  '[ -z "${FAKE_EXEC:-}" ] || exec "$(dirname "$0")/fake-editor" "$@"',
  '"$(dirname "$0")/fake-editor" "$@"',
  ''
].join('\n')

/** The editors run as children of the wrapper and need 1 s to exit after SIGTERM (or ignore it). */
const EDITOR = [
  '#!/bin/sh',
  'trap \'sleep 1; echo "editor exited" >>"$FAKE_LOG"; exit 143\' TERM',
  '[ -z "${FAKE_IGNORE_TERM:-}" ] || trap \'\' TERM',
  'echo "editor start $*" >>"$FAKE_LOG"',
  'echo building',
  'i=0',
  'while [ "$i" -lt "${FAKE_BUILD_SECS:-0}" ]; do sleep 1; i=$((i + 1)); done',
  'echo "editor done" >>"$FAKE_LOG"',
  // FAKE_PARTIAL: the last output line has no newline (a progress line, an editor killed mid-line).
  '[ -z "${FAKE_PARTIAL:-}" ] || printf "progress 50%%"',
  'exit "${FAKE_BUILD_EXIT:-0}"',
  ''
].join('\n')

/** Logs the call only once its trap is set: a test that stops the script on that line must not race the trap. */
const ACTIVATION = [
  '#!/bin/sh',
  'trap \'sleep 1; echo "activation stopped" >>"$FAKE_LOG"; exit 143\' TERM',
  'echo "activate $FAKE_ARGS" >>"$FAKE_LOG"',
  'i=0',
  'while [ "$i" -lt "${FAKE_ACTIVATE_SECS:-0}" ]; do sleep 1; i=$((i + 1)); done',
  'exit "${FAKE_ACTIVATE_EXIT:-0}"',
  ''
].join('\n')

describe.skipIf(!posix)('container script', () => {
  let dir: string
  let log: string
  let child: ChildProcess | undefined

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ci-unity-'))
    log = path.join(dir, 'calls.log')
    writeFileSync(log, '')
    for (const [name, body] of [
      ['unity-editor', WRAPPER],
      ['fake-editor', EDITOR],
      ['fake-activation', ACTIVATION]
    ] as const) {
      writeFileSync(path.join(dir, name), body)
      chmodSync(path.join(dir, name), 0o755)
    }
  })
  afterEach(() => {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        // already gone
      }
    }
    child = undefined
    rmSync(dir, { recursive: true, force: true })
  })

  // HOME: the script runs `git config --global`, which must not touch the real ~/.gitconfig.
  const env = (extra: Record<string, string>): NodeJS.ProcessEnv => ({
    PATH: `${dir}:${process.env.PATH ?? ''}`,
    HOME: dir,
    FAKE_LOG: log,
    ...extra
  })
  const runScript = (extra: Record<string, string> = {}): SpawnSyncReturns<string> =>
    spawnSync('sh', ['-c', CONTAINER_SCRIPT, 'ci-unity', '-quit', '-buildTarget', 'Android'], {
      env: env(extra),
      encoding: 'utf8'
    })
  const calls = (): string[] => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
  /** The first two words of each call: what happened, in order. */
  const events = (): string[] => calls().map(c => c.split(' ').slice(0, 2).join(' '))

  /** Starts the script as a process group leader, like the init process's child. */
  const start = (extra: Record<string, string>): Promise<number | null> => {
    const c = spawn('sh', ['-c', CONTAINER_SCRIPT, 'ci-unity', '-quit'], {
      env: env({ UNITY_SERIAL: 'SC-1', FAKE_RETURN_SECS: '1', ...extra }),
      stdio: 'ignore',
      detached: true
    })
    child = c
    return new Promise(resolve => c.on('exit', code => resolve(code)))
  }
  const dockerStop = (): void => {
    if (child?.pid) process.kill(-child.pid, 'SIGTERM')
  }
  const waitForCall = async (prefix: string): Promise<void> => {
    for (let i = 0; i < 200; i++) {
      if (calls().some(c => c.startsWith(prefix))) return
      await sleep(50)
    }
    throw new Error(`no "${prefix}" call; calls so far: ${calls().join(' | ')}`)
  }

  it('runs Unity with the given arguments and passes its exit code on', () => {
    const r = runScript({ FAKE_BUILD_EXIT: '3' })
    expect(r.status).toBe(3)
    expect(calls()).toEqual(['editor start -quit -buildTarget Android', 'editor done'])
  })

  it('activates a serial against an empty project, then returns it', () => {
    const r = runScript({ UNITY_SERIAL: 'SC-1', UNITY_EMAIL: 'e@x', UNITY_PASSWORD: 'p w' })
    expect(r.status).toBe(0)
    const c = calls()
    expect(c).toHaveLength(5)
    expect(c[0]).toMatch(
      /^activate .*-projectPath \/tmp\/ci-blank -serial SC-1 -username e@x -password p w$/
    )
    expect(c.slice(1, 3)).toEqual(['editor start -quit -buildTarget Android', 'editor done'])
    expect(c[3]).toMatch(
      /^return start .*-projectPath \/tmp\/ci-blank -returnlicense -username e@x -password p w$/
    )
    expect(c[4]).toBe('return done')
  })

  it('skips the build when activation fails and still returns the seat', () => {
    const r = runScript({ UNITY_SERIAL: 'SC-1', FAKE_ACTIVATE_EXIT: '7' })
    expect(r.status).toBe(7)
    expect(r.stdout).toContain('Failed to activate the Unity license (exit 7)')
    expect(events()).toEqual(['activate -batchmode', 'return start', 'return done'])
  })

  it('no seat warning when the return after a failed activation fails too', () => {
    const r = runScript({ UNITY_SERIAL: 'SC-1', FAKE_ACTIVATE_EXIT: '7', FAKE_RETURN_EXIT: '1' })
    expect(r.status).toBe(7)
    expect(events()).toEqual(['activate -batchmode', 'return start'])
    expect(r.stdout).not.toContain('ci-unity:')
  })

  it('the seat warning survives an unterminated last line of Unity output', () => {
    const r = runScript({ UNITY_SERIAL: 'SC-1', FAKE_PARTIAL: '1', FAKE_RETURN_EXIT: '1' })
    const scanner = new UnityLogScanner()
    scanner.push(r.stdout)
    scanner.end()
    expect(scanner.notices).toEqual(['ci-unity: could not return the license seat (exit 1)'])
  })

  it('reports a failed license return with the end of its log, keeping the exit code', () => {
    const r = runScript({
      UNITY_SERIAL: 'SC-1',
      FAKE_RETURN_EXIT: '1',
      FAKE_RETURN_LOG: [
        '-returnlicense',
        '-password',
        'Initialize engine version',
        '[Licensing::Client] Error: Code 500 while returning the license'
      ].join('\n')
    })
    expect(r.status).toBe(0)
    expect(r.stdout.split('\n').filter(l => l.startsWith('ci-unity:'))).toEqual([
      'ci-unity: could not return the license seat (exit 1)',
      'ci-unity:   [Licensing::Client] Error: Code 500 while returning the license'
    ])
  })

  it.skipIf(!hasGit)('lets git read a checkout root does not own', () => {
    runScript()
    expect(readFileSync(path.join(dir, '.gitconfig'), 'utf8')).toMatch(/directory = \*/)
  })

  it.skipIf(!signals)(
    'docker stop: waits for the whole editor, returns the seat, exits 143',
    async () => {
      const exited = start({ FAKE_BUILD_SECS: '30' })
      await waitForCall('editor start')
      dockerStop()
      expect(await exited).toBe(143)
      expect(events()).toEqual([
        'activate -batchmode',
        'editor start',
        'editor exited',
        'return start',
        'return done'
      ])
    },
    20_000
  )

  it.skipIf(!signals)(
    'a second SIGTERM does not cut the license return short',
    async () => {
      const exited = start({ FAKE_BUILD_SECS: '30', FAKE_RETURN_SECS: '2' })
      await waitForCall('editor start')
      dockerStop()
      await waitForCall('return start')
      dockerStop()
      expect(await exited).toBe(143)
      expect(events()).toEqual([
        'activate -batchmode',
        'editor start',
        'editor exited',
        'return start',
        'return done'
      ])
    },
    20_000
  )

  it.skipIf(!signals)(
    'SIGTERM during activation: no build, the seat is still returned',
    async () => {
      const exited = start({ FAKE_ACTIVATE_SECS: '30' })
      await waitForCall('activate')
      dockerStop()
      expect(await exited).toBe(143)
      // The activating editor is gone before the return opens the same empty project.
      expect(events()).toEqual([
        'activate -batchmode',
        'activation stopped',
        'return start',
        'return done'
      ])
    },
    20_000
  )

  it.skipIf(!signals)(
    'an editor that ignores SIGTERM is killed after the stop wait, then the seat is returned',
    async () => {
      // The wrapper execs the editor: the process the script started is the hung editor itself.
      const exited = start({
        FAKE_BUILD_SECS: '60',
        FAKE_EXEC: '1',
        FAKE_IGNORE_TERM: '1',
        CI_UNITY_STOP_WAIT: '2'
      })
      await waitForCall('editor start')
      const stopped = Date.now()
      dockerStop()
      expect(await exited).toBe(143)
      expect(Date.now() - stopped).toBeLessThan(10_000)
      expect(events()).toEqual([
        'activate -batchmode',
        'editor start',
        'return start',
        'return done'
      ])
    },
    20_000
  )

  it.skipIf(!signals)(
    "SIGTERM during the normal cleanup: the return finishes and the build's exit code stays",
    async () => {
      const exited = start({ FAKE_RETURN_SECS: '2' })
      await waitForCall('return start')
      dockerStop()
      expect(await exited).toBe(0)
      expect(events()).toEqual([
        'activate -batchmode',
        'editor start',
        'editor done',
        'return start',
        'return done'
      ])
    },
    20_000
  )
})
