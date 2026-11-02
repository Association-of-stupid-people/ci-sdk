import * as core from '@actions/core'
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
