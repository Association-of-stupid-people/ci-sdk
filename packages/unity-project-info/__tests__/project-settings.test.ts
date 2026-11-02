import { describe, expect, it } from 'vitest'
import { parseProjectSettings } from '../src/project-settings.js'

const ASSET = `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!129 &1
PlayerSettings:
  m_ObjectHideFlags: 0
  serializedVersion: 26
  companyName: Mirai Studio
  productName: 'Block: Puzzle'
  defaultCursor: {fileID: 0}
  cursorHotspot: {x: 0, y: 0}
  m_SplashScreenBackgroundColor: {r: 0.13725491, g: 0.12156863, b: 0.1254902, a: 1}
  defaultScreenWidth: 1080
  defaultScreenHeight: 1920
  defaultScreenWidthWeb: 960
  defaultScreenHeightWeb: 600
  bundleVersion: 1.10
  applicationIdentifier:
    Android: com.mirai.block
  AndroidBundleVersionCode: 12
`

describe('parseProjectSettings', () => {
  it('reads the Unity !u! tagged document', () => {
    expect(parseProjectSettings(ASSET)).toEqual({
      companyName: 'Mirai Studio',
      productName: 'Block: Puzzle',
      bundleVersion: '1.10', // stays a string, not 1.1
      webScreenWidth: '960',
      webScreenHeight: '600'
    })
  })

  it('defaults web size to 0', () => {
    const info = parseProjectSettings('--- !u!129 &1\nPlayerSettings:\n  bundleVersion: 2.0.0\n')
    expect(info.webScreenWidth).toBe('0')
    expect(info.bundleVersion).toBe('2.0.0')
  })

  it('fails clearly without PlayerSettings', () => {
    expect(() => parseProjectSettings('--- !u!1 &1\nOther: {}\n')).toThrow(
      /PlayerSettings not found/
    )
  })

  it('fails clearly on broken YAML', () => {
    expect(() => parseProjectSettings('PlayerSettings:\n  a: [1, 2\n')).toThrow(/Cannot parse/)
  })
})
