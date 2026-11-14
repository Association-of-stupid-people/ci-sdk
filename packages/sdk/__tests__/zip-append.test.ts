import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { crc32, deflateRawSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendStoredZipEntry, extractZipEntry, listZip } from '../src/index.js'

/** A minimal zip (stored or deflated entries), optionally with an APK signing block before the CD. */
function makeZip(
  entries: { name: string; data: Buffer; method?: 0 | 8 }[],
  options: { signingBlock?: boolean; comment?: string } = {}
): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const method = e.method ?? 8
    const body = method === 8 ? deflateRawSync(e.data) : e.data
    const name = Buffer.from(e.name, 'utf8')
    const crc = crc32(e.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(e.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(e.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, name, body)
    centrals.push(central, name)
    offset += local.length + name.length + body.length
  }
  const parts = [...locals]
  if (options.signingBlock) {
    // [size u64][one pair: len u64, id u32, value][size u64][magic]
    const pair = Buffer.alloc(8 + 4 + 5)
    pair.writeBigUInt64LE(BigInt(4 + 5), 0)
    pair.writeUInt32LE(0x7109871a, 8)
    pair.write('value', 12, 'latin1')
    const size = BigInt(pair.length + 8 + 16)
    const head = Buffer.alloc(8)
    head.writeBigUInt64LE(size)
    const block = Buffer.concat([head, pair, head, Buffer.from('APK Sig Block 42', 'latin1')])
    parts.push(block)
    offset += block.length
  }
  const cd = Buffer.concat(centrals)
  const comment = Buffer.from(options.comment ?? '', 'latin1')
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(comment.length, 20)
  return Buffer.concat([...parts, cd, eocd, comment])
}

/** Data offset of a stored entry, from its local header. */
async function dataOffset(file: string, name: string): Promise<number> {
  const bytes = await readFile(file)
  const at = bytes.indexOf(Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4])]), 0)
  let p = at
  while (p >= 0) {
    const nameLength = bytes.readUInt16LE(p + 26)
    if (bytes.toString('utf8', p + 30, p + 30 + nameLength) === name) {
      return p + 30 + nameLength + bytes.readUInt16LE(p + 28)
    }
    p = bytes.indexOf(Buffer.from([0x50, 0x4b, 3, 4]), p + 4)
  }
  throw new Error(`${name} not found`)
}

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'ci-sdk-zip-append-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('appendStoredZipEntry', () => {
  it('adds a stored, 4-byte aligned entry and keeps every other entry', async () => {
    const src = path.join(dir, 'in.apk')
    const dest = path.join(dir, 'out.apk')
    await writeFile(
      src,
      makeZip(
        [
          { name: 'AndroidManifest.xml', data: Buffer.from('manifest'), method: 8 },
          { name: 'res/a.bin', data: Buffer.from('abc'), method: 0 }
        ],
        { comment: 'hi' }
      )
    )
    await appendStoredZipEntry(src, dest, 'assets/ci-segment.txt', Buffer.from('seg\n'))

    expect(await listZip(dest)).toEqual([
      'AndroidManifest.xml',
      'res/a.bin',
      'assets/ci-segment.txt'
    ])
    const out = path.join(dir, 'x')
    await extractZipEntry(dest, 'assets/ci-segment.txt', out)
    expect(await readFile(out, 'utf8')).toBe('seg\n')
    await extractZipEntry(dest, 'AndroidManifest.xml', out)
    expect(await readFile(out, 'utf8')).toBe('manifest')
    expect((await dataOffset(dest, 'assets/ci-segment.txt')) % 4).toBe(0)
    // The zip comment is kept, the source is untouched.
    expect((await readFile(dest)).subarray(-2).toString('latin1')).toBe('hi')
    expect(await listZip(src)).toEqual(['AndroidManifest.xml', 'res/a.bin'])
  })

  it('drops the APK signing block (the copy is signed again)', async () => {
    const src = path.join(dir, 'in.apk')
    const dest = path.join(dir, 'out.apk')
    await writeFile(
      src,
      makeZip([{ name: 'classes.dex', data: Buffer.from('dex'), method: 0 }], {
        signingBlock: true
      })
    )
    await appendStoredZipEntry(src, dest, 'assets/s.txt', Buffer.from('1'))
    const bytes = await readFile(dest)
    expect(bytes.includes(Buffer.from('APK Sig Block 42', 'latin1'))).toBe(false)
    expect(await listZip(dest)).toEqual(['classes.dex', 'assets/s.txt'])
    const out = path.join(dir, 'x')
    await extractZipEntry(dest, 'classes.dex', out)
    expect(await readFile(out, 'utf8')).toBe('dex')
  })

  it('refuses an entry that is already there', async () => {
    const src = path.join(dir, 'in.apk')
    await writeFile(src, makeZip([{ name: 'assets/s.txt', data: Buffer.from('1'), method: 0 }]))
    await expect(
      appendStoredZipEntry(src, path.join(dir, 'out.apk'), 'assets/s.txt', Buffer.from('2'))
    ).rejects.toThrow(/already has assets\/s.txt/)
  })

  it.each([1, 2, 3, 5, 17])('aligns whatever the name length (%i)', async n => {
    const src = path.join(dir, 'in.apk')
    const dest = path.join(dir, 'out.apk')
    await writeFile(
      src,
      makeZip([{ name: 'x'.repeat(n), data: Buffer.from('y'.repeat(n)), method: 0 }])
    )
    await appendStoredZipEntry(src, dest, 'assets/ci-segment.txt', Buffer.from('z'))
    expect((await dataOffset(dest, 'assets/ci-segment.txt')) % 4).toBe(0)
  })
})
