import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { CiError } from '../../sdk/src/index.js'

export interface LocalFile {
  path: string
  name: string
}

const toFile = (p: string): LocalFile => ({ path: p, name: path.basename(p) })

/**
 * Put `content` between the markers. The first existing block is replaced, any further
 * blocks are dropped, a block missing its end marker runs to the end of the text. No block:
 * the section is appended.
 */
export function replaceNotesBlock(body: string, id: string, content: string): string {
  const start = `<!-- ${id}:start -->`
  const end = `<!-- ${id}:end -->`
  const block = `${start}\n${content.trim()}\n${end}`
  let out = ''
  let pos = 0
  let replaced = false
  for (;;) {
    const s = body.indexOf(start, pos)
    if (s < 0) break
    out += body.slice(pos, s)
    if (!replaced) out += block
    replaced = true
    const e = body.indexOf(end, s + start.length)
    pos = e < 0 ? body.length : e + end.length
  }
  if (!replaced) {
    const base = body.trimEnd()
    return base === '' ? `${block}\n` : `${base}\n\n${block}\n`
  }
  return out + body.slice(pos)
}

/** `{checksums}` -> checksum text. A function replacer keeps `$` in the text literal. */
export function renderNotes(notes: string, checksumText: string): string {
  return notes.replaceAll('{checksums}', () => checksumText.trimEnd())
}

/** sha256sum format, sorted by name: `<hex>  <name>`. */
export function checksumText(entries: { name: string; sha256: string }[]): string {
  return [...entries]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(e => `${e.sha256}  ${e.name}\n`)
    .join('')
}

export async function sha256File(file: string): Promise<string> {
  return createHash('sha256')
    .update(await fs.readFile(file))
    .digest('hex')
}

const GLOB_CHARS = /[*?[\]{}]/

/** Resolve paths/globs (relative to `cwd`) to unique files; directories add their direct files. */
export async function resolveFiles(patterns: string[], cwd: string): Promise<LocalFile[]> {
  const found = new Map<string, LocalFile>()
  const add = async (candidate: string): Promise<void> => {
    const abs = path.resolve(cwd, candidate)
    const info = await fs.stat(abs).catch(() => undefined)
    if (!info) return
    if (info.isDirectory()) {
      for (const entry of await fs.readdir(abs, { withFileTypes: true })) {
        const child = path.join(abs, entry.name)
        if (entry.isFile()) found.set(child, toFile(child))
      }
    } else if (info.isFile()) {
      found.set(abs, toFile(abs))
    }
  }
  for (const pattern of patterns) {
    if (GLOB_CHARS.test(pattern)) {
      const matches: string[] = []
      for await (const match of fs.glob(pattern, { cwd })) matches.push(match)
      for (const match of matches.sort()) await add(match)
    } else {
      await add(pattern)
    }
  }
  const files = [...found.values()]
  assertUniqueNames(files)
  return files
}

export function assertUniqueNames(files: LocalFile[]): void {
  const seen = new Map<string, string>()
  for (const f of files) {
    const prev = seen.get(f.name)
    if (prev !== undefined) {
      throw new CiError(
        'E_DUPLICATE_ASSET',
        `Duplicate asset name "${f.name}": ${prev} and ${f.path}`
      )
    }
    seen.set(f.name, f.path)
  }
}

/** `https://uploads.github.com/.../assets{?name,label}` -> URL with `?name=<name>`. */
export function buildUploadUrl(uploadUrl: string, name: string): string {
  return `${uploadUrl.replace(/\{[^}]*\}$/, '')}?name=${encodeURIComponent(name)}`
}

const SAFE_NAME = /^[A-Za-z0-9._+-]+$/

/**
 * GitHub rewrites other characters in asset names (spaces become `.`), which would desync the
 * checksum list and same-name matching. Reject them up front.
 */
export function assertAssetNames(names: string[]): void {
  const bad = names.filter(n => !SAFE_NAME.test(n) || n === '.' || n === '..')
  if (bad.length > 0) {
    throw new CiError(
      'E_ASSET_NAME',
      `Unsupported asset name(s): ${bad.map(n => JSON.stringify(n)).join(', ')}. ` +
        'Allowed: letters, digits, ".", "_", "+", "-". Rename the file(s) before uploading.'
    )
  }
}

/** The checksums input is joined onto a temp dir: it must be a plain file name. */
export function assertChecksumsName(name: string): void {
  if (/[\\/]/.test(name) || name.includes('..')) {
    throw new CiError('E_CHECKSUMS_NAME', `checksums must be a plain file name, got "${name}"`)
  }
  assertAssetNames([name])
}
