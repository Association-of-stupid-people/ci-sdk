import { getCiContext } from './context.js'
import { CiError, RetryError } from './errors.js'
import { mask } from './log.js'
import { retry } from './retry.js'

/** A GitHub REST call returned a non-2xx status. `status` is the HTTP status code. */
export class GitHubApiError extends CiError {
  readonly status: number
  readonly method: string
  readonly url: string
  readonly body: string
  /** Response headers (`retry-after`, `x-ratelimit-*`...). */
  readonly headers: Headers

  constructor(method: string, url: string, status: number, body: string, headers = new Headers()) {
    super('E_GITHUB_API', `GitHub API ${method} ${url} -> ${status}: ${body.slice(0, 500)}`)
    this.status = status
    this.method = method
    this.url = url
    this.body = body
    this.headers = headers
  }
}

export type QueryValue = string | number | boolean | undefined
export type Query = Record<string, QueryValue>

export interface GitHubRequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  query?: Query
  /** Plain objects are sent as JSON; `Uint8Array`/`string` bodies are sent as-is. */
  body?: unknown
  headers?: Record<string, string>
  /** Absolute base instead of the API URL (e.g. `https://uploads.github.com`). */
  baseUrl?: string
  signal?: AbortSignal
}

export interface GitHubResponse<T> {
  status: number
  data: T
  headers: Headers
}

export interface GitHubClientOptions {
  token: string
  /** Default: `GITHUB_API_URL` or `https://api.github.com`. */
  apiUrl?: string
  /** Total attempts for 5xx / 429 / network errors (never for other 4xx). Default 3. */
  attempts?: number
  /** Delay before the 2nd attempt. Default 2s. Lower it in tests. */
  minDelay?: number | string
  /** Injectable for tests. Default: global `fetch`. */
  fetch?: typeof fetch
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504])

/**
 * Minimal GitHub REST client on top of `fetch` (no Octokit): JSON in/out,
 * bounded retries on transient failures, pagination, token masked in logs.
 *
 * ```ts
 * const gh = new GitHubClient({ token: cfg.token })
 * const runs = await gh.paginate<Run>('/repos/o/r/actions/runs', { head_sha: sha }, 'workflow_runs')
 * ```
 */
export class GitHubClient {
  readonly apiUrl: string
  private readonly token: string
  private readonly attempts: number
  private readonly minDelay: number | string
  private readonly fetchImpl: typeof fetch

  constructor(options: GitHubClientOptions) {
    if (!options.token) throw new CiError('E_GITHUB_TOKEN', 'A GitHub token is required')
    mask(options.token)
    this.token = options.token
    this.apiUrl = (options.apiUrl ?? getCiContext().apiUrl).replace(/\/+$/, '')
    this.attempts = options.attempts ?? 3
    this.minDelay = options.minDelay ?? '2s'
    this.fetchImpl = options.fetch ?? fetch
  }

  /** Full URL for an API path (`/repos/...`) or an absolute URL, with query parameters. */
  url(path: string, query: Query = {}, baseUrl = this.apiUrl): string {
    const url = new URL(/^https?:\/\//.test(path) ? path : `${baseUrl.replace(/\/+$/, '')}${path}`)
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    return url.toString()
  }

  async request<T = unknown>(
    path: string,
    options: GitHubRequestOptions = {}
  ): Promise<GitHubResponse<T>> {
    const method = options.method ?? 'GET'
    const url = this.url(path, options.query, options.baseUrl)
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${this.token}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'ci-sdk',
      ...options.headers
    }
    let body: string | Uint8Array | undefined
    if (options.body instanceof Uint8Array || typeof options.body === 'string') {
      body = options.body
    } else if (options.body !== undefined) {
      body = JSON.stringify(options.body)
      headers['content-type'] ??= 'application/json'
    }

    return retry(
      async () => {
        const res = await this.fetchImpl(url, { method, headers, body, signal: options.signal })
        const text = await res.text()
        if (!res.ok) throw new GitHubApiError(method, url, res.status, text, res.headers)
        const data = (text && isJson(res) ? JSON.parse(text) : text) as T
        return { status: res.status, data, headers: res.headers }
      },
      {
        attempts: this.attempts,
        minDelay: this.minDelay,
        signal: options.signal,
        retryIf: err => !(err instanceof GitHubApiError) || RETRYABLE.has(err.status)
      }
    ).catch((err: unknown) => {
      // Surface the API error itself, not the RetryError wrapper.
      throw err instanceof RetryError && err.cause ? err.cause : err
    })
  }

  /**
   * Follow `Link: rel="next"` and concatenate pages. `itemsKey` picks the array
   * from wrapped responses (`workflow_runs`, `artifacts`...); omit it for plain arrays.
   */
  async paginate<T>(
    path: string,
    query: Query = {},
    itemsKey?: string,
    options: Pick<GitHubRequestOptions, 'signal'> & { maxPages?: number } = {}
  ): Promise<T[]> {
    const items: T[] = []
    let next: string | undefined = this.url(path, { per_page: 100, ...query })
    for (let page = 0; next && page < (options.maxPages ?? 100); page++) {
      const res: GitHubResponse<unknown> = await this.request(next, { signal: options.signal })
      const data = res.data as Record<string, unknown> | unknown[]
      const pageItems = itemsKey ? (data as Record<string, unknown>)[itemsKey] : data
      if (!Array.isArray(pageItems)) {
        throw new CiError(
          'E_GITHUB_API',
          `Expected an array${itemsKey ? ` in "${itemsKey}"` : ''} from ${next}`
        )
      }
      items.push(...(pageItems as T[]))
      next = nextLink(res.headers.get('link'))
    }
    return items
  }
}

function isJson(res: Response): boolean {
  return /\bjson\b/i.test(res.headers.get('content-type') ?? '')
}

/** `<https://api.github.com/...&page=2>; rel="next", <...>; rel="last"` -> next URL. */
export function nextLink(link: string | null): string | undefined {
  if (!link) return undefined
  for (const part of link.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part)
    if (match) return match[1]
  }
  return undefined
}
