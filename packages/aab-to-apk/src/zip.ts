import { createReadStream, createWriteStream } from 'node:fs'
import { open, rm } from 'node:fs/promises'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createInflateRaw, crc32 } from 'node:zlib'
import { CiError } from '../../sdk/src/index.js'

interface Entry {
  name: string
  method: number
  flags: number
  crc: number
  compressedSize: number
  size: number
  localOffset: number
}

const EOCD = 0x06054b50
const ZIP64_LOCATOR = 0x07064b50
const ZIP64_EOCD = 0x06064b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50
const MAX32 = 0xffffffff

const fail = (message: string): never => {
  throw new CiError('E_ZIP', message)
}

/** Central directory of a zip (zip64 included), read from the end of the file. */
async function readEntries(file: string): Promise<Entry[]> {
  const fh = await open(file, 'r')
  try {
    const { size: fileSize } = await fh.stat()
    const tailSize = Math.min(fileSize, 22 + 0xffff)
    const tail = Buffer.alloc(tailSize)
    await fh.read(tail, 0, tailSize, fileSize - tailSize)
    let eocd = -1
    for (let i = tailSize - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD) {
        eocd = i
        break
      }
    }
    if (eocd < 0) fail(`${file} is not a zip file`)
    let count = tail.readUInt16LE(eocd + 10)
    let cdSize = tail.readUInt32LE(eocd + 12)
    let cdOffset = tail.readUInt32LE(eocd + 16)
    if (count === 0xffff || cdSize === MAX32 || cdOffset === MAX32) {
      const locator = eocd - 20
      if (locator < 0 || tail.readUInt32LE(locator) !== ZIP64_LOCATOR) fail(`${file}: bad zip64`)
      const z64Offset = Number(tail.readBigUInt64LE(locator + 8))
      const z64 = Buffer.alloc(56)
      await fh.read(z64, 0, 56, z64Offset)
      if (z64.readUInt32LE(0) !== ZIP64_EOCD) fail(`${file}: bad zip64 end record`)
      count = Number(z64.readBigUInt64LE(32))
      cdSize = Number(z64.readBigUInt64LE(40))
      cdOffset = Number(z64.readBigUInt64LE(48))
    }
    const cd = Buffer.alloc(cdSize)
    await fh.read(cd, 0, cdSize, cdOffset)
    const entries: Entry[] = []
    let p = 0
    for (let n = 0; n < count; n++) {
      if (cd.readUInt32LE(p) !== CENTRAL) fail(`${file}: bad central directory`)
      const nameLength = cd.readUInt16LE(p + 28)
      const extraLength = cd.readUInt16LE(p + 30)
      const commentLength = cd.readUInt16LE(p + 32)
      const entry: Entry = {
        flags: cd.readUInt16LE(p + 8),
        method: cd.readUInt16LE(p + 10),
        crc: cd.readUInt32LE(p + 16),
        compressedSize: cd.readUInt32LE(p + 20),
        size: cd.readUInt32LE(p + 24),
        localOffset: cd.readUInt32LE(p + 42),
        name: cd.toString('utf8', p + 46, p + 46 + nameLength)
      }
      // zip64 extra field: the 0xFFFFFFFF values follow in this order.
      let e = p + 46 + nameLength
      const extraEnd = e + extraLength
      while (e + 4 <= extraEnd) {
        const id = cd.readUInt16LE(e)
        const len = cd.readUInt16LE(e + 2)
        if (id === 0x0001) {
          let q = e + 4
          const next = (): number => {
            const value = Number(cd.readBigUInt64LE(q))
            q += 8
            return value
          }
          if (entry.size === MAX32) entry.size = next()
          if (entry.compressedSize === MAX32) entry.compressedSize = next()
          if (entry.localOffset === MAX32) entry.localOffset = next()
        }
        e += 4 + len
      }
      entries.push(entry)
      p = extraEnd + commentLength
    }
    return entries
  } finally {
    await fh.close()
  }
}

/** Names of the entries of a zip. */
export async function listZip(file: string): Promise<string[]> {
  return (await readEntries(file)).map(e => e.name)
}

/**
 * Extract one entry of a zip to `dest`, streamed (stored or deflated), and check its size and
 * CRC-32. A partial `dest` is removed on failure.
 */
export async function extractZipEntry(file: string, name: string, dest: string): Promise<number> {
  const entry = (await readEntries(file)).find(e => e.name === name)
  if (!entry) return fail(`${file} has no ${name}`)
  if (entry.flags & 0x1) fail(`${file}: ${name} is encrypted`)
  if (entry.method !== 0 && entry.method !== 8) {
    fail(`${file}: ${name} uses compression method ${entry.method}`)
  }

  const fh = await open(file, 'r')
  let dataStart: number
  try {
    const local = Buffer.alloc(30)
    await fh.read(local, 0, 30, entry.localOffset)
    if (local.readUInt32LE(0) !== LOCAL) fail(`${file}: bad local header for ${name}`)
    dataStart = entry.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28)
  } finally {
    await fh.close()
  }

  let crc = 0
  let size = 0
  const check = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      crc = crc32(chunk, crc)
      size += chunk.length
      done(null, chunk)
    }
  })
  const source =
    entry.compressedSize === 0
      ? Readable.from([])
      : createReadStream(file, { start: dataStart, end: dataStart + entry.compressedSize - 1 })
  try {
    if (entry.method === 8)
      await pipeline(source, createInflateRaw(), check, createWriteStream(dest))
    else await pipeline(source, check, createWriteStream(dest))
    if (size !== entry.size)
      fail(`${file}: ${name} is corrupt (${size} bytes, expected ${entry.size})`)
    if (crc >>> 0 !== entry.crc >>> 0) fail(`${file}: ${name} is corrupt (CRC-32 mismatch)`)
  } catch (err) {
    await rm(dest, { force: true })
    throw err
  }
  return size
}
