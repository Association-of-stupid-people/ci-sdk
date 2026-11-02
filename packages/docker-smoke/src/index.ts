/** The entrypoint for the action (bundled into dist/index.js), used for main and post. */
import * as core from '@actions/core'
import { runAction } from '../../sdk/src/index.js'
import { cleanup, run } from './main.js'

const isPost = core.getState('isPost') === 'true'

await runAction(isPost ? cleanup : run)
