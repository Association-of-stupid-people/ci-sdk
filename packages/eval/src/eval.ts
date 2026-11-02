export type Provider = 'github' | 'vars' | 'secrets'

export interface EvalSources {
  github?: unknown
  vars?: Record<string, unknown>
  secrets?: Record<string, unknown>
}

export interface EvalResult {
  value: string
  /** Secret values that were substituted (to be masked in logs). */
  secretsUsed: string[]
  /** Placeholders that could not be resolved and were left as-is. */
  unresolved: string[]
}

// `{provider:path}`; path may contain dots, brackets and colons (`{github:event.head_commit.id}`).
const PLACEHOLDER = /\{(github|vars|secrets):([^{}]+)\}/g

/** Read `a.b[0].c` from an object (replacement for lodash.get). */
export function getPath(source: unknown, path: string): unknown {
  const keys = path
    .replace(/\[(\w+)\]/g, '.$1')
    .split('.')
    .filter(k => k !== '')
  let current: unknown = source
  for (const key of keys) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

function stringify(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

/**
 * Replace `{github:...}`, `{vars:...}` and `{secrets:...}` placeholders.
 * Unknown providers and missing values are left untouched (same as v1), so
 * other `{...}` text in the template (e.g. shell `${VAR}`) is preserved.
 */
export function evaluate(template: string, sources: EvalSources): EvalResult {
  const secretsUsed = new Set<string>()
  const unresolved = new Set<string>()

  const value = template.replace(PLACEHOLDER, (whole, provider: Provider, rawPath: string) => {
    const path = rawPath.trim()
    const source =
      provider === 'github' ? sources.github : provider === 'vars' ? sources.vars : sources.secrets
    const resolved = stringify(getPath(source, path))
    if (resolved === undefined || resolved === '') {
      unresolved.add(whole)
      return whole
    }
    if (provider === 'secrets') secretsUsed.add(resolved)
    return resolved
  })

  return { value, secretsUsed: [...secretsUsed], unresolved: [...unresolved] }
}
