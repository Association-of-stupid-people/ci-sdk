import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const DLL = 'Assets/Firebase/Plugins/Firebase.Analytics.dll'
/** Stand-in for an original Firebase.Analytics.dll (binary, no patch marker). */
export const ORIGINAL_DLL = Buffer.from('MZ\0\0Firebase.Analytics original\0\x01\x02')

export const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    'git',
    ['-c', 'user.name=ci', '-c', 'user.email=ci@example.com', '-c', 'core.autocrlf=false', ...args],
    { cwd, encoding: 'utf8' }
  )

/** A git repository with a committed Firebase.Analytics.dll (and Assets/Game.cs). */
export function gitProject(dir: string, files: Record<string, string | Buffer> = {}): string {
  mkdirSync(dir, { recursive: true })
  const all = { [DLL]: ORIGINAL_DLL, 'Assets/Game.cs': 'class Game {}\n', ...files }
  for (const [rel, content] of Object.entries(all)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    writeFileSync(path.join(dir, rel), content)
  }
  git(dir, 'init', '-q')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'init')
  return dir
}

/** `git status --porcelain` (empty = clean tree). */
export const status = (dir: string): string => git(dir, 'status', '--porcelain').trim()
