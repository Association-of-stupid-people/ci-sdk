// Stand-in for the Unity editor: behaviour is chosen with FAKE_UNITY_MODE, and
// FAKE_UNITY_STATE counts runs so a test can fail the first attempt only.
// License runs (-serial / -returnlicense) are not counted: they append their
// argv to FAKE_UNITY_CALLS, write a log with the command line echoed (as Unity
// does) to -logFile, and fail when FAKE_UNITY_ACTIVATE / FAKE_UNITY_RETURN=fail.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const license = argv.includes('-serial')
  ? 'activate'
  : argv.includes('-returnlicense')
    ? 'return'
    : undefined
if (license) {
  if (process.env.FAKE_UNITY_CALLS) {
    const leaked = Object.keys(process.env).filter(k => /^INPUT_/i.test(k)).length
    appendFileSync(process.env.FAKE_UNITY_CALLS, `${license} ${argv.join(' ')} inputs=${leaked}\n`)
  }
  const failed =
    process.env[license === 'activate' ? 'FAKE_UNITY_ACTIVATE' : 'FAKE_UNITY_RETURN'] === 'fail'
  const user = argv[argv.indexOf('-username') + 1]
  const password = argv[argv.indexOf('-password') + 1]
  const log = [
    'COMMAND LINE ARGUMENTS:',
    ...argv,
    `[Licensing::Module] Successfully connected to LicensingClient for ${user}`,
    'Loading project...',
    ...(failed
      ? [
          `[Licensing::Client] Error: Code 400 while processing request for ${user} (password ${password})`,
          'Error: license activation failed',
          '-serial was rejected'
        ]
      : ['[Licensing::Client] License activated'])
  ]
  writeFileSync(argv[argv.indexOf('-logFile') + 1], `${log.join('\n')}\n`)
  process.exit(failed ? 1 : 0)
}

const mode = process.env.FAKE_UNITY_MODE ?? 'ok'
const stateFile = process.env.FAKE_UNITY_STATE
let run = 1
if (stateFile) {
  run = existsSync(stateFile) ? Number(readFileSync(stateFile, 'utf8')) + 1 : 1
  writeFileSync(stateFile, String(run))
}
const inputs = Object.keys(process.env).filter(k => /^(INPUT_|ACTIONS_RUNTIME_)/i.test(k)).length
console.log(`fake unity run=${run} args=${process.argv.slice(2).join(' ')}`)
console.log(`env keystore=${process.env.UNITY_KEYSTORE_PASS ?? '-'} inputs=${inputs}`)

switch (mode) {
  case 'license-then-ok':
    if (run === 1) {
      console.log('No valid Unity Editor license found. Please activate your license.')
      process.exit(1)
    }
    console.log('Build Finished, Result: Success.')
    break
  case 'license':
    console.log('[Licensing::Client] Error: Failed to connect to local IPC')
    process.exit(1)
    break
  case 'compile':
    console.log('No valid Unity Editor license found.')
    console.log('Assets/Scripts/Foo.cs(12,5): error CS0103: The name `x` does not exist')
    console.log('Scripts have compiler errors.')
    process.exit(1)
    break
  case 'result-failure':
    console.log('Build Finished, Result: Failure.')
    break
  case 'hang':
    console.log('Importing...')
    setInterval(() => undefined, 1000)
    break
  default:
    console.log('Build Finished, Result: Success.')
}
