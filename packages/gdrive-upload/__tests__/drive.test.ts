import { generateKeyPairSync, verify } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DriveError,
  TOKEN_URL,
  UPLOAD_URL,
  getAccessToken,
  mimeTypeFor,
  parseServiceAccountKey,
  signAssertion,
  uploadFile,
  type Fetch
} from '../src/drive.js'
import { run } from '../src/main.js'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const KEY_JSON = JSON.stringify({ client_email: 'ci@p.iam.gserviceaccount.com', private_key: PEM })
const SESSION = 'https://upload.example/session/1'

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers })
const text = (status: number, body: string): Response => new Response(body, { status })

interface Call {
  url: string
  init: RequestInit
  body: string
}

/** A fetch that answers from `script` in order and records every call (bodies read fully). */
function fakeFetch(script: Response[]): { fetch: Fetch; calls: Call[] } {
  const calls: Call[] = []
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const raw = init.body
    let body = ''
    if (raw instanceof ReadableStream) body = await new Response(raw).text()
    else if (typeof raw === 'string') body = raw
    else if (raw instanceof URLSearchParams) body = raw.toString()
    calls.push({ url, init, body })
    const next = script.shift()
    if (!next) throw new Error(`unexpected call ${url}`)
    return next
  }) as unknown as Fetch
  return { fetch: fetchImpl, calls }
}

describe('service account key', () => {
  it('reads client_email and private_key', () => {
    expect(parseServiceAccountKey(KEY_JSON)).toEqual({
      clientEmail: 'ci@p.iam.gserviceaccount.com',
      privateKey: PEM
    })
  })
  it.each([
    ['not JSON', '{', /not valid JSON/],
    ['no email', JSON.stringify({ private_key: PEM }), /no client_email or private_key/],
    ['null', 'null', /no client_email or private_key/]
  ])('rejects %s', (_name, raw, message) => {
    expect(() => parseServiceAccountKey(raw)).toThrow(message)
  })

  it('signs an RS256 assertion for the Drive scope', () => {
    const assertion = signAssertion(parseServiceAccountKey(KEY_JSON), 1000)
    const [header, claims, signature] = assertion.split('.')
    expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT'
    })
    expect(JSON.parse(Buffer.from(claims!, 'base64url').toString())).toEqual({
      iss: 'ci@p.iam.gserviceaccount.com',
      scope: 'https://www.googleapis.com/auth/drive',
      aud: TOKEN_URL,
      iat: 1000,
      exp: 4600
    })
    expect(
      verify(
        'RSA-SHA256',
        Buffer.from(`${header}.${claims}`),
        publicKey,
        Buffer.from(signature!, 'base64url')
      )
    ).toBe(true)
  })
})

describe('getAccessToken', () => {
  const key = parseServiceAccountKey(KEY_JSON)
  it('posts the JWT bearer grant', async () => {
    const { fetch, calls } = fakeFetch([json(200, { access_token: 'tok' })])
    expect(await getAccessToken(key, fetch, 1000)).toBe('tok')
    const form = new URLSearchParams(calls[0]!.body)
    expect(calls[0]!.url).toBe(TOKEN_URL)
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer')
    expect(form.get('assertion')).toBe(signAssertion(key, 1000))
  })
  it('fails permanently on a 4xx, transiently on a 5xx', async () => {
    const bad = getAccessToken(key, fakeFetch([text(400, 'invalid_grant')]).fetch)
    await expect(bad).rejects.toMatchObject({ permanent: true })
    await expect(getAccessToken(key, fakeFetch([text(503, 'down')]).fetch)).rejects.toMatchObject({
      permanent: false
    })
  })
  it('retries a token 429', async () => {
    await expect(
      getAccessToken(parseServiceAccountKey(KEY_JSON), fakeFetch([text(429, 'slow down')]).fetch)
    ).rejects.toMatchObject({ permanent: false })
  })
  it('fails without an access_token', async () => {
    await expect(getAccessToken(key, fakeFetch([json(200, {})]).fetch)).rejects.toThrow(
      /no access_token/
    )
  })
})

describe('uploadFile', () => {
  let dir: string
  let file: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'gdrive-'))
    file = path.join(dir, 'a.apk')
    await writeFile(file, 'APK-BYTES')
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  const options = (fetchImpl: Fetch): Parameters<typeof uploadFile>[0] => ({
    token: 'tok',
    folderId: 'folder1',
    file,
    name: 'game.apk',
    size: 9,
    mimeType: 'application/vnd.android.package-archive',
    fetchImpl
  })

  it('opens a resumable session in the folder and streams the file', async () => {
    const { fetch, calls } = fakeFetch([
      json(200, {}, { location: SESSION }),
      json(200, { id: 'f1', name: 'game.apk', webViewLink: 'https://drive/f1' })
    ])
    expect(await uploadFile(options(fetch))).toEqual({
      id: 'f1',
      name: 'game.apk',
      link: 'https://drive/f1'
    })
    expect(calls[0]!.url).toBe(UPLOAD_URL)
    expect(calls[0]!.init.headers).toMatchObject({
      Authorization: 'Bearer tok',
      'X-Upload-Content-Length': '9'
    })
    expect(JSON.parse(calls[0]!.body)).toEqual({
      name: 'game.apk',
      parents: ['folder1'],
      mimeType: 'application/vnd.android.package-archive'
    })
    expect(calls[1]!.url).toBe(SESSION)
    expect(calls[1]!.init.method).toBe('PUT')
    expect(calls[1]!.body).toBe('APK-BYTES')
  })

  it('explains the My Drive quota error and does not retry it', async () => {
    const body = '{"error":{"code":403,"errors":[{"reason":"storageQuotaExceeded"}]}}'
    const err = await uploadFile(options(fakeFetch([text(403, body)]).fetch)).catch(
      (e: unknown) => e
    )
    expect(err).toBeInstanceOf(DriveError)
    expect(err).toMatchObject({ permanent: true })
    expect((err as Error).message).toMatch(/inside a Shared Drive/)
  })

  it.each([
    [404, true],
    [429, false],
    [500, false]
  ])('marks an init %i as permanent=%s', async (status, permanent) => {
    await expect(uploadFile(options(fakeFetch([text(status, 'x')]).fetch))).rejects.toMatchObject({
      permanent
    })
  })

  it('retries a Drive rate limit, even as a 403', async () => {
    const body = '{"error":{"code":403,"errors":[{"reason":"userRateLimitExceeded"}]}}'
    await expect(uploadFile(options(fakeFetch([text(403, body)]).fetch))).rejects.toMatchObject({
      permanent: false
    })
  })

  it('fails without retry when Drive answers no id or link', async () => {
    const { fetch } = fakeFetch([json(200, {}, { location: SESSION }), json(200, { id: 'f1' })])
    await expect(uploadFile(options(fetch))).rejects.toMatchObject({ permanent: true })
  })

  it('does not retry a 2xx PUT answer that is not JSON', async () => {
    const { fetch } = fakeFetch([json(200, {}, { location: SESSION }), text(200, '<html>')])
    await expect(uploadFile(options(fetch))).rejects.toMatchObject({ permanent: true })
  })

  it('fails transiently when the PUT fails', async () => {
    const { fetch } = fakeFetch([json(200, {}, { location: SESSION }), text(502, 'bad gateway')])
    await expect(uploadFile(options(fetch))).rejects.toMatchObject({ permanent: false })
  })
})

describe('mimeTypeFor', () => {
  it.each([
    ['x.APK', 'application/vnd.android.package-archive'],
    ['x.zip', 'application/zip'],
    ['x.bin', 'application/octet-stream'],
    ['noext', 'application/octet-stream']
  ])('%s -> %s', (name, type) => {
    expect(mimeTypeFor(name)).toBe(type)
  })
})

describe('run', () => {
  let dir: string
  let outputFile: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'gdrive-run-'))
    outputFile = path.join(dir, 'output')
    await writeFile(outputFile, '')
    await writeFile(path.join(dir, 'summary'), '')
    await writeFile(path.join(dir, 'check.apk'), 'APK')
    vi.stubEnv('GITHUB_OUTPUT', outputFile)
    vi.stubEnv('GITHUB_STEP_SUMMARY', path.join(dir, 'summary'))
    vi.stubEnv('INPUT_SERVICE-ACCOUNT-KEY', KEY_JSON)
    vi.stubEnv('INPUT_FOLDER-ID', 'folder1')
    vi.stubEnv('INPUT_FILE', path.join(dir, 'check.apk'))
    vi.stubEnv('INPUT_NAME', 'game_debug.apk')
    vi.stubEnv('INPUT_MIME-TYPE', '')
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

  it('uploads, retrying a transient failure, and sets the outputs', async () => {
    const { fetch, calls } = fakeFetch([
      json(200, { access_token: 'tok' }),
      text(500, 'oops'),
      json(200, {}, { location: SESSION }),
      json(200, { id: 'f1', name: 'game_debug.apk', webViewLink: 'https://drive/f1' })
    ])
    await run(fetch, 1)
    expect(calls).toHaveLength(4)
    expect(await outputs()).toEqual({
      id: 'f1',
      link: 'https://drive/f1',
      name: 'game_debug.apk',
      size: '3'
    })
  })

  it('retries the token request and works without a job summary', async () => {
    vi.stubEnv('GITHUB_STEP_SUMMARY', '')
    const { fetch, calls } = fakeFetch([
      text(503, 'down'),
      json(200, { access_token: 'tok' }),
      json(200, {}, { location: SESSION }),
      json(200, { id: 'f1', name: 'game_debug.apk', webViewLink: 'https://drive/f1' })
    ])
    await run(fetch, 1)
    expect(calls).toHaveLength(4)
    expect((await outputs())['link']).toBe('https://drive/f1')
  })

  it('stops at a permanent error', async () => {
    const { fetch, calls } = fakeFetch([
      json(200, { access_token: 'tok' }),
      text(403, '{"reason":"storageQuotaExceeded"}')
    ])
    await expect(run(fetch, 1)).rejects.toThrow(/inside a Shared Drive/)
    expect(calls).toHaveLength(2)
  })

  it('fails on a missing file before calling Google', async () => {
    vi.stubEnv('INPUT_FILE', path.join(dir, 'nope.apk'))
    const { fetch, calls } = fakeFetch([])
    await expect(run(fetch, 1)).rejects.toThrow(/nope\.apk cannot be read/)
    expect(calls).toHaveLength(0)
  })
})
