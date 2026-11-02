/**
 * Convert a branch pattern to a RegExp. `*` matches within one path segment,
 * `**` matches across `/`, `?` matches one character; everything else is literal.
 */
export function patternToRegExp(pattern: string): RegExp {
  let source = ''
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] as string
    if (ch === '*' && pattern[i + 1] === '*') {
      source += '.*'
      i++
    } else if (ch === '*') source += '[^/]*'
    else if (ch === '?') source += '[^/]'
    else source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`)
}

/**
 * Whether `branch` is allowed by `patterns`. Patterns starting with `!`
 * exclude (evaluated in order, last match wins), like GitHub's `branches:` filter.
 */
export function isBranchAllowed(branch: string, patterns: readonly string[]): boolean {
  let allowed = false
  for (const raw of patterns) {
    const negated = raw.startsWith('!')
    const pattern = negated ? raw.slice(1) : raw
    if (patternToRegExp(pattern).test(branch)) allowed = !negated
  }
  return allowed
}
