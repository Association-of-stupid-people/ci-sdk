import * as core from '@actions/core'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { CiError, errorMessage, input, readInputs, retry } from '../../sdk/src/index.js'
import {
  DriveError,
  getAccessToken,
  mimeTypeFor,
  parseServiceAccountKey,
  uploadFile,
  type Fetch
} from './drive.js'

export async function run(
  fetchImpl: Fetch = fetch,
  retryDelay: string | number = '5s'
): Promise<void> {
  const cfg = readInputs({
    serviceAccountKey: input.string({ name: 'service-account-key', required: true, secret: true }),
    folderId: input.string({ name: 'folder-id', required: true }),
    file: input.string({ required: true }),
    name: input.string(),
    mimeType: input.string({ name: 'mime-type' }),
    attempts: input.number({ default: 3, min: 1, max: 10, integer: true })
  })

  const file = path.resolve(core.toPlatformPath(cfg.file))
  let size: number
  try {
    const info = await stat(file)
    if (!info.isFile()) throw new Error('not a file')
    size = info.size
  } catch (err) {
    throw new CiError('E_INPUT', `file ${cfg.file} cannot be read: ${errorMessage(err)}`)
  }
  const name = cfg.name || path.basename(file)
  const mimeType = cfg.mimeType || mimeTypeFor(name)

  const key = parseServiceAccountKey(cfg.serviceAccountKey)
  const options = {
    attempts: cfg.attempts,
    minDelay: retryDelay,
    retryIf: (err: unknown) => !(err instanceof DriveError && err.permanent)
  }
  const token = await retry(async () => getAccessToken(key, fetchImpl), {
    ...options,
    onRetry: (err, attempt) =>
      core.warning(`Google token request attempt ${attempt} failed, retrying: ${errorMessage(err)}`)
  })
  core.setSecret(token)

  core.info(`Upload ${name} (${(size / 1048576).toFixed(2)} MB) to Drive as ${key.clientEmail}`)
  const uploaded = await retry(
    async () =>
      uploadFile({ token, folderId: cfg.folderId, file, name, size, mimeType, fetchImpl }),
    {
      ...options,
      onRetry: (err, attempt) =>
        core.warning(
          `Drive upload of ${name} attempt ${attempt} failed, retrying: ${errorMessage(err)}`
        )
    }
  )

  core.setOutput('id', uploaded.id)
  core.setOutput('link', uploaded.link)
  core.setOutput('name', uploaded.name)
  core.setOutput('size', String(size))
  core.info(`Uploaded: ${uploaded.link}`)
  // The file is on Drive: a summary problem must not turn that into a failure.
  if (process.env['GITHUB_STEP_SUMMARY']) {
    try {
      await core.summary
        .addHeading('Uploaded to Drive', 3)
        .addLink(uploaded.name, uploaded.link)
        .write()
    } catch (err) {
      core.warning(`Job summary not written: ${errorMessage(err)}`)
    }
  }
}
