import { createReadStream } from 'node:fs'
import { sign } from 'node:crypto'
import { Readable } from 'node:stream'
import { CiError } from '../../sdk/src/index.js'

export const TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const UPLOAD_URL =
  'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id,name,webViewLink'
const SCOPE = 'https://www.googleapis.com/auth/drive'

export type Fetch = typeof fetch

export interface ServiceAccountKey {
  clientEmail: string
  privateKey: string
}

export interface UploadedFile {
  id: string
  name: string
  link: string
}

/** A Drive or token error; `permanent` ones are not worth retrying. */
export class DriveError extends CiError {
  constructor(
    message: string,
    readonly permanent: boolean
  ) {
    super('E_DRIVE', message)
    this.name = 'DriveError'
  }
}

export function parseServiceAccountKey(raw: string): ServiceAccountKey {
  let key: unknown
  try {
    key = JSON.parse(raw)
  } catch {
    throw new DriveError('service-account-key is not valid JSON', true)
  }
  const record = (typeof key === 'object' && key !== null ? key : {}) as Record<string, unknown>
  const clientEmail = record['client_email']
  const privateKey = record['private_key']
  if (
    typeof clientEmail !== 'string' ||
    typeof privateKey !== 'string' ||
    !clientEmail ||
    !privateKey
  ) {
    throw new DriveError('service-account-key has no client_email or private_key', true)
  }
  return { clientEmail, privateKey }
}

const b64 = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url')

/** OAuth 2.0 JWT bearer assertion, signed with the service account key (RS256). */
export function signAssertion(key: ServiceAccountKey, nowSeconds: number): string {
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: key.clientEmail,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: nowSeconds,
    exp: nowSeconds + 3600
  })}`
  const signature = sign('RSA-SHA256', Buffer.from(unsigned), key.privateKey).toString('base64url')
  return `${unsigned}.${signature}`
}

/**
 * Mint an access token from the key itself: no credentials file on the runner and no IAM
 * role (generateAccessToken would need Token Creator on the service account).
 */
export async function getAccessToken(
  key: ServiceAccountKey,
  fetchImpl: Fetch = fetch,
  nowSeconds = Math.floor(Date.now() / 1000)
): Promise<string> {
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: signAssertion(key, nowSeconds)
    })
  })
  if (!res.ok) {
    throw new DriveError(
      `Google token request failed for ${key.clientEmail}: ${res.status} ${await res.text()}`,
      res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429
    )
  }
  const body = (await res.json()) as { access_token?: unknown }
  if (typeof body.access_token !== 'string' || !body.access_token) {
    throw new DriveError('Google token response has no access_token', true)
  }
  return body.access_token
}

const QUOTA_HINT =
  ' The folder must be inside a Shared Drive the service account is a member of (Content manager), not a My Drive folder shared with it: a service account has no storage of its own.'

function failure(step: string, status: number, body: string): DriveError {
  const quota = body.includes('storageQuotaExceeded')
  // 429 and 5xx are transient; other 4xx (bad folder, auth, quota) will fail again.
  // Drive also rate limits with 403 (rateLimitExceeded, userRateLimitExceeded): retry those.
  const rateLimited = /ratelimitexceeded/i.test(body)
  const permanent =
    quota || (!rateLimited && status >= 400 && status < 500 && status !== 408 && status !== 429)
  return new DriveError(
    `Drive ${step} failed: ${status} ${body}${quota ? QUOTA_HINT : ''}`,
    permanent
  )
}

export interface UploadOptions {
  token: string
  folderId: string
  file: string
  name: string
  size: number
  mimeType: string
  fetchImpl?: Fetch
}

/** Resumable upload into a Shared Drive folder, streamed from disk (never held in memory). */
export async function uploadFile(options: UploadOptions): Promise<UploadedFile> {
  const { token, folderId, file, name, size, mimeType } = options
  const fetchImpl = options.fetchImpl ?? fetch
  const init = await fetchImpl(UPLOAD_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': mimeType,
      'X-Upload-Content-Length': String(size)
    },
    body: JSON.stringify({ name, parents: [folderId], mimeType })
  })
  if (!init.ok) throw failure('upload init', init.status, await init.text())
  const location = init.headers.get('location')
  if (!location) throw new DriveError('Drive upload init answered no session location', false)

  const put = await fetchImpl(location, {
    method: 'PUT',
    headers: { 'Content-Length': String(size), 'Content-Type': mimeType },
    body: Readable.toWeb(createReadStream(file)) as ReadableStream,
    duplex: 'half'
  })
  if (!put.ok) throw failure('upload', put.status, await put.text())
  // The file is stored once the PUT answers 2xx: anything odd from here on must not retry
  // (a new session would upload a second copy).
  let body: { id?: string; name?: string; webViewLink?: string }
  try {
    body = (await put.json()) as typeof body
  } catch {
    throw new DriveError(`Drive answered ${put.status} with a body that is not JSON`, true)
  }
  if (!body?.id || !body.webViewLink) {
    throw new DriveError(`Drive answered no file id or link: ${JSON.stringify(body)}`, true)
  }
  return { id: body.id, name: body.name ?? name, link: body.webViewLink }
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
