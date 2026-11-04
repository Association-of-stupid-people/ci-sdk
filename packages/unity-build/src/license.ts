import * as core from '@actions/core'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { CiError, TimeoutError, errorMessage, exec, formatDuration } from '../../sdk/src/index.js'
import { getSerialFromLicense } from '../../extract-unity-serial/src/serial.js'
import type { HostEnv } from './locate.js'

/**
 * Time limit for one activation or return. Unity opens a blank project after
 * talking to the license server, which takes a minute or two on a cold machine.
 */
export const LICENSE_TIMEOUT_MS = 10 * 60_000

/**
 * Machine-wide license file of a serial activation (Unity 6 manual, "Unity
 * license file location"). On Linux it is per user.
 */
export function machineLicenseFile(host: HostEnv): string {
  if (host.platform === 'win32') {
    return path.win32.join(host.env.PROGRAMDATA ?? 'C:\\ProgramData', 'Unity', 'Unity_lic.ulf')
  }
  if (host.platform === 'darwin') return '/Library/Application Support/Unity/Unity_lic.ulf'
  return path.posix.join(host.home, '.local', 'share', 'unity3d', 'Unity', 'Unity_lic.ulf')
}

/**
 * Whether a .ulf holds `serial` and has not expired (empty StopDate = no end).
 * Only a hint: Unity checks the signature and the server may have revoked the
 * seat, so a license error later still re-activates.
 */
export function ulfHasSerial(ulf: string | undefined, serial: string, now = new Date()): boolean {
  if (!ulf) return false
  let found: string
  try {
    found = getSerialFromLicense(ulf)
  } catch {
    return false
  }
  if (found !== serial) return false
  const stop = /<StopDate Value="([^"]*)"/.exec(ulf)?.[1]?.trim()
  if (!stop) return true
  const end = Date.parse(stop)
  return Number.isFinite(end) && end > now.getTime()
}

export interface LicenseAccount {
  serial: string
  email: string
  password: string
}

/** `<editor> <args>` to activate a serial (Unity 6 manual, "Activate a license from the command line"). */
export function activateArgs(a: LicenseAccount, logFile: string, project: string): string[] {
  return [
    '-batchmode',
    '-nographics',
    '-quit',
    '-logFile',
    logFile,
    '-projectPath',
    project,
    '-serial',
    a.serial,
    '-username',
    a.email,
    '-password',
    a.password
  ]
}

/** `<editor> <args>` to return the active serial (Unity 6 manual, "Returning the license through the command line"). */
export function returnArgs(
  a: Pick<LicenseAccount, 'email' | 'password'>,
  logFile: string,
  project: string
): string[] {
  return [
    '-batchmode',
    '-nographics',
    '-quit',
    '-logFile',
    logFile,
    '-projectPath',
    project,
    '-returnlicense',
    '-username',
    a.email,
    '-password',
    a.password
  ]
}

/**
 * License-related lines of a Unity log, safe to print: like docker mode, drop
 * the echoed command line (`-serial`, `-password`, lines starting with `-`),
 * then replace every secret with ***.
 */
export function licenseLogLines(log: string, secrets: readonly string[], max = 20): string[] {
  const sorted = [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length)
  return log
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => /licen|error/i.test(l))
    .filter(l => !l.includes('-serial') && !l.includes('-password') && !l.startsWith('-'))
    .map(l => sorted.reduce((out, s) => out.split(s).join('***'), l))
    .slice(-max)
}

/** Activation or return failed; `lines` are already redacted. */
export class LicenseError extends CiError {
  constructor(
    code: 'E_UNITY_ACTIVATION' | 'E_UNITY_RETURN',
    message: string,
    readonly lines: readonly string[]
  ) {
    super(code, lines.length ? `${message}:\n  ${lines.join('\n  ')}` : message)
  }
}

export interface LicenseRunOptions {
  action: 'activate' | 'return'
  editor: string
  account: LicenseAccount
  /** Folder for the blank project and the log; both are deleted afterwards. */
  tempDir: string
  env: Record<string, string | undefined>
  /** Masked in printed lines (serial, email, password). */
  secrets: readonly string[]
  timeoutMs?: number
  signal?: AbortSignal
}

/**
 * Run the editor once to activate or return the serial. Like docker mode it
 * opens an empty project (with no -projectPath Unity would open the working
 * directory as a project). The log holds the command line, secrets included,
 * so it is deleted; failures carry its redacted license lines.
 *
 * @throws {LicenseError} on a non-zero exit or a timeout.
 * @throws {AbortError} when cancelled; {CiError} E_EXEC_SPAWN when the editor cannot start.
 */
export async function runLicense(o: LicenseRunOptions): Promise<void> {
  await mkdir(o.tempDir, { recursive: true })
  const dir = await mkdtemp(path.join(o.tempDir, 'unity-license-'))
  const project = path.join(dir, 'blank')
  const logFile = path.join(dir, 'license.log')
  const timeoutMs = o.timeoutMs ?? LICENSE_TIMEOUT_MS
  const code = o.action === 'activate' ? 'E_UNITY_ACTIVATION' : 'E_UNITY_RETURN'
  const what =
    o.action === 'activate'
      ? 'Failed to activate the Unity license'
      : 'Could not return the Unity license'
  const lines = async (output: string): Promise<string[]> =>
    licenseLogLines(`${await readFile(logFile, 'utf8').catch(() => '')}\n${output}`, o.secrets)
  try {
    await mkdir(path.join(project, 'Assets'), { recursive: true })
    const args =
      o.action === 'activate'
        ? activateArgs(o.account, logFile, project)
        : returnArgs(o.account, logFile, project)
    let res
    try {
      res = await exec(o.editor, args, {
        cwd: project,
        env: o.env,
        inheritEnv: false,
        timeout: timeoutMs,
        signal: o.signal,
        allowFailure: true,
        silent: true,
        maxBuffer: 64 * 1024
      })
    } catch (err) {
      // Our own limit; a step timeout or the cleanup budget arrives through the signal.
      if (err instanceof TimeoutError && !o.signal?.aborted) {
        throw new LicenseError(
          code,
          `${what}: Unity did not finish within ${formatDuration(timeoutMs)}`,
          await lines('')
        )
      }
      throw err
    }
    if (res.exitCode !== 0) {
      throw new LicenseError(
        code,
        `${what} (Unity exited with ${res.exitCode === null ? `signal ${res.signal}` : `code ${res.exitCode}`})`,
        await lines(`${res.stdout}\n${res.stderr}`)
      )
    }
  } finally {
    // The log first: it holds the secrets. Unity's licensing client may still hold a file for a
    // moment on Windows; RUNNER_TEMP is wiped after the job anyway.
    // recursive: maxRetries is ignored without it (works on a single file too).
    await rm(logFile, { recursive: true, force: true, maxRetries: 3 }).catch((err: unknown) =>
      core.warning(`Could not delete ${logFile} (it holds the Unity account): ${errorMessage(err)}`)
    )
    await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch((err: unknown) =>
      core.debug(`Could not delete ${dir}: ${errorMessage(err)}`)
    )
  }
}
