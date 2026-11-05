import path from 'node:path'
import { CiError } from '../../sdk/src/index.js'

export interface JavaLookup {
  /** The `java-path` input. */
  javaPath: string | undefined
  /** `JAVA_HOME`. */
  javaHome: string | undefined
  /** Unity editor executable (unity-build `editor-path`). */
  editorPath: string | undefined
  platform: NodeJS.Platform
  exists: (file: string) => boolean
}

export interface FoundJava {
  path: string
  source: 'java-path' | 'JAVA_HOME' | 'unity-editor' | 'PATH'
}

/**
 * The OpenJDK Unity ships with its Android module, from the editor executable:
 * - Windows/Linux: `<Editor>/Unity(.exe)` -> `<Editor>/Data/PlaybackEngines/AndroidPlayer/OpenJDK`
 * - macOS: `Unity.app/Contents/MacOS/Unity` -> `Unity.app/Contents/PlaybackEngines/AndroidPlayer/OpenJDK`
 */
export function unityJava(editorPath: string, platform: NodeJS.Platform): string {
  const p = platform === 'win32' ? path.win32 : path.posix
  const exe = platform === 'win32' ? 'java.exe' : 'java'
  const dir = p.dirname(editorPath)
  const engines =
    platform === 'darwin'
      ? p.join(p.dirname(dir), 'PlaybackEngines')
      : p.join(dir, 'Data', 'PlaybackEngines')
  return p.join(engines, 'AndroidPlayer', 'OpenJDK', 'bin', exe)
}

/** java from `java-path`, else JAVA_HOME, else the Unity editor's OpenJDK, else `java` on PATH. */
export function findJava(lookup: JavaLookup): FoundJava {
  const p = lookup.platform === 'win32' ? path.win32 : path.posix
  const exe = lookup.platform === 'win32' ? 'java.exe' : 'java'
  if (lookup.javaPath) {
    if (!lookup.exists(lookup.javaPath)) {
      throw new CiError('E_JAVA', `java-path does not exist: ${lookup.javaPath}`)
    }
    return { path: lookup.javaPath, source: 'java-path' }
  }
  if (lookup.javaHome) {
    const candidate = p.join(lookup.javaHome, 'bin', exe)
    if (lookup.exists(candidate)) return { path: candidate, source: 'JAVA_HOME' }
  }
  if (lookup.editorPath) {
    const candidate = unityJava(lookup.editorPath, lookup.platform)
    if (lookup.exists(candidate)) return { path: candidate, source: 'unity-editor' }
  }
  return { path: 'java', source: 'PATH' }
}
