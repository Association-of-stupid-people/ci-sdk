import * as core from '@actions/core'
import { InputError, errorMessage } from './errors.js'

/**
 * Entrypoint wrapper for an action's `main`: never leaves a floating promise,
 * turns any thrown error into `core.setFailed` (exit code 1) and logs the
 * stack only in debug mode.
 *
 * ```ts
 * // src/index.ts
 * await runAction(run)
 * ```
 */
export async function runAction(main: () => Promise<void> | void): Promise<void> {
  try {
    await main()
  } catch (err) {
    if (err instanceof Error && err.stack && !(err instanceof InputError)) core.debug(err.stack)
    core.setFailed(errorMessage(err))
  }
}
