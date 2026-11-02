// Stand-in for the Unity editor: behaviour is chosen with FAKE_UNITY_MODE, and
// FAKE_UNITY_STATE counts runs so a test can fail the first attempt only.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

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
