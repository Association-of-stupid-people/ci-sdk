import * as core from '@actions/core'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@actions/core', async importOriginal => ({
  ...(await importOriginal<typeof import('@actions/core')>()),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  setOutput: vi.fn(),
  setFailed: vi.fn(),
  setSecret: vi.fn(),
  getInput: vi.fn()
}))

const { run } = await import('../src/main.js')
const { buildUploadUrl, checksumText, renderNotes, replaceNotesBlock, resolveFiles } =
  await import('../src/lib.js')

const sha = (s: string): string => createHash('sha256').update(s).digest('hex')
const START = '<!-- id:start -->'
const END = '<!-- id:end -->'

describe('replaceNotesBlock', () => {
  it('appends when there is no block', () => {
    expect(replaceNotesBlock('Notes', 'id', 'new')).toBe(`Notes\n\n${START}\nnew\n${END}\n`)
    expect(replaceNotesBlock('', 'id', 'new')).toBe(`${START}\nnew\n${END}\n`)
  })
  it('replaces one block and keeps the surrounding notes', () => {
    const body = `before\n${START}\nold\n${END}\nafter`
    expect(replaceNotesBlock(body, 'id', 'new')).toBe(`before\n${START}\nnew\n${END}\nafter`)
  })
  it('replaces two blocks with one', () => {
    const body = `a\n${START}\n1\n${END}\nb\n${START}\n2\n${END}\nc`
    const out = replaceNotesBlock(body, 'id', 'new')
    expect(out.split(START)).toHaveLength(2)
    expect(out).toBe(`a\n${START}\nnew\n${END}\nb\n\nc`)
  })
  it('treats a missing end marker as start..EOF', () => {
    expect(replaceNotesBlock(`keep\n${START}\nold\nstuff`, 'id', 'new')).toBe(
      `keep\n${START}\nnew\n${END}`
    )
  })
  it('is idempotent', () => {
    const once = replaceNotesBlock('x', 'id', 'new')
    expect(replaceNotesBlock(once, 'id', 'new')).toBe(once)
  })
})

describe('pure helpers', () => {
  it('formats checksums in sha256sum format, sorted by name', () => {
    expect(
      checksumText([
        { name: 'b.txt', sha256: 'bb' },
        { name: 'a.txt', sha256: 'aa' }
      ])
    ).toBe('aa  a.txt\nbb  b.txt\n')
  })
  it('substitutes {checksums} literally', () => {
    expect(renderNotes('```\n{checksums}\n```', 'a $& b\n')).toBe('```\na $& b\n```')
  })
  it('strips the upload_url template', () => {
    expect(buildUploadUrl('https://u.test/assets{?name,label}', 'a b.zip')).toBe(
      'https://u.test/assets?name=a%20b.zip'
    )
  })
})

describe('resolveFiles', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ra-files-'))
    mkdirSync(path.join(dir, 'out/sub'), { recursive: true })
    writeFileSync(path.join(dir, 'out/a.txt'), 'a')
    writeFileSync(path.join(dir, 'out/b.bin'), 'b')
    writeFileSync(path.join(dir, 'out/sub/a.txt'), 'dup')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('expands globs and directories (direct files only), without repeats', async () => {
    const files = await resolveFiles(['out', 'out/*.txt'], dir)
    expect(files.map(f => f.name).sort()).toEqual(['a.txt', 'b.bin'])
  })
  it('fails on duplicate basenames', async () => {
    await expect(resolveFiles(['out/**/*.txt'], dir)).rejects.toThrow(/Duplicate asset name/)
  })
})

interface FakeAsset {
  id: number
  name: string
  size: number
  browser_download_url: string
}

interface FakeState {
  body: string | null
  assets: FakeAsset[]
  uploads: string[]
  deletes: number[]
  calls: string[]
  failNextUploadWith422: boolean
  /** Runs after each successful upload (simulates a parallel job). */
  onUpload?: () => void
}

/** In-memory stand-in for the GitHub release API. */
function fakeGitHub(
  opts: { draft?: boolean; body?: string | null; assets?: string[] } = {}
): FakeState {
  let nextId = 100
  const state: FakeState = {
    body: opts.body ?? null,
    assets: (opts.assets ?? []).map(name => asset(name, 1)),
    uploads: [],
    deletes: [],
    calls: [],
    failNextUploadWith422: false
  }
  function asset(name: string, size: number): FakeAsset {
    return {
      id: nextId++,
      name,
      size,
      browser_download_url: `https://github.test/dl/${name}`
    }
  }
  const release = (): Record<string, unknown> => ({
    id: 7,
    tag_name: 'v1.0.0',
    html_url: 'https://github.test/o/r/releases/tag/v1.0.0',
    upload_url: 'https://uploads.test/repos/o/r/releases/7/assets{?name,label}',
    body: state.body
  })
  const json = (data: unknown, status = 200): Response =>
    new Response(JSON.stringify(data), {
      status,
      headers: { 'content-type': 'application/json' }
    })

  const fetchStub = vi.fn(async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const u = new URL(String(url))
    const method = init?.method ?? 'GET'
    state.calls.push(`${method} ${u.pathname}`)
    if (method === 'GET' && u.pathname === '/repos/o/r/releases/tags/v1.0.0') {
      return opts.draft ? json({ message: 'Not Found' }, 404) : json(release())
    }
    if (method === 'GET' && u.pathname === '/repos/o/r/releases') return json([release()])
    if (method === 'GET' && u.pathname === '/repos/o/r/releases/7/assets') {
      return json(state.assets)
    }
    if (method === 'GET' && u.pathname === '/repos/o/r/releases/7') return json(release())
    if (method === 'PATCH' && u.pathname === '/repos/o/r/releases/7') {
      state.body = (JSON.parse(init?.body as string) as { body: string }).body
      return json(release())
    }
    const del = /^\/repos\/o\/r\/releases\/assets\/(\d+)$/.exec(u.pathname)
    if (method === 'DELETE' && del) {
      const id = Number(del[1])
      state.deletes.push(id)
      state.assets = state.assets.filter(a => a.id !== id)
      return new Response(null, { status: 204 })
    }
    if (method === 'POST' && u.host === 'uploads.test') {
      const name = u.searchParams.get('name') as string
      const headers = init?.headers as Record<string, string>
      expect(headers['content-type']).toBe('application/octet-stream')
      const bytes = init?.body as Uint8Array
      const clash = state.assets.some(a => a.name === name)
      if (clash || state.failNextUploadWith422) {
        state.failNextUploadWith422 = false
        // Simulates "already exists": the earlier (lost) attempt did land.
        if (!clash) state.assets.push(asset(name, 0))
        return json({ message: 'Validation Failed' }, 422)
      }
      const created = asset(name, bytes.byteLength)
      state.assets.push(created)
      state.uploads.push(name)
      state.onUpload?.()
      return json(created, 201)
    }
    return json({ message: `unexpected ${method} ${u.pathname}` }, 500)
  })
  vi.stubGlobal('fetch', fetchStub)
  return state
}

describe('release-assets action', () => {
  let ws: string
  const output = (name: string): unknown =>
    vi.mocked(core.setOutput).mock.calls.find(([n]) => n === name)?.[1]
  const inputs = (values: Record<string, string>): void => {
    vi.mocked(core.getInput).mockImplementation(
      name => ({ token: 't0ken', tag: 'v1.0.0', checksums: 'SHA256SUMS', ...values })[name] ?? ''
    )
  }

  beforeEach(() => {
    ws = mkdtempSync(path.join(os.tmpdir(), 'ra-ws-'))
    writeFileSync(path.join(ws, 'b.txt'), 'bee')
    writeFileSync(path.join(ws, 'a.txt'), 'ay')
    vi.stubEnv('GITHUB_REPOSITORY', 'o/r')
    vi.stubEnv('GITHUB_WORKSPACE', ws)
    vi.stubEnv('GITHUB_API_URL', 'https://api.test')
    vi.stubEnv('RUNNER_TEMP', os.tmpdir())
    vi.mocked(core.setOutput).mockClear()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    rmSync(ws, { recursive: true, force: true })
  })

  it('uploads files and SHA256SUMS, writes notes, sets outputs', async () => {
    const gh = fakeGitHub({ body: 'Existing notes' })
    inputs({ files: '*.txt', notes: 'Sums:\n{checksums}' })
    await run()

    const sums = `${sha('ay')}  a.txt\n${sha('bee')}  b.txt\n`
    expect(gh.uploads).toEqual(['a.txt', 'b.txt', 'SHA256SUMS'])
    expect(gh.body).toBe(
      `Existing notes\n\n<!-- ci-sdk-release-assets:start -->\nSums:\n${sums.trimEnd()}\n<!-- ci-sdk-release-assets:end -->\n`
    )
    expect(output('release-id')).toBe('7')
    expect(output('release-url')).toBe('https://github.test/o/r/releases/tag/v1.0.0')
    expect(output('checksums')).toBe(sums)
    expect(JSON.parse(output('assets') as string)).toEqual([
      { name: 'a.txt', size: 2, url: 'https://github.test/dl/a.txt' },
      { name: 'b.txt', size: 3, url: 'https://github.test/dl/b.txt' },
      { name: 'SHA256SUMS', size: sums.length, url: 'https://github.test/dl/SHA256SUMS' }
    ])
  })

  it('patches notes from a fresh body, keeping edits made during the uploads', async () => {
    const gh = fakeGitHub({ body: 'start' })
    gh.onUpload = () => {
      gh.body = `${gh.body}\n\n<!-- other:start -->\nfrom another job\n<!-- other:end -->`
    }
    inputs({ files: 'a.txt', checksums: '', notes: 'mine' })
    await run()
    expect(gh.body).toContain('from another job')
    expect(gh.body).toContain('mine')
    expect(gh.body?.startsWith('start')).toBe(true)
  })

  it('replaces an existing asset of the same name', async () => {
    const gh = fakeGitHub({ assets: ['a.txt'] })
    inputs({ files: 'a.txt', checksums: '' })
    await run()
    expect(gh.deletes).toHaveLength(1)
    expect(gh.assets.filter(a => a.name === 'a.txt')).toHaveLength(1)
    expect(gh.assets[0]?.size).toBe(2)
    expect(gh.calls).not.toContain('PATCH /repos/o/r/releases/7')
  })

  it('fails on a name clash when overwrite=false', async () => {
    const gh = fakeGitHub({ assets: ['a.txt'] })
    inputs({ files: 'a.txt', checksums: '', overwrite: 'false' })
    await expect(run()).rejects.toThrow(/already exists/)
    expect(gh.uploads).toEqual([])
  })

  it('finds a draft release by scanning the release list', async () => {
    const gh = fakeGitHub({ draft: true })
    inputs({ files: 'a.txt', checksums: '' })
    await run()
    expect(gh.calls).toContain('GET /repos/o/r/releases')
    expect(gh.uploads).toEqual(['a.txt'])
  })

  it('on 422 deletes the same-name asset and uploads again', async () => {
    const gh = fakeGitHub()
    gh.failNextUploadWith422 = true
    inputs({ files: 'a.txt', checksums: '' })
    await run()
    expect(gh.deletes).toHaveLength(1)
    expect(gh.assets).toHaveLength(1)
    expect(gh.assets[0]?.size).toBe(2)
  })

  it('fails when no file matches, unless fail-if-no-files=false', async () => {
    fakeGitHub()
    inputs({ files: 'nope/*.zip' })
    await expect(run()).rejects.toThrow(/No files matched/)
    inputs({ files: 'nope/*.zip', 'fail-if-no-files': 'false' })
    await expect(run()).resolves.toBeUndefined()
  })

  it('rejects asset names GitHub would rewrite, before any upload', async () => {
    const gh = fakeGitHub()
    writeFileSync(path.join(ws, 'my file.txt'), 'x')
    inputs({ files: 'my file.txt' })
    await expect(run()).rejects.toThrow(/"my file\.txt".*Rename/)
    expect(gh.calls).toEqual([])
  })

  it.each(['../SUMS', 'sub/SUMS', 'a\\b', '..', 'bad name'])(
    'rejects checksums name %j',
    async name => {
      const gh = fakeGitHub()
      inputs({ files: 'a.txt', checksums: name })
      await expect(run()).rejects.toThrow()
      expect(gh.uploads).toEqual([])
    }
  )

  it('takes the tag from the pushed tag ref', async () => {
    const gh = fakeGitHub()
    inputs({ files: 'a.txt', checksums: '', tag: '' })
    vi.stubEnv('GITHUB_REF_TYPE', 'tag')
    vi.stubEnv('GITHUB_REF_NAME', 'v1.0.0')
    await run()
    expect(gh.uploads).toEqual(['a.txt'])
  })
})
