/** The entrypoint for the action (bundled into dist/index.js). */
import { runAction } from '../../sdk/src/index.js'
import { run } from './main.js'

await runAction(run)
