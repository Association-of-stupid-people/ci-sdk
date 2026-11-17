import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DashClient,
  DashError,
  ensureFolder,
  fileLink,
  folderSegments,
  mimeTypeFor,
  type Fetch
} from '../src/dash.js'
import { run } from '../src/main.js'

const MCP = 'https://dash.example/mcp'
const SESSION = 'https://upload.example/session/1'

interface Call {
  url: string
  init: RequestInit
  tool?: string
  path?: string
  args?: Record<string, unknown>
  body: string
}

type Handler = (call: Call) => Response | undefined

/** The MCP answer of a tool call whose text is `value` (JSON unless a string). */
const toolResult = (value: unknown, sse = false): Response => {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  const rpc = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    result: { content: [{ type: 'text', text }] }
  })
  return sse
    ? new Response(`event: message\ndata: ${rpc}\n\n`, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      })
    : new Response(rpc, { status: 200, headers: { 'content-type': 'application/json' } })
}

interface FakeDash {
  fetch: Fetch
  calls: Call[]
  folders: { id: string; ten: string; cha: string | null; at: string }[]
}

/**
 * An in-memory dash: folders, upload sessions and files. `override` answers a call first (return
 * undefined to fall through), to inject failures.
 */
function fakeDash(override?: Handler): FakeDash {
  const calls: Call[] = []
  const folders: FakeDash['folders'] = []
  let n = 0
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const raw = init.body
    let body = ''
    if (raw instanceof ReadableStream) body = await new Response(raw).text()
    else if (typeof raw === 'string') body = raw
    const call: Call = { url, init, body }
    if (url === MCP) {
      const rpc = JSON.parse(body) as {
        params: { name: string; arguments: { path: string; query?: object; body?: object } }
      }
      call.tool = rpc.params.name
      call.path = rpc.params.arguments.path
      call.args = (rpc.params.arguments.body ?? rpc.params.arguments.query ?? {}) as Record<
        string,
        unknown
      >
    }
    calls.push(call)
    const injected = override?.(call)
    if (injected) return injected
    if (url === SESSION) return new Response('{"id":"g1"}', { status: 200 })
    const a = call.args ?? {}
    switch (call.path) {
      case '/api/files-ds':
        return toolResult({ files: [], thuMuc: folders })
      case '/api/files-thu-muc-tao': {
        const id = `d${++n}`
        folders.push({
          id,
          ten: String(a['ten']),
          cha: (a['cha'] as string) ?? null,
          at: `2026-11-17T00:00:0${n}Z`
        })
        return toolResult({ id })
      }
      case '/api/files-tai-len-mo':
        return toolResult({ id: `u${++n}`, url: SESSION })
      case '/api/files-tai-len-xong':
        return toolResult({ id: 'f1' })
      case '/api/files-tai-len-huy':
        return toolResult({ ok: true })
    }
    throw new Error(`unexpected call ${url} ${call.path ?? ''}`)
  }) as unknown as Fetch
  return { fetch: fetchImpl, calls, folders }
}

describe('helpers', () => {
  it('splits folder paths', () => {
    expect(folderSegments(' CI Builds / My-Game//debug/ ')).toEqual([
      'CI Builds',
      'My-Game',
      'debug'
    ])
    expect(folderSegments('')).toEqual([])
  })
  it('fills the link template', () => {
    expect(fileLink('https://d/x?id={id}&again={id}', 'a b')).toBe(
      'https://d/x?id=a%20b&again=a%20b'
    )
  })
  it('picks MIME types', () => {
    expect(mimeTypeFor('Game.APK')).toBe('application/vnd.android.package-archive')
    expect(mimeTypeFor('unity.log')).toBe('text/plain')
    expect(mimeTypeFor('x.bin')).toBe('application/octet-stream')
  })
})

describe('DashClient', () => {
  it('skips SSE notifications before the result', async () => {
    const rpc = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: '{"ok":2}' }] }
    })
    const stream = `event: message
data: {"jsonrpc":"2.0","method":"notifications/progress"}

event: message
data: ${rpc}

`
    const { fetch } = fakeDash(
      () => new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    )
    expect(await new DashClient(MCP, 'k', fetch).read('/api/x', {})).toEqual({ ok: 2 })
  })

  it('sends the key and a tools/call, and reads an SSE answer', async () => {
    const { fetch, calls } = fakeDash(() => toolResult({ ok: 1 }, true))
    const dash = new DashClient(MCP, 'bgm_key', fetch)
    expect(await dash.read('/api/files-ds', { khu: 'ws:1' })).toEqual({ ok: 1 })
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer bgm_key')
    expect(JSON.parse(calls[0]!.body)).toMatchObject({
      method: 'tools/call',
      params: { name: 'dash_doc', arguments: { path: '/api/files-ds', query: { khu: 'ws:1' } } }
    })
  })

  it.each([
    ['a tool error', toolResult({ error: 'KHU_SAI' }), /KHU_SAI/, true],
    ['an unknown tool error', toolResult({ error: 'DRIVE_BAN' }), /DRIVE_BAN/, false],
    ['a missing-parameter error', toolResult({ error: 'THIEU_THU_MUC' }), /THIEU/, true],
    ['an error object', toolResult({ error: { code: 'KHU_SAI' } }), /KHU_SAI/, true],
    ['a null body', new Response('null', { status: 200 }), /no JSON-RPC message/, false],
    ['a plain text refusal', toolResult('Tham số chưa được đo'), /Tham số/, true],
    ['a 401', new Response('no', { status: 401 }), /401/, true],
    ['a 503', new Response('busy', { status: 503 }), /503/, false],
    ['a firewall page', new Response('<html>Ray ID: 1</html>', { status: 403 }), /firewall/, true],
    ['a JSON-RPC error', new Response('{"error":{"message":"bad"}}', { status: 200 }), /bad/, true]
  ])('throws on %s', async (_label, answer, message, permanent) => {
    const { fetch } = fakeDash(() => answer)
    const err = await new DashClient(MCP, 'k', fetch).write('/api/x', {}).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DashError)
    expect((err as DashError).message).toMatch(message)
    expect((err as DashError).permanent).toBe(permanent)
  })
})

describe('ensureFolder', () => {
  it('creates the missing folders and reuses the existing ones', async () => {
    const fake = fakeDash()
    fake.folders.push({ id: 'old', ten: 'CI Builds', cha: null, at: '2026-01-01T00:00:00Z' })
    const dash = new DashClient(MCP, 'k', fake.fetch)
    expect(await ensureFolder(dash, 'ws:19', ['CI Builds', 'My-Game'])).toBe('d1')
    expect(fake.folders.find(f => f.id === 'd1')).toMatchObject({ ten: 'My-Game', cha: 'old' })
    // Second time: nothing to create.
    const before = fake.calls.length
    expect(await ensureFolder(dash, 'ws:19', ['CI Builds', 'My-Game'])).toBe('d1')
    expect(fake.calls.slice(before).map(c => c.path)).toEqual(['/api/files-ds'])
  })

  it('uses the oldest of two folders made at once', async () => {
    const fake = fakeDash()
    fake.folders.push(
      { id: 'late', ten: 'A', cha: null, at: '2026-01-02T00:00:00Z' },
      { id: 'early', ten: 'A', cha: null, at: '2026-01-01T00:00:00Z' }
    )
    expect(await ensureFolder(new DashClient(MCP, 'k', fake.fetch), 'ws:1', ['A'])).toBe('early')
  })

  it('is the area root without segments', async () => {
    const fake = fakeDash()
    expect(await ensureFolder(new DashClient(MCP, 'k', fake.fetch), 'ws:1', [])).toBeUndefined()
    expect(fake.calls).toHaveLength(0)
  })
})

describe('run', () => {
  let dir: string
  let outputFile: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'dash-run-'))
    outputFile = path.join(dir, 'output')
    await writeFile(outputFile, '')
    await writeFile(path.join(dir, 'summary'), '')
    await writeFile(path.join(dir, 'check.apk'), 'APK')
    vi.stubEnv('GITHUB_OUTPUT', outputFile)
    vi.stubEnv('GITHUB_STEP_SUMMARY', path.join(dir, 'summary'))
    vi.stubEnv('INPUT_KEY', 'bgm_key')
    vi.stubEnv('INPUT_AREA', 'ws:19')
    vi.stubEnv('INPUT_FOLDER', 'CI Builds/My-Game')
    vi.stubEnv('INPUT_FILE', path.join(dir, 'check.apk'))
    vi.stubEnv('INPUT_NAME', 'game_debug.apk')
    vi.stubEnv('INPUT_MIME-TYPE', '')
    vi.stubEnv('INPUT_LINK-TEMPLATE', 'https://dash.example/f?id={id}')
    vi.stubEnv('INPUT_URL', MCP)
    vi.stubEnv('INPUT_ATTEMPTS', '3')
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  })
  afterEach(async () => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    await rm(dir, { recursive: true, force: true })
  })

  async function outputs(): Promise<Record<string, string>> {
    const out: Record<string, string> = {}
    const raw = (await readFile(outputFile, 'utf8')).split(/\r?\n/).join('\n')
    for (const m of raw.matchAll(/^(.+)<<(ghadelimiter_[\w-]+)\n([\s\S]*?)\n\2$/gm)) {
      out[m[1]!] = m[3]!
    }
    return out
  }

  it('uploads into the folder and sets the outputs', async () => {
    const fake = fakeDash()
    await run(fake.fetch, 1)
    const open = fake.calls.find(c => c.path === '/api/files-tai-len-mo')!
    expect(open.args).toEqual({ ten: 'game_debug.apk', co: 3, khu: 'ws:19', thuMuc: 'd2' })
    const put = fake.calls.find(c => c.url === SESSION)!
    expect(put.init.method).toBe('PUT')
    expect(put.body).toBe('APK')
    expect(fake.calls.find(c => c.path === '/api/files-tai-len-xong')!.args).toEqual({
      id: 'u3',
      thuMuc: 'd2'
    })
    expect(await outputs()).toEqual({
      id: 'f1',
      link: 'https://dash.example/f?id=f1',
      name: 'game_debug.apk',
      size: '3',
      'folder-id': 'd2'
    })
    expect(await readFile(path.join(dir, 'summary'), 'utf8')).toContain('Uploaded to dash')
  })

  it('retries a failed PUT with a new session and drops the old one', async () => {
    let puts = 0
    const fake = fakeDash(call =>
      call.url === SESSION && ++puts === 1 ? new Response('down', { status: 503 }) : undefined
    )
    vi.stubEnv('INPUT_FOLDER', '')
    await run(fake.fetch, 1)
    const paths = fake.calls.map(c => c.path ?? 'PUT')
    expect(paths).toEqual([
      '/api/files-tai-len-mo',
      'PUT',
      '/api/files-tai-len-huy',
      '/api/files-tai-len-mo',
      'PUT',
      '/api/files-tai-len-xong'
    ])
    expect((await outputs())['folder-id']).toBe('')
  })

  it('retries the finish without uploading again', async () => {
    let finishes = 0
    const fake = fakeDash(call =>
      call.path === '/api/files-tai-len-xong' && ++finishes === 1
        ? new Response('busy', { status: 502 })
        : undefined
    )
    await run(fake.fetch, 1)
    expect(fake.calls.filter(c => c.url === SESSION)).toHaveLength(1)
    expect(finishes).toBe(2)
  })

  it('stops at a permanent dash error', async () => {
    const fake = fakeDash(call =>
      call.path === '/api/files-tai-len-mo' ? toolResult({ error: 'CAN_KHU' }) : undefined
    )
    await expect(run(fake.fetch, 1)).rejects.toThrow(/CAN_KHU/)
    expect(fake.calls.filter(c => c.path === '/api/files-tai-len-mo')).toHaveLength(1)
  })

  it('refuses a malformed area and a missing file', async () => {
    vi.stubEnv('INPUT_AREA', '19')
    await expect(run(fakeDash().fetch, 1)).rejects.toThrow(/area must look like/)
    vi.stubEnv('INPUT_AREA', 'ws:19')
    vi.stubEnv('INPUT_FILE', path.join(dir, 'nope.apk'))
    await expect(run(fakeDash().fetch, 1)).rejects.toThrow(/cannot be read/)
  })
})
