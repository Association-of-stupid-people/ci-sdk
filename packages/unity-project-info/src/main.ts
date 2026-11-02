import * as core from '@actions/core'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { input, readInputs } from '../../sdk/src/index.js'
import { parseProjectSettings } from './project-settings.js'

export async function run(): Promise<void> {
  const { file } = readInputs({
    file: input.string({ default: 'ProjectSettings/ProjectSettings.asset' })
  })
  const settingsPath = path.resolve(process.cwd(), core.toPlatformPath(file))
  core.info(`Read project settings from ${settingsPath}`)

  const info = parseProjectSettings(await readFile(settingsPath, 'utf8'))

  core.setOutput('company', info.companyName)
  core.setOutput('name', info.productName)
  core.setOutput('version', info.bundleVersion)
  core.setOutput('web-sw', info.webScreenWidth)
  core.setOutput('web-sh', info.webScreenHeight)
  core.info(`${info.companyName} / ${info.productName} v${info.bundleVersion}`)
}
