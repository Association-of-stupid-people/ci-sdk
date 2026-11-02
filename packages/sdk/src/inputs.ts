import * as core from '@actions/core'
import { parseDuration } from './duration.js'
import { InputError, errorMessage, type InputIssue } from './errors.js'

/**
 * Declarative, typed action inputs.
 *
 * ```ts
 * const cfg = readInputs({
 *   retries: input.number({ default: 0, min: 0, integer: true }),
 *   timeout: input.duration({ default: '10m' }),
 *   token: input.string({ required: true, secret: true }),
 *   workingDirectory: input.string({ name: 'working-directory' })
 * })
 * // cfg.retries: number, cfg.workingDirectory: string | undefined
 * ```
 *
 * Every input is validated before anything throws, so one failed run reports
 * all bad inputs at once instead of one per re-run.
 */
export interface InputSpec<T> {
  /** Input name in action.yml; defaults to the key used in `readInputs`. */
  readonly name: string | undefined
  readonly required: boolean
  readonly hasDefault: boolean
  readonly defaultValue: T | undefined
  /** Register the raw value with the log masker. */
  readonly secret: boolean
  parse(raw: string): T
}

interface BaseOptions<T> {
  name?: string
  required?: boolean
  default?: T
  secret?: boolean
}

/** `T` when the input is required or has a default, otherwise `T | undefined`. */
export type InputValue<T, O> = O extends { required: true }
  ? T
  : O extends { default: unknown }
    ? T
    : T | undefined

function spec<T, O extends BaseOptions<unknown>>(
  options: O | undefined,
  parse: (raw: string) => T,
  defaultValue: unknown = options?.default
): InputSpec<InputValue<T, O>> {
  return {
    name: options?.name,
    required: options?.required === true,
    hasDefault: defaultValue !== undefined,
    defaultValue: defaultValue as InputValue<T, O> | undefined,
    secret: options?.secret === true,
    parse: parse as (raw: string) => InputValue<T, O>
  }
}

export interface StringOptions extends BaseOptions<string> {
  pattern?: RegExp
  minLength?: number
  maxLength?: number
}

export interface NumberOptions extends BaseOptions<number> {
  min?: number
  max?: number
  integer?: boolean
}

export interface ListOptions extends BaseOptions<string[]> {
  /** Item separator. Default: newline or comma. */
  separator?: string | RegExp
  /** Lines starting with `#` are dropped. Default false (true for `input.lines`). */
  comments?: boolean
}

export interface DurationOptions extends BaseOptions<number | string> {
  min?: number | string
  max?: number | string
}

export interface JsonOptions<T> extends BaseOptions<T> {
  /** Type guard / validator; return false or throw to reject the value. */
  validate?: (value: unknown) => value is T
}

type GuardType<O> = O extends { validate: (value: unknown) => value is infer T } ? T : unknown

const TRUE = new Set(['true', 'yes', 'y', 'on', '1'])
const FALSE = new Set(['false', 'no', 'n', 'off', '0'])

function splitList(raw: string, separator: string | RegExp, comments: boolean): string[] {
  return raw
    .split(separator)
    .map(item => item.trim())
    .filter(item => item !== '' && !(comments && item.startsWith('#')))
}

export const input = {
  string<const O extends StringOptions = Record<never, never>>(options?: O) {
    return spec<string, O>(options, raw => {
      if (options?.minLength !== undefined && raw.length < options.minLength)
        throw new Error(`must be at least ${options.minLength} characters`)
      if (options?.maxLength !== undefined && raw.length > options.maxLength)
        throw new Error(`must be at most ${options.maxLength} characters`)
      if (options?.pattern && !options.pattern.test(raw))
        throw new Error(`must match ${String(options.pattern)}`)
      return raw
    })
  },

  number<const O extends NumberOptions = Record<never, never>>(options?: O) {
    return spec<number, O>(options, raw => {
      const value = Number(raw)
      if (raw.trim() === '' || !Number.isFinite(value)) throw new Error(`"${raw}" is not a number`)
      if (options?.integer && !Number.isInteger(value)) throw new Error('must be an integer')
      if (options?.min !== undefined && value < options.min)
        throw new Error(`must be >= ${options.min}`)
      if (options?.max !== undefined && value > options.max)
        throw new Error(`must be <= ${options.max}`)
      return value
    })
  },

  /** Accepts true/false, yes/no, on/off, 1/0 (case-insensitive). */
  boolean<const O extends BaseOptions<boolean> = Record<never, never>>(options?: O) {
    return spec<boolean, O>(options, raw => {
      const value = raw.trim().toLowerCase()
      if (TRUE.has(value)) return true
      if (FALSE.has(value)) return false
      throw new Error(`"${raw}" is not a boolean (use true/false)`)
    })
  },

  /** Comma- or newline-separated list; blank items are dropped. */
  list<const O extends ListOptions = Record<never, never>>(options?: O) {
    return spec<string[], O>(options, raw =>
      splitList(raw, options?.separator ?? /\r?\n|,/, options?.comments ?? false)
    )
  },

  /** One item per line (commas kept); blank lines and `#` comments are dropped. */
  lines<const O extends BaseOptions<string[]> = Record<never, never>>(options?: O) {
    return spec<string[], O>(options, raw => splitList(raw, /\r?\n/, true))
  },

  /** One of a fixed set of values. */
  oneOf<
    const V extends readonly string[],
    const O extends BaseOptions<V[number]> = Record<never, never>
  >(values: V, options?: O) {
    return spec<V[number], O>(options, raw => {
      if (!values.includes(raw)) throw new Error(`"${raw}" must be one of: ${values.join(', ')}`)
      return raw
    })
  },

  /** Duration such as `30s`, `5m`, `1h30m` or plain milliseconds; resolves to milliseconds. */
  duration<const O extends DurationOptions = Record<never, never>>(options?: O) {
    const parse = (raw: string | number): number => {
      const ms = parseDuration(raw)
      if (options?.min !== undefined && ms < parseDuration(options.min))
        throw new Error(`must be >= ${String(options.min)}`)
      if (options?.max !== undefined && ms > parseDuration(options.max))
        throw new Error(`must be <= ${String(options.max)}`)
      return ms
    }
    const fallback = options?.default === undefined ? undefined : parse(options.default)
    return spec<number, O>(options, parse, fallback)
  },

  /**
   * JSON value. The result type comes from the `validate` type guard
   * (`unknown` without one): `input.json({ validate: isRecord, default: {} })`.
   */
  json<const O extends JsonOptions<unknown> = Record<never, never>>(options?: O) {
    type T = GuardType<O>
    return spec<T, O>(options, raw => {
      let value: unknown
      try {
        value = JSON.parse(raw)
      } catch (err) {
        throw new Error(`is not valid JSON: ${errorMessage(err)}`, { cause: err })
      }
      if (options?.validate && !options.validate(value)) throw new Error('failed validation')
      return value as T
    })
  }
}

export type InputSpecs = Record<string, InputSpec<unknown>>
export type InputValues<S extends InputSpecs> = {
  -readonly [K in keyof S]: S[K] extends InputSpec<infer T> ? T : never
}

export interface ReadInputsOptions {
  /** Raw input source. Default `core.getInput` (reads `INPUT_<NAME>` env vars, trimmed). */
  getInput?: (name: string) => string
  /** Called for secret values. Default `core.setSecret`. */
  setSecret?: (value: string) => void
}

/**
 * Read and validate all inputs described by `specs`.
 * @throws {InputError} listing every missing or invalid input.
 */
export function readInputs<S extends InputSpecs>(
  specs: S,
  options: ReadInputsOptions = {}
): InputValues<S> {
  const getInput = options.getInput ?? ((name: string) => core.getInput(name))
  const setSecret = options.setSecret ?? ((value: string) => core.setSecret(value))
  const issues: InputIssue[] = []
  const values: Record<string, unknown> = {}

  for (const [key, s] of Object.entries(specs)) {
    const name = s.name ?? key
    const raw = getInput(name)
    if (s.secret && raw !== '') setSecret(raw)

    if (raw === '') {
      if (s.required && !s.hasDefault) issues.push({ input: name, message: 'is required' })
      values[key] = s.defaultValue
      continue
    }
    try {
      values[key] = s.parse(raw)
    } catch (err) {
      issues.push({ input: name, message: errorMessage(err) })
    }
  }

  if (issues.length > 0) throw new InputError(issues)
  return values as InputValues<S>
}
