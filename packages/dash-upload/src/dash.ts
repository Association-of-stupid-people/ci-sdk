import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import { CiError } from '../../sdk/src/index.js'

export type Fetch = typeof fetch

/** A dash or upload error; `permanent` ones are not worth retrying. */
export class DashError extends CiError {
  constructor(
    message: string,
    readonly permanent: boolean
  ) {
    super('E_DASH', message)
    this.name = 'DashError'
  }
}

/** 429, 408 and 5xx are transient; any other 4xx (bad key, bad area, firewall) fails again. */
const permanentStatus = (status: number): boolean =>
  status >= 400 && status < 500 && status !== 408 && status !== 429

/** Body text for an error message: short, one line (a firewall page is a whole HTML document). */
function snippet(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim()
  return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat
}

/**
 * The JSON-RPC answer of an MCP call: plain JSON, or, in an SSE stream, the event that holds a
 * `result` or an `error` (a server may stream notifications before it). An event's `data:` lines
 * join with newlines.
 */
function parseRpc(contentType: string, body: string): unknown {
  if (!contentType.includes('text/event-stream')) {
    try {
      return JSON.parse(body)
    } catch {
      throw new DashError(`dash MCP answered a body that is not JSON: ${snippet(body)}`, false)
    }
  }
  for (const event of body.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).replace(/^ /, ''))
      .join('\n')
    if (!data) continue
    try {
      const message = JSON.parse(data) as Record<string, unknown> | null
      if (message && ('result' in message || 'error' in message)) return message
    } catch {
      // Not a JSON-RPC message: skip it.
    }
  }
  throw new DashError(`dash MCP answered an event stream with no result`, false)
}

/**
 * A tool error that the same call will hit again (a bad or missing parameter, no right to the
 * area): codes such as KHU_SAI, TEN_TRONG, CAN_KHU, THIEU_THU_MUC. Other codes may be transient.
 */
export const permanentToolError = (code: string): boolean =>
  /(^|_)(SAI|TRONG|CAN|THIEU|QUYEN|KHONG)(_|$)/.test(code) || /forbidden|denied|invalid/i.test(code)

/** A client of the dash MCP tools (dash_doc reads, dash_ghi writes), one stateless JSON-RPC call each. */
export class DashClient {
  private nextId = 1

  constructor(
    private readonly url: string,
    private readonly key: string,
    private readonly fetchImpl: Fetch = fetch
  ) {}

  /** Calls one tool and returns its result, parsed as JSON. A tool-level `{error}` throws. */
  async tool(name: 'dash_doc' | 'dash_ghi', args: Record<string, unknown>): Promise<unknown> {
    const what = `${name} ${String(args['path'])}`
    const res = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.key}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: this.nextId++,
        method: 'tools/call',
        params: { name, arguments: args }
      })
    })
    const body = await res.text()
    if (!res.ok) {
      const firewall = /ray id/i.test(body) ? ' (the dash firewall refused this runner)' : ''
      throw new DashError(
        `dash ${what} failed: ${res.status}${firewall} ${snippet(body)}`,
        permanentStatus(res.status)
      )
    }
    const parsed = parseRpc(res.headers.get('content-type') ?? '', body)
    if (typeof parsed !== 'object' || parsed === null) {
      throw new DashError(`dash ${what} answered no JSON-RPC message: ${snippet(body)}`, false)
    }
    const rpc = parsed as {
      result?: { content?: { type?: string; text?: string }[]; isError?: boolean }
      error?: { message?: string }
    }
    if (rpc.error) {
      throw new DashError(
        `dash ${what} failed: ${rpc.error.message ?? JSON.stringify(rpc.error)}`,
        true
      )
    }
    const text = (rpc.result?.content ?? []).map(c => c.text ?? '').join('')
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      // The tool explains a refused call in plain text (an unknown parameter, a closed route).
      throw new DashError(`dash ${what} failed: ${snippet(text)}`, true)
    }
    const error = (value as { error?: unknown } | null)?.error
    if (rpc.result?.isError || error !== undefined) {
      // `{error: "KHU_SAI"}`, or an object such as `{error: {code, message}}`.
      const detail = error as { code?: unknown; message?: unknown } | null | undefined
      const code =
        typeof error === 'string'
          ? error
          : typeof detail?.code === 'string'
            ? detail.code
            : typeof detail?.message === 'string'
              ? detail.message
              : snippet(text)
      throw new DashError(`dash ${what} failed: ${code}`, permanentToolError(code))
    }
    return value
  }

  async read(path: string, query: Record<string, unknown>): Promise<unknown> {
    return this.tool('dash_doc', { path, query })
  }

  async write(path: string, body: Record<string, unknown>): Promise<unknown> {
    return this.tool('dash_ghi', { method: 'POST', path, body })
  }
}

function idOf(value: unknown, what: string): string {
  const id = (value as { id?: unknown } | null)?.id
  if (typeof id !== 'string' || !id) {
    throw new DashError(`dash ${what} answered no id: ${snippet(JSON.stringify(value))}`, true)
  }
  return id
}

interface Folder {
  id: string
  ten: string
  cha: string | null
  at?: string
}

/** Splits "a/b//c " into ["a", "b", "c"]. */
export function folderSegments(folder: string): string[] {
  return folder
    .split('/')
    .map(s => s.trim())
    .filter(Boolean)
}

/**
 * The id of the folder path in the area, creating the missing folders. Two runs that create the
 * same folder at once each make one: the oldest is the one used from then on, the other stays empty.
 */
export async function ensureFolder(
  dash: DashClient,
  area: string,
  segments: string[]
): Promise<string | undefined> {
  if (!segments.length) return undefined
  const list = async (): Promise<Folder[]> => {
    const value = (await dash.read('/api/files-ds', { khu: area })) as { thuMuc?: Folder[] }
    return Array.isArray(value?.thuMuc) ? value.thuMuc : []
  }
  const pick = (folders: Folder[], ten: string, cha: string | null): Folder | undefined =>
    folders
      .filter(f => f.ten === ten && (f.cha ?? null) === cha)
      .sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''))[0]

  let folders = await list()
  let parent: string | null = null
  for (const ten of segments) {
    let found = pick(folders, ten, parent)
    if (!found) {
      const body: Record<string, unknown> = { ten, khu: area }
      if (parent) body['cha'] = parent
      const created = idOf(await dash.write('/api/files-thu-muc-tao', body), 'folder create')
      folders = await list()
      found = pick(folders, ten, parent) ?? { id: created, ten, cha: parent }
    }
    parent = found.id
  }
  return parent ?? undefined
}

export interface UploadOptions {
  dash: DashClient
  area: string
  folderId?: string
  file: string
  name: string
  size: number
  mimeType: string
  fetchImpl?: Fetch
}

/** A dash upload session: the dash id and the Google resumable upload URL it opened. */
export interface UploadSession {
  id: string
  url: string
}

export async function openUpload(options: UploadOptions): Promise<UploadSession> {
  const body: Record<string, unknown> = { ten: options.name, co: options.size, khu: options.area }
  if (options.folderId) body['thuMuc'] = options.folderId
  const value = (await options.dash.write('/api/files-tai-len-mo', body)) as { url?: unknown }
  const id = idOf(value, 'upload open')
  if (typeof value.url !== 'string' || !/^https:\/\//.test(value.url)) {
    throw new DashError('dash upload open answered no upload URL', true)
  }
  return { id, url: value.url }
}

/** Streams the file to the session URL (never held in memory). */
export async function putBytes(options: UploadOptions, session: UploadSession): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch
  const put = await fetchImpl(session.url, {
    method: 'PUT',
    headers: { 'Content-Length': String(options.size), 'Content-Type': options.mimeType },
    body: Readable.toWeb(createReadStream(options.file)) as ReadableStream,
    duplex: 'half'
  })
  if (!put.ok) {
    const body = await put.text()
    throw new DashError(
      `upload of the bytes failed: ${put.status} ${snippet(body)}`,
      permanentStatus(put.status) && !/ratelimitexceeded/i.test(body)
    )
  }
  // Drain the answer (Google's file metadata) so the connection is released.
  await put.arrayBuffer().catch(() => undefined)
}

/** Tells dash the bytes are there; it then lists the file. Returns the dash file id. */
export async function finishUpload(
  options: UploadOptions,
  session: UploadSession
): Promise<string> {
  const body: Record<string, unknown> = { id: session.id }
  if (options.folderId) body['thuMuc'] = options.folderId
  return idOf(await options.dash.write('/api/files-tai-len-xong', body), 'upload finish')
}

/** Drops a session whose bytes never arrived; best effort. */
export async function cancelUpload(dash: DashClient, session: UploadSession): Promise<void> {
  try {
    await dash.write('/api/files-tai-len-huy', { id: session.id })
  } catch {
    // An open session that is never finished holds no file.
  }
}

export function fileLink(template: string, id: string): string {
  return template.split('{id}').join(encodeURIComponent(id))
}

const MIME: Record<string, string> = {
  '.apk': 'application/vnd.android.package-archive',
  '.aab': 'application/octet-stream',
  '.ipa': 'application/octet-stream',
  '.zip': 'application/zip',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.log': 'text/plain'
}

export function mimeTypeFor(fileName: string): string {
  const ext = /\.[^.]+$/.exec(fileName.toLowerCase())?.[0] ?? ''
  return MIME[ext] ?? 'application/octet-stream'
}
