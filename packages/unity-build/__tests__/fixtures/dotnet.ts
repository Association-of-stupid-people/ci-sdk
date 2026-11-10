import { chmodSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./fake-dotnet.mjs', import.meta.url))

/** A `dotnet` executable in `dir` that runs fake-dotnet.mjs (a .cmd shim on Windows). */
export function fakeDotnet(dir: string): string {
  if (process.platform === 'win32') {
    const bin = path.join(dir, 'dotnet.cmd')
    writeFileSync(bin, `@"${process.execPath}" "${script}" %*\r\n`)
    return bin
  }
  const bin = path.join(dir, 'dotnet')
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`)
  chmodSync(bin, 0o755)
  return bin
}
