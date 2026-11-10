// Stand-in for the dotnet CLI: `--list-sdks` prints FAKE_DOTNET_SDKS (default a 10.x SDK);
// `run --file <tool> -- <dll>` appends the patch marker to the DLL (FAKE_DOTNET_MODE=ok, default),
// exits 1 (fail) or exits 0 without touching it (noop). Every call is appended to FAKE_DOTNET_CALLS.
import { appendFileSync, existsSync } from 'node:fs'

const argv = process.argv.slice(2)
if (process.env.FAKE_DOTNET_CALLS)
  appendFileSync(process.env.FAKE_DOTNET_CALLS, `${argv.join(' ')}\n`)
if (argv[0] === '--list-sdks') {
  console.log(process.env.FAKE_DOTNET_SDKS ?? '10.0.100 [/fake/dotnet/sdk]')
  process.exit(0)
}
if (argv[0] === 'run' && argv[1] === '--file') {
  const tool = argv[2]
  const dll = argv[argv.indexOf('--') + 1]
  if (!existsSync(tool)) {
    console.error(`no such file: ${tool}`)
    process.exit(1)
  }
  const mode = process.env.FAKE_DOTNET_MODE ?? 'ok'
  if (mode === 'fail') {
    console.error('Unknown LogEvent overload')
    process.exit(1)
  }
  if (mode === 'ok') appendFileSync(dll, 'Firebase.Analytics.BibgDebugViewHooks')
  console.log(`patched: ${dll}`)
  process.exit(0)
}
process.exit(2)
