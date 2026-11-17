import * as core from '@actions/core'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import {
  CiError,
  errorMessage,
  input,
  readInputs,
  retry,
  type RetryOptions
} from '../../sdk/src/index.js'
import {
  DashClient,
  DashError,
  cancelUpload,
  ensureFolder,
  fileLink,
  finishUpload,
  folderSegments,
  mimeTypeFor,
  openUpload,
  putBytes,
  type Fetch,
  type UploadOptions
} from './dash.js'

export async function run(
  fetchImpl: Fetch = fetch,
  retryDelay: string | number = '5s'
): Promise<void> {
  const cfg = readInputs({
    key: input.string({ required: true, secret: true }),
    area: input.string({ required: true }),
    folder: input.string(),
    file: input.string({ required: true }),
    name: input.string(),
    mimeType: input.string({ name: 'mime-type' }),
    linkTemplate: input.string({
      name: 'link-template',
      default: 'https://dash.blackgems.org/api/files-tep?id={id}'
    }),
    url: input.string({ default: 'https://dash.blackgems.org/mcp' }),
    attempts: input.number({ default: 3, min: 1, max: 10, integer: true })
  })
  if (!/^[a-z]+:[A-Za-z0-9_-]+$/.test(cfg.area)) {
    throw new CiError('E_INPUT', `area must look like ws:19 (got ${cfg.area})`)
  }

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

  const dash = new DashClient(cfg.url, cfg.key, fetchImpl)
  const retryOptions = (what: string): RetryOptions => ({
    attempts: cfg.attempts,
    minDelay: retryDelay,
    retryIf: (err: unknown) => !(err instanceof DashError && err.permanent),
    onRetry: (err: unknown, attempt: number) =>
      core.warning(`${what} attempt ${attempt} failed, retrying: ${errorMessage(err)}`)
  })

  const segments = folderSegments(cfg.folder ?? '')
  const folderId = await retry(
    async () => ensureFolder(dash, cfg.area, segments),
    retryOptions(`dash folder ${segments.join('/')}`)
  )

  const options: UploadOptions = {
    dash,
    area: cfg.area,
    folderId,
    file,
    name,
    size,
    mimeType,
    fetchImpl
  }
  const where = `${cfg.area}${segments.length ? `/${segments.join('/')}` : ''}`
  core.info(`Upload ${name} (${(size / 1048576).toFixed(2)} MB) to dash ${where}`)
  // A failed PUT opens a new session on the next attempt (the old one is dropped).
  const session = await retry(
    async () => {
      const opened = await openUpload(options)
      try {
        await putBytes(options, opened)
      } catch (err) {
        await cancelUpload(dash, opened)
        throw err
      }
      return opened
    },
    retryOptions(`dash upload of ${name}`)
  )
  // The bytes are stored: finishing is retried on its own (it is idempotent), never re-uploaded.
  const id = await retry(
    async () => finishUpload(options, session),
    retryOptions(`dash upload finish of ${name}`)
  )
  const link = fileLink(cfg.linkTemplate, id)

  core.setOutput('id', id)
  core.setOutput('link', link)
  core.setOutput('name', name)
  core.setOutput('size', String(size))
  core.setOutput('folder-id', folderId ?? '')
  core.info(`Uploaded: ${link}`)
  // The file is on dash: a summary problem must not turn that into a failure.
  if (process.env['GITHUB_STEP_SUMMARY']) {
    try {
      await core.summary.addHeading('Uploaded to dash', 3).addLink(name, link).write()
    } catch (err) {
      core.warning(`Job summary not written: ${errorMessage(err)}`)
    }
  }
}
