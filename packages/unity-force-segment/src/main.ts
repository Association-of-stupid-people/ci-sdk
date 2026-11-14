import * as core from '@actions/core'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { InputError, findJava, input, readInputs, unityJava } from '../../sdk/src/index.js'
import { applyPatch, defaultStateFile, removeStaleGenerated, restorePatch } from './patch.js'
import { applyRuntimePatch } from './runtime.js'
import {
  listSegments,
  parseSegmentFile,
  resolveSegment,
  type Segment,
  type SegmentFile
} from './segment.js'
import { defaultDebugKeystore, defaultSdkLookup, findApksigner, stampApk } from './stamp.js'

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
    mode: input.oneOf(['apply', 'restore', 'list', 'apply-runtime', 'stamp'], { default: 'apply' }),
    config: input.string({ default: 'segment-ci.yml' }),
    segment: input.string({ default: '' }),
    projectPath: input.string({ name: 'project-path', default: '.' }),
    apk: input.string({ default: '' }),
    output: input.string({ default: '' }),
    editorPath: input.string({ name: 'editor-path', default: '' }),
    javaPath: input.string({ name: 'java-path', default: '' }),
    androidSdk: input.string({ name: 'android-sdk', default: '' }),
    keystore: input.string({ default: '' }),
    keystorePassword: input.string({ name: 'keystore-password', default: '' }),
    keyAlias: input.string({ name: 'key-alias', default: '' }),
    keyPassword: input.string({ name: 'key-password', default: '' })
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

  if (cfg.mode === 'apply-runtime') {
    // The segments a stamp can make: the listed ones without debug (a development build needs its
    // own Unity build).
    const names = file ? listSegments(file, cfg.segment || 'all') : []
    const stampable = names
      .map(name => file!.segments.find(x => x.name === name)!)
      .filter(s => !s.debug)
    core.setOutput('segments', JSON.stringify(stampable.map(s => s.name)))
    if (stampable.length === 0) {
      core.notice('unity-force-segment: no segment to stamp, the runtime patch is not applied')
      core.setOutput('enabled', 'false')
      return
    }
    const country = stampable.some(s => s.country !== undefined)
    const patched = await applyRuntimePatch({ projectRoot, country, stateFile: defaultStateFile() })
    core.info(`Runtime segment patch for ${stampable.map(s => s.name).join(', ')}`)
    for (const changed of patched) core.info(`  patched ${changed}`)
    core.setOutput('enabled', 'true')
    core.setOutput('patched', patched.join('\n'))
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

  if (cfg.mode === 'stamp') {
    if (segment.debug) {
      throw new InputError([
        {
          input: 'segment',
          message: `${segment.name} is a development build (debug: true): build it, a stamp cannot make it`
        }
      ])
    }
    const base = path.resolve(cfg.apk || 'Builds/check.apk')
    const output = path.resolve(cfg.output || `Builds/segment-${segment.name}.apk`)
    const editorPath = cfg.editorPath || undefined
    // The editor's OpenJDK before JAVA_HOME: a runner's JAVA_HOME may be a JDK too old for apksigner.
    const editorJava = editorPath ? unityJava(editorPath, process.platform) : undefined
    const java = findJava({
      javaPath: cfg.javaPath || undefined,
      javaHome: editorJava && existsSync(editorJava) ? undefined : process.env['JAVA_HOME'],
      editorPath,
      platform: process.platform,
      exists: existsSync
    })
    const apksigner = findApksigner(defaultSdkLookup(cfg.androidSdk || undefined, editorPath))
    const debugKey = defaultDebugKeystore()
    const keystore = {
      file: cfg.keystore || debugKey.file,
      password: cfg.keystorePassword || debugKey.password,
      alias: cfg.keyAlias || debugKey.alias,
      keyPassword: cfg.keyPassword || cfg.keystorePassword || debugKey.keyPassword
    }
    if (cfg.keystorePassword) core.setSecret(cfg.keystorePassword)
    if (cfg.keyPassword) core.setSecret(cfg.keyPassword)
    core.info(`java: ${java.path} (${java.source}), apksigner: ${apksigner}`)
    const { size } = await stampApk({ base, output, segment, java: java.path, apksigner, keystore })
    core.info(
      `Segment "${segment.name}" (campaign "${segment.campaign}"): ${output} (${size} bytes)`
    )
    setSegmentOutputs(segment)
    core.setOutput('apk-path', output)
    core.setOutput('size', String(size))
    return
  }

  const patched = await applyPatch({ projectRoot, segment, stateFile: defaultStateFile() })
  const kind = segment.debug ? ', development build' : ''
  core.info(`Forcing segment "${segment.name}" (campaign "${segment.campaign}"${kind})`)
  for (const changed of patched) core.info(`  patched ${changed}`)

  setSegmentOutputs(segment)
  core.setOutput('patched', patched.join('\n'))
}

function setSegmentOutputs(segment: Segment): void {
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
}
