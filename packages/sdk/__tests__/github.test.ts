import { describe, expect, it, vi } from 'vitest'
import { GitHubApiError, GitHubClient, nextLink } from '../src/index.js'

vi.mock('@actions/core', async importOriginal => ({
  ...(await importOriginal<typeof import('@actions/core')>()),
  setSecret: vi.fn()
}))

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> }

/** fetch stub answering each call with the next reply; records the requests. */
function stubFetch(...replies: Reply[]): {
  fetch: typeof fetch
  calls: { url: string; init: RequestInit }[]
} {
  const calls: { url: string; init: RequestInit }[] = []
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} })
    const reply = replies.shift() ?? { status: 500, body: 'no more replies' }
    const isText = typeof reply.body === 'string'
    const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? null)
    return new Response(text, {
      status: reply.status ?? 200,
      headers: {
        'content-type': isText ? 'text/plain' : 'application/json; charset=utf-8',
        ...reply.headers
      }
    })
  })
  return { fetch: impl as unknown as typeof fetch, calls }
}

const client = (f: typeof fetch, attempts = 3): GitHubClient =>
  new GitHubClient({ token: 't0ken', apiUrl: 'https://api.test/', fetch: f, attempts, minDelay: 1 })

describe('GitHubClient', () => {
  it('requires a token', () => {
    expect(() => new GitHubClient({ token: '' })).toThrow(/token is required/)
  })

  it('sends auth headers, query and a JSON body', async () => {
    const { fetch, calls } = stubFetch({ body: { id: 7 } })
    const res = await client(fetch).request<{ id: number }>('/repos/o/r/things', {
      method: 'POST',
      query: { a: 1, skip: undefined },
      body: { name: 'x' }
    })
    expect(res.data.id).toBe(7)
    const [call] = calls
    expect(call?.url).toBe('https://api.test/repos/o/r/things?a=1')
    const headers = call?.init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer t0ken')
    expect(headers['content-type']).toBe('application/json')
    expect(call?.init.body).toBe('{"name":"x"}')
  })

  it('sends binary bodies as-is to an absolute URL', async () => {
    const { fetch, calls } = stubFetch({ status: 201, body: { ok: true } })
    const bytes = new Uint8Array([1, 2, 3])
    await client(fetch).request('https://uploads.test/assets', {
      method: 'POST',
      query: { name: 'a b.zip' },
      body: bytes,
      headers: { 'content-type': 'application/octet-stream' }
    })
    expect(calls[0]?.url).toBe('https://uploads.test/assets?name=a+b.zip')
    expect(calls[0]?.init.body).toBe(bytes)
  })

  it('retries 5xx and returns the later success', async () => {
    const { fetch, calls } = stubFetch({ status: 502, body: 'bad gateway' }, { body: [1] })
    const res = await client(fetch).request<number[]>('/x')
    expect(res.data).toEqual([1])
    expect(calls).toHaveLength(2)
  })

  it('does not retry 404 and throws GitHubApiError with the status', async () => {
    const { fetch, calls } = stubFetch({
      status: 404,
      body: { message: 'Not Found' },
      headers: { 'x-ratelimit-remaining': '42' }
    })
    const err = await client(fetch)
      .request('/missing')
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GitHubApiError)
    expect((err as GitHubApiError).status).toBe(404)
    expect((err as GitHubApiError).headers.get('x-ratelimit-remaining')).toBe('42')
    expect(calls).toHaveLength(1)
  })

  it('throws the last API error, not a retry wrapper, when retries run out', async () => {
    const { fetch } = stubFetch({ status: 503 }, { status: 503, body: 'down' })
    const err = await client(fetch, 2)
      .request('/x')
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GitHubApiError)
    expect((err as GitHubApiError).status).toBe(503)
  })

  it('paginates through Link headers and unwraps itemsKey', async () => {
    const { fetch, calls } = stubFetch(
      {
        body: { total_count: 3, workflow_runs: [{ id: 1 }, { id: 2 }] },
        headers: { link: '<https://api.test/runs?page=2>; rel="next", <x>; rel="last"' }
      },
      { body: { total_count: 3, workflow_runs: [{ id: 3 }] } }
    )
    const runs = await client(fetch).paginate<{ id: number }>(
      '/runs',
      { head_sha: 'abc' },
      'workflow_runs'
    )
    expect(runs.map(r => r.id)).toEqual([1, 2, 3])
    expect(calls[0]?.url).toBe('https://api.test/runs?per_page=100&head_sha=abc')
    expect(calls[1]?.url).toBe('https://api.test/runs?page=2')
  })

  it('rejects a page that is not an array', async () => {
    const { fetch } = stubFetch({ body: { nope: 1 } })
    await expect(client(fetch).paginate('/x', {}, 'items')).rejects.toThrow(/Expected an array/)
  })
})

describe('nextLink', () => {
  it('finds rel=next or returns undefined', () => {
    expect(nextLink('<a>; rel="prev", <b>; rel="next"')).toBe('b')
    expect(nextLink('<a>; rel="last"')).toBeUndefined()
    expect(nextLink(null)).toBeUndefined()
  })
})
