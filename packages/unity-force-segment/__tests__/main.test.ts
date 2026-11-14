import { existsSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { run } from '../src/main.js'
import { ADJUST_CS, ADJUST_PATH, tempDir, writeTree } from './fixtures.js'

const CONFIG = `segments:
  - name: qa
    campaign: QA_X
  - name: us
    campaign: QA_US
    country: us
    debug: true
`

let project: string
let temp: string
let outputFile: string

/** Run the action with these inputs; resolves to the outputs it set. */
async function call(inputs: Record<string, string>): Promise<Record<string, string>> {
  vi.stubEnv('INPUT_PROJECT-PATH', project)
  for (const key of ['MODE', 'SEGMENT']) vi.stubEnv(`INPUT_${key}`, '')
  for (const [key, value] of Object.entries(inputs)) vi.stubEnv(`INPUT_${key.toUpperCase()}`, value)
  await writeFile(outputFile, '')
  await run()
  const out: Record<string, string> = {}
  // The runner file command uses os.EOL, which is CRLF on Windows.
  const text = (await readFile(outputFile, 'utf8')).split(/\r?\n/).join('\n')
  for (const m of text.matchAll(/^(.+)<<(ghadelimiter_[\w-]+)\n([\s\S]*?)\n\2$/gm)) {
    out[m[1]!] = m[3]!
  }
  return out
}

beforeEach(async () => {
  project = await tempDir()
  temp = await tempDir()
  outputFile = path.join(temp, 'output')
  vi.stubEnv('RUNNER_TEMP', temp)
  vi.stubEnv('GITHUB_OUTPUT', outputFile)
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  await writeTree(project, { [ADJUST_PATH]: ADJUST_CS, 'segment-ci.yml': CONFIG })
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(project, { recursive: true, force: true })
  await rm(temp, { recursive: true, force: true })
})

describe('apply', () => {
  it('applies a named segment, then restores', async () => {
    const out = await call({ segment: 'qa' })
    expect(out).toMatchObject({
      enabled: 'true',
      name: 'qa',
      campaign: 'QA_X',
      network: 'ForcedSegment',
      'tracker-name': 'ForcedSegment::QA_X',
      country: '',
      debug: 'false'
    })
    expect(JSON.parse(out['json']!)).toEqual({
      name: 'qa',
      campaign: 'QA_X',
      network: 'ForcedSegment',
      adgroup: '',
      creative: '',
      trackerName: 'ForcedSegment::QA_X',
      country: '',
      debug: false
    })
    expect(out['json']).not.toContain('\n')
    expect(out['patched']).toBe(`${ADJUST_PATH}\nAssets/Adjust/Scripts/AdjustCiForcedSegment.cs`)

    await call({ mode: 'restore' })
    expect(await readFile(path.join(project, ADJUST_PATH), 'utf8')).toBe(ADJUST_CS)
  })

  it('outputs debug for a development-build segment', async () => {
    await writeFile(
      path.join(project, 'segment-ci.yml'),
      'segments:\n  - {name: dev, campaign: "", debug: true}\n'
    )
    const out = await call({ segment: 'dev' })
    expect(out).toMatchObject({ enabled: 'true', name: 'dev', campaign: '', debug: 'true' })
    expect(JSON.parse(out['json']!)).toMatchObject({ debug: true })
    await call({ mode: 'restore' })
  })

  it.each(['', 'none'])('does nothing for segment %j', async segment => {
    expect(await call({ segment })).toEqual({ enabled: 'false' })
    expect(await readFile(path.join(project, ADJUST_PATH), 'utf8')).toBe(ADJUST_CS)
  })

  it.each(['default', 'all'])('rejects %s: only explicit names apply', async segment => {
    await expect(call({ segment })).rejects.toThrow(/unknown segment/)
  })

  it('fails for a missing file', async () => {
    await rm(path.join(project, 'segment-ci.yml'))
    await expect(call({ segment: 'qa' })).rejects.toThrow(/not found/)
  })

  it('fails for an unknown name', async () => {
    await expect(call({ segment: 'nope' })).rejects.toThrow(/unknown segment "nope"/)
  })
})

describe('list', () => {
  it.each([
    ['', ['qa', 'us']],
    ['all', ['qa', 'us']],
    ['none', []],
    ['us', ['us']],
    ['us, qa', ['qa', 'us']]
  ])('segment %j -> %j', async (segment, names) => {
    const out = await call({ mode: 'list', segment })
    expect(out['segments']).toBe(JSON.stringify(names))
    expect(out['count']).toBe(String(names.length))
    expect((JSON.parse(out['details']!) as { name: string }[]).map(d => d.name)).toEqual(names)
  })

  it('details carry campaign, network and country', async () => {
    const out = await call({ mode: 'list' })
    expect(JSON.parse(out['details']!)).toEqual([
      { name: 'qa', campaign: 'QA_X', network: 'ForcedSegment', country: '', debug: false },
      { name: 'us', campaign: 'QA_US', network: 'ForcedSegment', country: 'US', debug: true }
    ])
  })

  it('does not touch the project', async () => {
    await call({ mode: 'list' })
    expect(await readFile(path.join(project, ADJUST_PATH), 'utf8')).toBe(ADJUST_CS)
  })

  it('fails for an unknown name', async () => {
    await expect(call({ mode: 'list', segment: 'qa,nope' })).rejects.toThrow(/unknown segment/)
  })

  it('is empty, not an error, when the file is missing', async () => {
    await rm(path.join(project, 'segment-ci.yml'))
    expect(await call({ mode: 'list' })).toEqual({ segments: '[]', details: '[]', count: '0' })
  })

  it.each([
    ['every segment commented out', 'segments:\n  # - name: qa\n  #   campaign: QA_X\n'],
    ['only comments', '# nothing to build\n'],
    ['an empty list', 'segments: []']
  ])('is empty, not an error, with %s', async (_name, text) => {
    await writeFile(path.join(project, 'segment-ci.yml'), text)
    expect(await call({ mode: 'list' })).toEqual({ segments: '[]', details: '[]', count: '0' })
  })

  it('fails on an invalid file', async () => {
    await writeFile(path.join(project, 'segment-ci.yml'), 'default: a\nsegments: []')
    await expect(call({ mode: 'list' })).rejects.toThrow(/unknown top-level key "default"/)
  })
})

describe('restore', () => {
  it('without a state removes a leftover generated class and its meta', async () => {
    const cls = path.join(project, 'Assets/Adjust/Scripts/AdjustCiForcedSegment.cs')
    await writeFile(cls, '// Generated by ci-sdk unity-force-segment. CI build only')
    await writeFile(`${cls}.meta`, 'guid: 1')
    await call({ mode: 'restore' })
    expect(existsSync(cls)).toBe(false)
    expect(existsSync(`${cls}.meta`)).toBe(false)
  })

  it('without a state and nothing left succeeds', async () => {
    await expect(call({ mode: 'restore' })).resolves.toEqual({})
  })
})

describe('apply-runtime', () => {
  it('patches for the segments a stamp can make (not the debug ones), then restores', async () => {
    const out = await call({ mode: 'apply-runtime', segment: 'all' })
    expect(out['enabled']).toBe('true')
    expect(out['segments']).toBe('["qa"]')
    expect(out['patched']).toBe(`${ADJUST_PATH}\nAssets/Adjust/Scripts/AdjustCiForcedSegment.cs`)
    expect(await readFile(path.join(project, ADJUST_PATH), 'utf8')).not.toBe(ADJUST_CS)

    await call({ mode: 'restore' })
    expect(await readFile(path.join(project, ADJUST_PATH), 'utf8')).toBe(ADJUST_CS)
  })

  it('does nothing when every listed segment is a development build', async () => {
    const out = await call({ mode: 'apply-runtime', segment: 'us' })
    expect(out['enabled']).toBe('false')
    expect(out['segments']).toBe('[]')
    expect(await readFile(path.join(project, ADJUST_PATH), 'utf8')).toBe(ADJUST_CS)
  })

  it('does nothing without a segment file', async () => {
    await rm(path.join(project, 'segment-ci.yml'))
    const out = await call({ mode: 'apply-runtime' })
    expect(out['enabled']).toBe('false')
  })
})

describe('stamp', () => {
  it('refuses a development-build segment', async () => {
    await expect(call({ mode: 'stamp', segment: 'us' })).rejects.toThrow(/development build/)
  })

  it('needs a segment name', async () => {
    const out = await call({ mode: 'stamp', segment: '' })
    expect(out['enabled']).toBe('false')
  })
})
