import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Host facts used to locate Unity; injectable so every OS layout is testable anywhere. */
export interface HostEnv {
  platform: NodeJS.Platform
  env: Readonly<Record<string, string | undefined>>
  home: string
  exists(file: string): boolean
  /** File content, or undefined when missing/unreadable. */
  read(file: string): string | undefined
}

export function currentHost(): HostEnv {
  return {
    platform: process.platform,
    env: process.env,
    home: os.homedir(),
    exists: existsSync,
    read: file => {
      try {
        return readFileSync(file, 'utf8')
      } catch {
        return undefined
      }
    }
  }
}

const pathFor = (platform: NodeJS.Platform): path.PlatformPath =>
  platform === 'win32' ? path.win32 : path.posix

/** Editor binary inside a Hub version folder (`.../Hub/Editor/<version>`). */
export function editorExecutable(versionDir: string, platform: NodeJS.Platform): string {
  const p = pathFor(platform)
  if (platform === 'win32') return p.join(versionDir, 'Editor', 'Unity.exe')
  if (platform === 'darwin') return p.join(versionDir, 'Unity.app', 'Contents', 'MacOS', 'Unity')
  return p.join(versionDir, 'Editor', 'Unity')
}

/** Unity Hub's settings folder (editors-v2.json, secondaryInstallPath.json). */
export function hubConfigDir(host: HostEnv): string {
  const p = pathFor(host.platform)
  if (host.platform === 'win32') {
    return p.join(host.env.APPDATA ?? p.join(host.home, 'AppData', 'Roaming'), 'UnityHub')
  }
  if (host.platform === 'darwin') {
    return p.join(host.home, 'Library', 'Application Support', 'UnityHub')
  }
  return p.join(host.env.XDG_CONFIG_HOME ?? p.join(host.home, '.config'), 'UnityHub')
}

function readJson(host: HostEnv, file: string): unknown {
  const text = host.read(file)
  if (text === undefined) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/** Every `location` recorded for `version`, in any Hub editors file layout (v1 map or v2 list). */
function collectLocations(node: unknown, version: string, out: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectLocations(item, version, out)
    return
  }
  if (!node || typeof node !== 'object') return
  const record = node as Record<string, unknown>
  if (record.version === version) {
    const loc = record.location
    if (typeof loc === 'string') out.push(loc)
    else if (Array.isArray(loc)) out.push(...loc.filter((l): l is string => typeof l === 'string'))
  }
  for (const value of Object.values(record)) {
    if (value && typeof value === 'object') collectLocations(value, version, out)
  }
}

/** Editors registered in Unity Hub (installed by Hub or added with "Locate"). */
export function hubRegisteredEditors(host: HostEnv, version: string): string[] {
  const p = pathFor(host.platform)
  const dir = hubConfigDir(host)
  const out: string[] = []
  for (const file of ['editors-v2.json', 'editors.json']) {
    collectLocations(readJson(host, p.join(dir, file)), version, out)
  }
  return out.map(loc => {
    if (loc.endsWith('.app')) return p.join(loc, 'Contents', 'MacOS', 'Unity')
    return /Unity(\.exe)?$/i.test(loc) ? loc : editorExecutable(loc, host.platform)
  })
}

/** Folders that contain one sub-folder per installed version. */
export function editorRoots(host: HostEnv, extra: readonly string[] = []): string[] {
  const p = pathFor(host.platform)
  const roots = [...extra]
  const secondary = readJson(host, p.join(hubConfigDir(host), 'secondaryInstallPath.json'))
  if (typeof secondary === 'string' && secondary.trim()) roots.push(secondary.trim())
  if (host.platform === 'win32') {
    const programFiles = host.env.ProgramFiles ?? 'C:\\Program Files'
    roots.push(p.join(programFiles, 'Unity', 'Hub', 'Editor'))
  } else if (host.platform === 'darwin') {
    roots.push('/Applications/Unity/Hub/Editor')
  } else {
    roots.push(
      p.join(host.home, 'Unity', 'Hub', 'Editor'),
      '/opt/unity/editors',
      '/opt/Unity/Hub/Editor'
    )
  }
  return [...new Set(roots)]
}

/** Candidate editor paths for `version`, most specific first. */
export function editorCandidates(
  host: HostEnv,
  version: string,
  extraRoots: readonly string[] = []
): string[] {
  const p = pathFor(host.platform)
  const candidates = [
    ...hubRegisteredEditors(host, version),
    ...editorRoots(host, extraRoots).map(root =>
      editorExecutable(p.join(root, version), host.platform)
    )
  ]
  // Pre-Hub standalone installs: "C:\Program Files\Unity 2019.4.1f1", "/Applications/Unity 2019.4.1f1".
  if (host.platform === 'win32') {
    const programFiles = host.env.ProgramFiles ?? 'C:\\Program Files'
    candidates.push(p.join(programFiles, `Unity ${version}`, 'Editor', 'Unity.exe'))
  } else if (host.platform === 'darwin') {
    candidates.push(`/Applications/Unity ${version}/Unity.app/Contents/MacOS/Unity`)
  }
  return [...new Set(candidates)]
}

export function findEditor(
  host: HostEnv,
  version: string,
  extraRoots: readonly string[] = []
): string | undefined {
  return editorCandidates(host, version, extraRoots).find(c => host.exists(c))
}

export function hubCandidates(host: HostEnv): string[] {
  const p = pathFor(host.platform)
  if (host.platform === 'win32') {
    const programFiles = host.env.ProgramFiles ?? 'C:\\Program Files'
    return [p.join(programFiles, 'Unity Hub', 'Unity Hub.exe')]
  }
  if (host.platform === 'darwin') return ['/Applications/Unity Hub.app/Contents/MacOS/Unity Hub']
  return [
    '/opt/unityhub/unityhub',
    '/usr/bin/unityhub',
    p.join(host.home, 'Applications', 'Unity Hub.AppImage')
  ]
}

export function findHub(host: HostEnv): string | undefined {
  return hubCandidates(host).find(c => host.exists(c))
}

/** Hub module id -> PlaybackEngines folder that proves it is installed. */
const PLAYBACK_ENGINES: Readonly<Record<string, string>> = {
  android: 'AndroidPlayer',
  ios: 'iOSSupport',
  appletv: 'AppleTVSupport',
  webgl: 'WebGLSupport',
  'windows-mono': 'WindowsStandaloneSupport',
  'mac-mono': 'MacStandaloneSupport',
  'linux-mono': 'LinuxStandaloneSupport'
}

/** Folder that exists when `module` is installed, or undefined for modules we cannot check. */
export function moduleMarker(
  editor: string,
  module: string,
  platform: NodeJS.Platform
): string | undefined {
  const engine = PLAYBACK_ENGINES[module]
  if (!engine) return undefined
  const p = pathFor(platform)
  // macOS: <version>/Unity.app/Contents/MacOS/Unity -> <version>/PlaybackEngines
  // others: <version>/Editor/Unity(.exe)          -> <version>/Editor/Data/PlaybackEngines
  const base =
    platform === 'darwin'
      ? p.join(p.dirname(p.dirname(p.dirname(p.dirname(editor)))), 'PlaybackEngines')
      : p.join(p.dirname(editor), 'Data', 'PlaybackEngines')
  return p.join(base, engine)
}

/** Requested modules that are verifiably missing from `editor`. */
export function missingModules(
  host: HostEnv,
  editor: string,
  modules: readonly string[]
): string[] {
  return modules.filter(m => {
    const marker = moduleMarker(editor, m, host.platform)
    return marker !== undefined && !host.exists(marker)
  })
}

/** First executable named `name` on PATH (no shell). */
export function which(host: HostEnv, name: string): string | undefined {
  const p = pathFor(host.platform)
  const pathVar = host.env.PATH ?? host.env.Path ?? ''
  const exts = host.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']
  for (const dir of pathVar.split(host.platform === 'win32' ? ';' : ':')) {
    if (!dir) continue
    for (const ext of exts) {
      const file = p.join(dir, name + ext)
      if (host.exists(file)) return file
    }
  }
  return undefined
}
