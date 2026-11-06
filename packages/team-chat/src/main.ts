import * as core from '@actions/core'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { InputError, input, readInputs } from '../../sdk/src/index.js'
import { buildPayload, checkLimits } from './payload.js'
import { parseReport } from './report.js'
import { sendPayload, webhookKeyForms, webhookLabel, type SendOptions } from './send.js'

export async function run(sendOptions: SendOptions = {}): Promise<void> {
  const cfg = readInputs({
    webhookUrl: input.string({ name: 'webhook-url', secret: true }),
    report: input.string(),
    reportFile: input.string({ name: 'report-file' }),
    payloadFile: input.string({ name: 'payload-file' }),
    dryRun: input.boolean({ name: 'dry-run', default: false }),
    attempts: input.number({ default: 3, min: 1, max: 5, integer: true })
  })
  // The input is masked whole; the key alone too, should a response or an error echo it.
  for (const key of cfg.webhookUrl ? webhookKeyForms(cfg.webhookUrl) : []) core.setSecret(key)
  if (!cfg.report === !cfg.reportFile) {
    throw new InputError([
      { input: 'report', message: 'set exactly one of report and report-file' }
    ])
  }
  const report = parseReport(cfg.report ?? (await readFile(path.resolve(cfg.reportFile!), 'utf8')))
  const payload = buildPayload(report)
  const problems = checkLimits(payload)
  if (problems.length > 0) core.warning(`Chat payload over a webhook limit: ${problems.join('; ')}`)

  core.setOutput('text', payload.text)
  core.setOutput('sent', 'false')
  if (cfg.payloadFile) {
    const file = path.resolve(cfg.payloadFile)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`)
    core.info(`Payload written to ${file}`)
  }
  core.info(`Chat message: ${payload.text}`)
  if (cfg.dryRun) {
    core.notice('dry-run: chat message not sent')
    return
  }
  if (!cfg.webhookUrl) {
    core.notice('webhook-url is empty, no chat message sent')
    return
  }

  // A chat problem is a warning: it never fails the build it reports on.
  const result = await sendPayload(cfg.webhookUrl, payload, {
    attempts: cfg.attempts,
    log: core.info,
    ...sendOptions
  })
  const where = webhookLabel(cfg.webhookUrl)
  if (result.status !== undefined) core.setOutput('status', String(result.status))
  if (result.ok) {
    core.info(`Posted to the chat webhook (${where})`)
    core.setOutput('sent', 'true')
  } else {
    core.warning(
      `Chat message not sent (${where}, ${result.attempts} tries): ${result.error ?? 'unknown error'}`
    )
  }
}
