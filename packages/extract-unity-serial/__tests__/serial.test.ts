import { describe, expect, it } from 'vitest'
import { getSerialFromLicense } from '../src/serial.js'

const license = (payload: string): string =>
  `<?xml version="1.0"?><root><License><DeveloperData Value="${Buffer.from(payload, 'binary').toString('base64')}"/></License></root>`

describe('getSerialFromLicense', () => {
  it('extracts the serial (drops the 4-byte prefix)', () => {
    expect(getSerialFromLicense(license('\u0001\u0002\u0003\u0004SB-1234-5678 '))).toBe(
      'SB-1234-5678'
    )
  })

  it('rejects a file without DeveloperData (v1 never detected this)', () => {
    expect(() => getSerialFromLicense('<root/>')).toThrow(/not found/)
  })

  it('rejects an unclosed tag', () => {
    expect(() => getSerialFromLicense('<DeveloperData Value="abc')).toThrow(/not closed/)
  })

  it('rejects an empty serial', () => {
    expect(() => getSerialFromLicense(license('XXXX   '))).toThrow(/Serial key not found/)
  })
})
