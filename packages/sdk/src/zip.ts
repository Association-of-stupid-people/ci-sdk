import { createReadStream, createWriteStream } from 'node:fs'
import { copyFile, open, rm } from 'node:fs/promises'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createInflateRaw, crc32 } from 'node:zlib'
import { CiError } from './errors.js'

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

const APK_SIG_BLOCK_MAGIC = Buffer.from('APK Sig Block 42', 'latin1')
// zipalign's alignment extra field: id, then the alignment, then padding.
const ALIGNMENT_EXTRA = 0xd935

/**
 * Copy the zip (an APK) `src` to `dest` with one more entry, `name`, stored (not compressed) and
 * its data aligned to `align` bytes, as zipalign leaves an APK. An APK signing block is dropped:
 * the copy must be signed again (apksigner), which writes a new one. Not for zip64 files.
 */
export async function appendStoredZipEntry(
  src: string,
  dest: string,
  name: string,
  data: Buffer,
  align = 4
): Promise<void> {
  const nameBytes = Buffer.from(name, 'utf8')
  const entries = await readEntries(src)
  if (entries.some(e => e.name === name)) fail(`${src} already has ${name}`)

  const fh = await open(src, 'r')
  let cd: Buffer
  let comment: Buffer
  let entriesEnd: number
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
    if (eocd < 0) return fail(`${src} is not a zip file`)
    const count = tail.readUInt16LE(eocd + 10)
    const cdSize = tail.readUInt32LE(eocd + 12)
    const cdOffset = tail.readUInt32LE(eocd + 16)
    if (count === 0xffff || cdSize === MAX32 || cdOffset === MAX32)
      fail(`${src}: zip64 is not supported`)
    comment = Buffer.from(tail.subarray(eocd + 22, eocd + 22 + tail.readUInt16LE(eocd + 20)))
    cd = Buffer.alloc(cdSize)
    await fh.read(cd, 0, cdSize, cdOffset)
    // APK signing block (v2+): [size u64][pairs][size u64]["APK Sig Block 42"], right before the
    // central directory. The first size does not count itself.
    entriesEnd = cdOffset
    if (cdOffset >= 32) {
      const footer = Buffer.alloc(24)
      await fh.read(footer, 0, 24, cdOffset - 24)
      if (footer.subarray(8).equals(APK_SIG_BLOCK_MAGIC)) {
        const blockSize = footer.readBigUInt64LE(0)
        entriesEnd = cdOffset - Number(blockSize) - 8
        if (entriesEnd < 0) fail(`${src}: bad APK signing block`)
        // Both size fields agree, and no entry starts inside the block: else it is not one.
        const head = Buffer.alloc(8)
        await fh.read(head, 0, 8, entriesEnd)
        if (head.readBigUInt64LE(0) !== blockSize) fail(`${src}: bad APK signing block`)
      }
    }
    if (entries.some(e => e.localOffset >= entriesEnd)) {
      fail(`${src}: an entry starts after the end of the entries`)
    }
  } finally {
    await fh.close()
  }

  const crc = crc32(data) >>> 0
  // Data offset = entriesEnd + 30 + name + extra: the extra field pads it to `align`.
  const minExtra = 6
  const pad = (align - ((entriesEnd + 30 + nameBytes.length + minExtra) % align)) % align
  const extra = Buffer.alloc(minExtra + pad)
  extra.writeUInt16LE(ALIGNMENT_EXTRA, 0)
  extra.writeUInt16LE(2 + pad, 2)
  extra.writeUInt16LE(align, 4)

  // DOS date 1981-01-01 00:00, as aapt2 and zipalign write it: the same bytes on every run.
  const dosTime = 0
  const dosDate = (1 << 9) | (1 << 5) | 1
  const local = Buffer.alloc(30)
  local.writeUInt32LE(LOCAL, 0)
  local.writeUInt16LE(10, 4) // version needed
  local.writeUInt16LE(0, 6) // flags
  local.writeUInt16LE(0, 8) // stored
  local.writeUInt16LE(dosTime, 10)
  local.writeUInt16LE(dosDate, 12)
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(data.length, 18)
  local.writeUInt32LE(data.length, 22)
  local.writeUInt16LE(nameBytes.length, 26)
  local.writeUInt16LE(extra.length, 28)

  const central = Buffer.alloc(46)
  central.writeUInt32LE(CENTRAL, 0)
  central.writeUInt16LE(10, 4) // version made by
  central.writeUInt16LE(10, 6) // version needed
  central.writeUInt16LE(0, 8)
  central.writeUInt16LE(0, 10)
  central.writeUInt16LE(dosTime, 12)
  central.writeUInt16LE(dosDate, 14)
  central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(data.length, 20)
  central.writeUInt32LE(data.length, 24)
  central.writeUInt16LE(nameBytes.length, 28)
  central.writeUInt16LE(0, 30) // no extra in the central directory
  central.writeUInt16LE(0, 32) // no comment
  central.writeUInt16LE(0, 34) // disk
  central.writeUInt16LE(0, 36) // internal attributes
  central.writeUInt32LE(0, 38) // external attributes
  central.writeUInt32LE(entriesEnd, 42)

  const newCdOffset = entriesEnd + local.length + nameBytes.length + extra.length + data.length
  const newCdSize = cd.length + central.length + nameBytes.length
  if (newCdOffset + newCdSize > MAX32 || entries.length + 1 >= 0xffff) {
    fail(`${src}: too large without zip64`)
  }
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(EOCD, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length + 1, 8)
  eocd.writeUInt16LE(entries.length + 1, 10)
  eocd.writeUInt32LE(newCdSize, 12)
  eocd.writeUInt32LE(newCdOffset, 16)
  eocd.writeUInt16LE(comment.length, 20)

  await copyFile(src, dest)
  try {
    const out = await open(dest, 'r+')
    try {
      await out.truncate(entriesEnd)
      const tailBytes = Buffer.concat([
        local,
        nameBytes,
        extra,
        data,
        cd,
        central,
        nameBytes,
        eocd,
        comment
      ])
      await out.write(tailBytes, 0, tailBytes.length, entriesEnd)
    } finally {
      await out.close()
    }
  } catch (err) {
    await rm(dest, { force: true })
    throw err
  }
}

/** Data offset of every stored (uncompressed) entry, from its local header: name -> offset. */
export async function storedEntryOffsets(file: string): Promise<Map<string, number>> {
  const entries = (await readEntries(file)).filter(e => e.method === 0)
  const offsets = new Map<string, number>()
  const fh = await open(file, 'r')
  try {
    const local = Buffer.alloc(30)
    for (const e of entries) {
      await fh.read(local, 0, 30, e.localOffset)
      if (local.readUInt32LE(0) !== LOCAL) fail(`${file}: bad local header for ${e.name}`)
      offsets.set(e.name, e.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28))
    }
  } finally {
    await fh.close()
  }
  return offsets
}
