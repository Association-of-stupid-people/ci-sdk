import * as core from '@actions/core'
import { randomUUID } from 'node:crypto'
import { formatDuration } from './duration.js'
import { errorMessage } from './errors.js'

/**
 * Run `fn` inside a collapsible log group and print how long it took.
 * The group is always closed, even when `fn` throws.
 */
export async function group<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const started = performance.now()
  core.startGroup(name)
  try {
    const value = await fn()
    core.info(`✔ ${name} (${formatDuration(performance.now() - started)})`)
    return value
  } catch (err) {
    core.info(`✖ ${name} (${formatDuration(performance.now() - started)}): ${errorMessage(err)}`)
    throw err
  } finally {
    core.endGroup()
  }
}

/**
 * Print untrusted text (container logs, remote output) without letting it run
 * workflow commands: a line like `::error::` or `::add-mask::` inside it is
 * shown, not processed. Uses `::stop-commands::<random token>`.
 */
export function printUntrusted(text: string): void {
  if (text === '') return
  const token = `ci-sdk-${randomUUID()}`
  core.info(`::stop-commands::${token}`)
  try {
    core.info(text.replace(/\r?\n$/, ''))
  } finally {
    core.info(`::${token}::`)
  }
}

/**
 * Run `fn` with workflow commands disabled, for steps that stream untrusted
 * output live (e.g. `exec` of a remote script). `fn` must not call `core.*`
 * commands itself (`setOutput`/`saveState` use files and are fine).
 */
export async function withoutCommands<T>(fn: () => Promise<T>): Promise<T> {
  const token = `ci-sdk-${randomUUID()}`
  core.info(`::stop-commands::${token}`)
  try {
    return await fn()
  } finally {
    // Leading newline: fn's output may end mid-line (killed process), and the
    // runner only reads the resume command at the start of a line.
    core.info(`\n::${token}::`)
  }
}

/** Mask a value (and its common encodings) in all later log output. */
export function mask(value: string): void {
  if (value === '') return
  core.setSecret(value)
  const b64 = Buffer.from(value, 'utf8').toString('base64')
  if (b64 !== value) core.setSecret(b64)
  const uri = encodeURIComponent(value)
  if (uri !== value) core.setSecret(uri)
}

export interface AnnotationLocation {
  file?: string
  line?: number
  column?: number
  title?: string
}

/** Error/warning annotations shown on the PR "Files changed" tab and run summary. */
export const annotate = {
  error(message: string | Error, where: AnnotationLocation = {}): void {
    core.error(message, toProps(where))
  },
  warning(message: string | Error, where: AnnotationLocation = {}): void {
    core.warning(message, toProps(where))
  },
  notice(message: string | Error, where: AnnotationLocation = {}): void {
    core.notice(message, toProps(where))
  }
}

function toProps(where: AnnotationLocation): core.AnnotationProperties {
  return {
    file: where.file,
    startLine: where.line,
    startColumn: where.column,
    title: where.title
  }
}
