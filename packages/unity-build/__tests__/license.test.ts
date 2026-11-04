import { describe, expect, it } from 'vitest'
import {
  activateArgs,
  licenseLogLines,
  machineLicenseFile,
  returnArgs,
  ulfHasSerial
} from '../src/license.js'
import type { HostEnv } from '../src/locate.js'
import { ulf } from './fixtures/ulf.js'

const host = (platform: NodeJS.Platform, env: Record<string, string> = {}): HostEnv => ({
  platform,
  env,
  home: platform === 'win32' ? 'C:\\Users\\ci' : '/home/ci',
  exists: () => false,
  read: () => undefined
})

describe('machineLicenseFile', () => {
  it.each([
    [host('win32', { PROGRAMDATA: 'D:\\PD' }), 'D:\\PD\\Unity\\Unity_lic.ulf'],
    [host('win32'), 'C:\\ProgramData\\Unity\\Unity_lic.ulf'],
    [host('darwin'), '/Library/Application Support/Unity/Unity_lic.ulf'],
    [host('linux'), '/home/ci/.local/share/unity3d/Unity/Unity_lic.ulf']
  ])('%#: %s', (h, expected) => {
    expect(machineLicenseFile(h)).toBe(expected)
  })
})

describe('ulfHasSerial', () => {
  const now = new Date('2026-06-01T00:00:00Z')
  it('is true for the same serial without an end date or before it', () => {
    expect(ulfHasSerial(ulf('SC-1234'), 'SC-1234', now)).toBe(true)
    expect(ulfHasSerial(ulf('SC-1234', '2027-01-01T00:00:00'), 'SC-1234', now)).toBe(true)
  })
  it.each([
    ['another serial', ulf('SC-9999'), 'SC-1234'],
    ['an expired license', ulf('SC-1234', '2026-01-01T00:00:00'), 'SC-1234'],
    ['an unreadable StopDate', ulf('SC-1234', 'soon'), 'SC-1234'],
    ['no DeveloperData', '<root><StopDate Value=""/></root>', 'SC-1234'],
    ['no file', undefined, 'SC-1234']
  ])('is false for %s', (_name, content, serial) => {
    expect(ulfHasSerial(content, serial, now)).toBe(false)
  })
})

describe('license command lines', () => {
  const account = { serial: 'SC-1', email: 'e@x', password: 'pw' }
  it('activates with the serial and the account, in a blank project', () => {
    expect(activateArgs(account, '/t/l.log', '/t/blank')).toEqual([
      '-batchmode',
      '-nographics',
      '-quit',
      '-logFile',
      '/t/l.log',
      '-projectPath',
      '/t/blank',
      '-serial',
      'SC-1',
      '-username',
      'e@x',
      '-password',
      'pw'
    ])
  })
  it('returns with the account only', () => {
    expect(returnArgs(account, '/t/l.log', '/t/blank')).toEqual([
      '-batchmode',
      '-nographics',
      '-quit',
      '-logFile',
      '/t/l.log',
      '-projectPath',
      '/t/blank',
      '-returnlicense',
      '-username',
      'e@x',
      '-password',
      'pw'
    ])
  })
})

describe('licenseLogLines', () => {
  it('keeps license/error lines, drops the echoed command line and masks secrets', () => {
    const log = [
      'COMMAND LINE ARGUMENTS:',
      '-serial',
      'SC-1234',
      '-password',
      'pw-secret',
      'Loading project...',
      '[Licensing::Client] Error: Code 400 for ci@example.com (SC-1234 / pw-secret)',
      'Unity.exe -batchmode -serial SC-1234',
      '  Error: license activation failed  '
    ].join('\r\n')
    expect(licenseLogLines(log, ['SC-1234', 'ci@example.com', 'pw-secret', ''])).toEqual([
      '[Licensing::Client] Error: Code 400 for *** (*** / ***)',
      'Error: license activation failed'
    ])
  })
  it('replaces the longest secret first and keeps the last lines', () => {
    expect(licenseLogLines('license abc abcdef', ['abc', 'abcdef'])).toEqual(['license *** ***'])
    const many = Array.from({ length: 30 }, (_, i) => `error ${i}`).join('\n')
    expect(licenseLogLines(many, [], 3)).toEqual(['error 27', 'error 28', 'error 29'])
  })
})
