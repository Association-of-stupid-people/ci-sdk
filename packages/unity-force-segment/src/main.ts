import * as core from '@actions/core'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { InputError, input, readInputs } from '../../sdk/src/index.js'
import { applyPatch, defaultStateFile, removeStaleGenerated, restorePatch } from './patch.js'
import { listSegments, parseSegmentFile, resolveSegment, type SegmentFile } from './segment.js'

/** The config file, or undefined when it does not exist (every other error is thrown). */
async function readConfig(file: string, label: string): Promise<SegmentFile | undefined> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
  return parseSegmentFile(text, label)
}

async function restore(projectPath: string, stateFile: string): Promise<void> {
  if (await restorePatch(stateFile)) {
    core.info('Restored the files patched by apply')
    return
  }
  // No state (fresh RUNNER_TEMP): a hard-killed earlier job may have left the generated class.
  const removed = await removeStaleGenerated(projectPath)
  for (const file of removed) core.info(`Removed leftover ${file}`)
  if (removed.length === 0) core.notice('unity-force-segment: nothing to restore')
}

function setNoSegments(): void {
  core.setOutput('segments', '[]')
  core.setOutput('details', '[]')
  core.setOutput('count', '0')
}

export async function run(): Promise<void> {
  const cfg = readInputs({
    mode: input.oneOf(['apply', 'restore', 'list'], { default: 'apply' }),
    config: input.string({ default: 'segment-ci.yml' }),
    segment: input.string({ default: '' }),
    projectPath: input.string({ name: 'project-path', default: '.' })
  })

  if (cfg.mode === 'restore') {
    await restore(cfg.projectPath, defaultStateFile())
    return
  }

  const projectRoot = path.resolve(cfg.projectPath)
  const configFile = path.resolve(projectRoot, cfg.config)
  const file = await readConfig(configFile, cfg.config)

  if (cfg.mode === 'list') {
    if (!file) {
      core.notice(`unity-force-segment: ${cfg.config} not found, no segments`)
      setNoSegments()
      return
    }
    const names = listSegments(file, cfg.segment)
    core.info(`Segments: ${names.join(', ') || '(none)'}`)
    core.setOutput('segments', JSON.stringify(names))
    // What a build table needs before any build (e.g. a chat message when the build starts).
    const details = names.map(name => {
      const s = file.segments.find(x => x.name === name)!
      return {
        name,
        campaign: s.campaign,
        network: s.network,
        country: s.country ?? '',
        debug: s.debug
      }
    })
    core.setOutput('details', JSON.stringify(details))
    core.setOutput('count', String(names.length))
    return
  }

  const selector = cfg.segment.trim()
  if (selector === '' || selector.toLowerCase() === 'none') {
    core.notice('unity-force-segment: no segment requested, nothing applied')
    core.setOutput('enabled', 'false')
    return
  }
  if (!file) throw new InputError([{ input: 'config', message: `${configFile} not found` }])

  const segment = resolveSegment(file, selector)
  if (!segment) throw new Error('unreachable: a named segment always resolves')

  const patched = await applyPatch({ projectRoot, segment, stateFile: defaultStateFile() })
  const kind = segment.debug ? ', development build' : ''
  core.info(`Forcing segment "${segment.name}" (campaign "${segment.campaign}"${kind})`)
  for (const changed of patched) core.info(`  patched ${changed}`)

  core.setOutput('enabled', 'true')
  core.setOutput('name', segment.name)
  core.setOutput('campaign', segment.campaign)
  core.setOutput('network', segment.network)
  core.setOutput('adgroup', segment.adgroup)
  core.setOutput('creative', segment.creative)
  core.setOutput('tracker-name', segment.trackerName)
  core.setOutput('country', segment.country ?? '')
  core.setOutput('debug', String(segment.debug))
  core.setOutput('json', JSON.stringify({ ...segment, country: segment.country ?? '' }))
  core.setOutput('patched', patched.join('\n'))
}
