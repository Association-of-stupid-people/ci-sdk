export type IssueKind = 'license' | 'compile' | 'build' | 'exception'

export interface UnityIssue {
  kind: IssueKind
  message: string
  /** Project-relative source file (compile errors). */
  file?: string
  line?: number
  column?: number
}

/**
 * Lines that mean Unity could not get a license. Deliberately strict: Unity
 * logs harmless licensing noise (e.g. "Access token is unavailable") in
 * successful builds, and a match here makes a failed build retry.
 */
export const LICENSE_PATTERNS: readonly RegExp[] = [
  /No valid Unity (?:Editor )?licen[cs]e found/i,
  /Unity has not been activated/i,
  /(?:Failed|Unable) to (?:activate|update|verify|acquire|initiali[sz]e|renew|return) (?:the |your )?(?:Unity )?licen[cs]e/i,
  /Licen[cs]e (?:activation|return|update|initiali[sz]ation|validation|verification) (?:has )?failed/i,
  /Licensing initiali[sz]ation failed/i,
  /No ULF licen[cs]e found/i,
  /Licen[cs]e (?:is )?(?:not active|invalid|expired|has expired|revoked)/i,
  // Not "Error: Code <n>": coded licensing-client lines also show up in builds that succeed.
  /\[Licensing::Client\] Error: (?:Failed to (?:connect|start|activate)|Unable to|Timed? ?out)/i,
  /Floating licen[cs]e .*(?:failed|unavailable|not available)/i,
  /No (?:available |free )?(?:floating )?(?:licen[cs]es?|seats?) (?:available|left)/i
]

const COMPILE = /^(.+?\.cs)\((\d+),(\d+)\): error (CS\d+): (.+)$/
const EXCEPTION = /^(?:Unhandled )?(?:[A-Za-z_][\w]*\.)*[A-Za-z_]\w*Exception: .+/

interface Rule {
  kind: IssueKind
  re: RegExp
  /** The useful message is on the next non-blank line (Gradle "What went wrong:"). */
  next?: string
}

const BUILD_RULES: readonly Rule[] = [
  { kind: 'build', re: /\* What went wrong:/, next: 'Gradle: ' },
  { kind: 'build', re: /Aborting batchmode due to (?:failure|fatal error):\s*$/, next: '' },
  { kind: 'build', re: /Aborting batchmode due to (?:failure|fatal error):\s*\S/ },
  { kind: 'build', re: /Error building Player/ },
  { kind: 'build', re: /BuildFailedException: / },
  { kind: 'build', re: /CommandInvokationFailure: / },
  { kind: 'build', re: /Scripts have compiler errors/ },
  { kind: 'build', re: /executeMethod .*could not be found/ },
  { kind: 'build', re: /Build Finished, Result: Failure/ }
]

const MAX_LINE = 64 * 1024

/**
 * Streaming scanner for the Unity Editor log: keeps a bounded, de-duplicated
 * list of errors worth showing in the job summary, and the facts needed to
 * decide whether a failed build is worth retrying.
 */
export class UnityLogScanner {
  readonly issues: UnityIssue[] = []
  /** Issues found, including the ones dropped past `maxIssues` and duplicates. */
  total = 0
  /** "Build Finished, Result: Failure" seen (Unity may still exit 0). */
  buildResultFailure = false
  private rest = ''
  private readonly seen = new Set<string>()
  private expectNext: { kind: IssueKind; prefix: string } | undefined
  private readonly licensePatterns: readonly RegExp[]

  constructor(
    private readonly maxIssues = 50,
    extraLicensePatterns: readonly RegExp[] = []
  ) {
    this.licensePatterns = [...LICENSE_PATTERNS, ...extraLicensePatterns]
  }

  push(chunk: string): void {
    const lines = (this.rest + chunk).split(/\r?\n/)
    this.rest = lines.pop() ?? ''
    if (this.rest.length > MAX_LINE) this.rest = this.rest.slice(-MAX_LINE)
    for (const line of lines) this.scanLine(line)
  }

  /** Flush the last unterminated line. */
  end(): void {
    if (this.rest) this.scanLine(this.rest)
    this.rest = ''
  }

  has(kind: IssueKind): boolean {
    return this.issues.some(i => i.kind === kind)
  }

  private add(issue: UnityIssue): void {
    this.total++
    const key = `${issue.kind}\0${issue.message}`
    if (this.seen.has(key) || this.issues.length >= this.maxIssues) return
    this.seen.add(key)
    this.issues.push(issue)
  }

  private scanLine(raw: string): void {
    const line = raw.trim()
    if (this.expectNext) {
      if (!line) return
      const { kind, prefix } = this.expectNext
      this.expectNext = undefined
      // "Aborting batchmode due to failure:" followed by a license error is a license failure.
      const license = this.licensePatterns.some(re => re.test(line))
      this.add({ kind: license ? 'license' : kind, message: prefix + line })
      return
    }
    if (!line) return

    const compile = COMPILE.exec(line)
    if (compile) {
      const [, file = '', ln = '0', col = '0', code = '', message = ''] = compile
      this.add({
        kind: 'compile',
        message: `${file}(${ln},${col}): error ${code}: ${message}`,
        file: file.replace(/\\/g, '/'),
        line: Number(ln),
        column: Number(col)
      })
      return
    }
    for (const rule of BUILD_RULES) {
      if (!rule.re.test(line)) continue
      if (/Build Finished, Result: Failure/.test(line)) this.buildResultFailure = true
      if (rule.next !== undefined) this.expectNext = { kind: rule.kind, prefix: rule.next }
      else this.add({ kind: rule.kind, message: line })
      return
    }
    if (this.licensePatterns.some(re => re.test(line))) {
      this.add({ kind: 'license', message: line })
      return
    }
    if (EXCEPTION.test(line)) this.add({ kind: 'exception', message: line })
  }
}

/**
 * Why a failed run failed. `license` only when the log shows a license error
 * and nothing else that explains the failure: a real compile/build error must
 * never be retried just because licensing noise appeared too.
 */
export function classifyFailure(scan: Pick<UnityLogScanner, 'has'>): 'license' | 'build' {
  const explained = scan.has('compile') || scan.has('build') || scan.has('exception')
  return scan.has('license') && !explained ? 'license' : 'build'
}
