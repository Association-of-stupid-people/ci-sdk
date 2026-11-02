import { describe, expect, it } from 'vitest'
import {
  editorCandidates,
  findEditor,
  findHub,
  missingModules,
  moduleMarker,
  which,
  type HostEnv
} from '../src/locate.js'

const fakeHost = (
  platform: NodeJS.Platform,
  files: Record<string, string> = {},
  env: Record<string, string> = {}
): HostEnv => ({
  platform,
  env,
  home: platform === 'win32' ? 'C:\\Users\\ci' : platform === 'darwin' ? '/Users/ci' : '/home/ci',
  exists: f => f in files,
  read: f => files[f]
})

const V = '2022.3.20f1'

describe('editor lookup', () => {
  it('finds the default Hub install on Windows', () => {
    const exe = `C:\\Program Files\\Unity\\Hub\\Editor\\${V}\\Editor\\Unity.exe`
    expect(findEditor(fakeHost('win32', { [exe]: '' }), V)).toBe(exe)
  })

  it('finds the default Hub install on macOS', () => {
    const exe = `/Applications/Unity/Hub/Editor/${V}/Unity.app/Contents/MacOS/Unity`
    expect(findEditor(fakeHost('darwin', { [exe]: '' }), V)).toBe(exe)
  })

  it('finds Linux Hub and GameCI layouts', () => {
    const hub = `/home/ci/Unity/Hub/Editor/${V}/Editor/Unity`
    const opt = `/opt/unity/editors/${V}/Editor/Unity`
    expect(findEditor(fakeHost('linux', { [hub]: '' }), V)).toBe(hub)
    expect(findEditor(fakeHost('linux', { [opt]: '' }), V)).toBe(opt)
  })

  it('uses the Hub secondary install path and registered editors first', () => {
    const appData = 'C:\\Users\\ci\\AppData\\Roaming'
    const secondary = `${appData}\\UnityHub\\secondaryInstallPath.json`
    const registered = `${appData}\\UnityHub\\editors-v2.json`
    const host = fakeHost(
      'win32',
      {
        [secondary]: JSON.stringify('D:\\Unity'),
        [registered]: JSON.stringify({
          data: [{ version: V, location: ['E:\\U\\Editor\\Unity.exe'] }]
        })
      },
      { APPDATA: appData }
    )
    const candidates = editorCandidates(host, V)
    expect(candidates[0]).toBe('E:\\U\\Editor\\Unity.exe')
    expect(candidates).toContain(`D:\\Unity\\${V}\\Editor\\Unity.exe`)
    expect(candidates.at(-1)).toBe(`C:\\Program Files\\Unity ${V}\\Editor\\Unity.exe`)
  })

  it('normalises .app locations and extra roots', () => {
    const cfg = '/Users/ci/Library/Application Support/UnityHub/editors.json'
    const host = fakeHost('darwin', {
      [cfg]: JSON.stringify({ [V]: { version: V, location: ['/Volumes/U/Unity.app'] } })
    })
    const candidates = editorCandidates(host, V, ['/Volumes/Editors'])
    expect(candidates[0]).toBe('/Volumes/U/Unity.app/Contents/MacOS/Unity')
    expect(candidates).toContain(`/Volumes/Editors/${V}/Unity.app/Contents/MacOS/Unity`)
  })

  it('ignores corrupt Hub files', () => {
    const cfg = '/home/ci/.config/UnityHub/editors-v2.json'
    expect(() => editorCandidates(fakeHost('linux', { [cfg]: '{oops' }), V)).not.toThrow()
  })
})

describe('Unity Hub and modules', () => {
  it('finds Hub per platform', () => {
    const win = 'C:\\Program Files\\Unity Hub\\Unity Hub.exe'
    expect(findHub(fakeHost('win32', { [win]: '' }))).toBe(win)
    expect(findHub(fakeHost('linux', { '/opt/unityhub/unityhub': '' }))).toBe(
      '/opt/unityhub/unityhub'
    )
    expect(findHub(fakeHost('darwin'))).toBeUndefined()
  })

  it('checks PlaybackEngines for modules', () => {
    const exe = `/Applications/Unity/Hub/Editor/${V}/Unity.app/Contents/MacOS/Unity`
    expect(moduleMarker(exe, 'android', 'darwin')).toBe(
      `/Applications/Unity/Hub/Editor/${V}/PlaybackEngines/AndroidPlayer`
    )
    const win = `C:\\U\\${V}\\Editor\\Unity.exe`
    const host = fakeHost('win32', {
      [`C:\\U\\${V}\\Editor\\Data\\PlaybackEngines\\AndroidPlayer`]: ''
    })
    expect(missingModules(host, win, ['android', 'ios', 'linux-il2cpp'])).toEqual(['ios'])
  })

  it('searches PATH', () => {
    const host = fakeHost('linux', { '/usr/bin/xvfb-run': '' }, { PATH: '/bin:/usr/bin' })
    expect(which(host, 'xvfb-run')).toBe('/usr/bin/xvfb-run')
    expect(which(host, 'nope')).toBeUndefined()
  })
})
