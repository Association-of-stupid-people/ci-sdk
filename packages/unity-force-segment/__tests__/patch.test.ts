import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applyPatch,
  defaultStateFile,
  forcedSegmentSource,
  maskComments,
  removeStaleGenerated,
  restorePatch,
  type State
} from '../src/patch.js'
import { parseSegmentFile, type Segment } from '../src/segment.js'
import {
  ADJUST_CS,
  ADJUST_NO_GET_CS,
  ADJUST_ODD_CS,
  ADJUST_PATH,
  BOM,
  TRACKER_ASYNC_CS,
  TRACKER_PATH,
  TRACKER_SYNC_CS,
  crlf,
  tempDir,
  writeTree
} from './fixtures.js'

const M = '// ci-sdk unity-force-segment'
const CLASS_PATH = 'Assets/Adjust/Scripts/AdjustCiForcedSegment.cs'

function segment(extra = ''): Segment {
  return parseSegmentFile(
    `segments:\n  - name: qa\n    campaign: QA_IAPROAS\n    creative: 'c"1'${extra}`
  ).segments[0]!
}

let root: string
let stateFile: string

beforeEach(async () => {
  root = await tempDir()
  stateFile = path.join(await tempDir(), 'state', 'state.json')
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(path.dirname(path.dirname(stateFile)), { recursive: true, force: true })
})

const read = (rel: string): Promise<string> => readFile(path.join(root, rel), 'utf8')

describe('apply: Adjust facade', () => {
  it('inserts the wrapper as the first statement of each method', async () => {
    await writeTree(root, { [ADJUST_PATH]: ADJUST_CS })
    const patched = await applyPatch({ projectRoot: root, segment: segment(), stateFile })

    expect(patched).toEqual([ADJUST_PATH, CLASS_PATH])
    const expected = ADJUST_CS.replace(
      'InitSdk(AdjustConfig adjustConfig)\n        {\n',
      `InitSdk(AdjustConfig adjustConfig)\n        {\n            if (adjustConfig != null) { adjustConfig.AttributionChangedDelegate = AdjustCiForcedSegment.Wrap(adjustConfig.AttributionChangedDelegate); } ${M}\n`
    )
      .replace(
        'GetAttribution(Action<AdjustAttribution> attributionCallback)\n        {\n',
        `GetAttribution(Action<AdjustAttribution> attributionCallback)\n        {\n            attributionCallback = AdjustCiForcedSegment.Wrap(attributionCallback); ${M}\n`
      )
      .replace(
        'callbackWithTimeout)\n        {\n',
        `callbackWithTimeout)\n        {\n            callbackWithTimeout = AdjustCiForcedSegment.Wrap(callbackWithTimeout); ${M}\n`
      )
    expect(await read(ADJUST_PATH)).toBe(expected)
  })

  it('keeps CRLF line endings and the BOM', async () => {
    await writeTree(root, { [ADJUST_PATH]: BOM + crlf(ADJUST_CS) })
    await applyPatch({ projectRoot: root, segment: segment(), stateFile })
    const text = await read(ADJUST_PATH)
    expect(text.startsWith(BOM)).toBe(true)
    expect(text.replaceAll('\r\n', '')).not.toContain('\n')
    expect(text).toContain(`Wrap(attributionCallback); ${M}\r\n`)
  })

  it('captures the parameter names whatever the layout', async () => {
    await writeTree(root, { [ADJUST_PATH]: ADJUST_ODD_CS })
    await applyPatch({ projectRoot: root, segment: segment(), stateFile })
    const text = await read(ADJUST_PATH)
    expect(text).toContain(
      `\t\t{\n\t\t\tif (cfg != null) { cfg.AttributionChangedDelegate = AdjustCiForcedSegment.Wrap(cfg.AttributionChangedDelegate); } ${M}\n`
    )
    expect(text).toContain(`\t\t\tcb = AdjustCiForcedSegment.Wrap(cb); ${M}\n`)
    expect(text.match(new RegExp(M, 'g'))).toHaveLength(2)
  })

  it('fails when a required method is missing and changes nothing', async () => {
    await writeTree(root, { [ADJUST_PATH]: ADJUST_NO_GET_CS })
    await expect(applyPatch({ projectRoot: root, segment: segment(), stateFile })).rejects.toThrow(
      /Adjust SDK layout not supported.*GetAttribution/
    )
    expect(await read(ADJUST_PATH)).toBe(ADJUST_NO_GET_CS)
    expect(existsSync(stateFile)).toBe(false)
    expect(existsSync(path.join(root, CLASS_PATH))).toBe(false)
  })

  it('fails when there is no Adjust facade', async () => {
    await writeTree(root, { 'Assets/Other.cs': 'class A {}' })
    await expect(applyPatch({ projectRoot: root, segment: segment(), stateFile })).rejects.toThrow(
      /Adjust SDK not found/
    )
  })

  it('fails when there are several facades', async () => {
    await writeTree(root, { [ADJUST_PATH]: ADJUST_CS, 'Assets/Copy/Adjust.cs': ADJUST_CS })
    await expect(applyPatch({ projectRoot: root, segment: segment(), stateFile })).rejects.toThrow(
      /Several Adjust facades/
    )
  })

  it('picks class Adjust over the platform layers that declare the same InitSdk', async () => {
    const platform = (name: string): string =>
      ADJUST_CS.replace(/\bclass\s+Adjust\b/, `class ${name}`)
    await writeTree(root, {
      [ADJUST_PATH]: ADJUST_CS,
      'Assets/Adjust/Scripts/AdjustAndroid.cs': platform('AdjustAndroid'),
      'Assets/Adjust/Scripts/AdjustiOS.cs': platform('AdjustiOS')
    })
    await applyPatch({ projectRoot: root, segment: segment(), stateFile })
    expect(await read(ADJUST_PATH)).toContain('AdjustCiForcedSegment.Wrap(')
    expect(await read('Assets/Adjust/Scripts/AdjustAndroid.cs')).toBe(platform('AdjustAndroid'))
    expect(await read('Assets/Adjust/Scripts/AdjustiOS.cs')).toBe(platform('AdjustiOS'))
  })

  it('ignores commented-out signatures', async () => {
    const text = ADJUST_CS.replace(
      'public static void InitSdk(',
      '// public static void InitSdk(AdjustConfig old) {\n        /* public static void InitSdk(AdjustConfig x) { */\n        public static void InitSdk('
    )
    await writeTree(root, { [ADJUST_PATH]: text })
    await applyPatch({ projectRoot: root, segment: segment(), stateFile })
    const patched = await read(ADJUST_PATH)
    expect(patched).toContain('if (adjustConfig != null)')
    expect(patched).not.toContain('if (old != null)')
    expect(patched).not.toContain('if (x != null)')
  })

  it('fails on a GetAttributionWithTimeout it cannot read, changing nothing', async () => {
    const text = ADJUST_CS.replace(
      /GetAttributionWithTimeout\s*\(\s*int\s/,
      'GetAttributionWithTimeout(long '
    )
    await writeTree(root, { [ADJUST_PATH]: text })
    await expect(applyPatch({ projectRoot: root, segment: segment(), stateFile })).rejects.toThrow(
      /GetAttributionWithTimeout in an unknown form/
    )
    expect(await read(ADJUST_PATH)).toBe(text)
  })

  it('patches every GetAttributionWithTimeout overload, and fails when one is unreadable', async () => {
    const overload = (type: string): string =>
      `public static void GetAttributionWithTimeout(${type} t, Action<AdjustAttribution> cb2)\n        {\n        }\n\n        public static void InitSdk(`
    const readable = ADJUST_CS.replace('public static void InitSdk(', overload('int'))
    await writeTree(root, { [ADJUST_PATH]: readable })
    await applyPatch({ projectRoot: root, segment: segment(), stateFile })
    expect(await read(ADJUST_PATH)).toContain(`cb2 = AdjustCiForcedSegment.Wrap(cb2); ${M}`)
    expect(await restorePatch(stateFile)).toBe(true)

    const unreadable = ADJUST_CS.replace('public static void InitSdk(', overload('long'))
    await writeTree(root, { [ADJUST_PATH]: unreadable })
    await expect(applyPatch({ projectRoot: root, segment: segment(), stateFile })).rejects.toThrow(
      /GetAttributionWithTimeout in an unknown form/
    )
    expect(await read(ADJUST_PATH)).toBe(unreadable)
  })

  it('ignores Library, Temp, obj and hidden folders', async () => {
    await writeTree(root, {
      [ADJUST_PATH]: ADJUST_CS,
      'Assets/Library/Adjust.cs': ADJUST_CS,
      'Assets/Temp/Adjust.cs': ADJUST_CS,
      'Assets/obj/Adjust.cs': ADJUST_CS,
      'Assets/.hidden/Adjust.cs': ADJUST_CS
    })
    await applyPatch({ projectRoot: root, segment: segment(), stateFile })
    expect(await read('Assets/Library/Adjust.cs')).toBe(ADJUST_CS)
  })

  it('fails on a project without Assets', async () => {
    await expect(applyPatch({ projectRoot: root, segment: segment(), stateFile })).rejects.toThrow(
      /No Assets folder/
    )
  })

  it('refuses a facade that is already patched', async () => {
    await writeTree(root, { [ADJUST_PATH]: ADJUST_CS })
    await applyPatch({ projectRoot: root, segment: segment(), stateFile })
    await rm(stateFile)
    await expect(applyPatch({ projectRoot: root, segment: segment(), stateFile })).rejects.toThrow(
      /already patched; run mode: restore first/
    )
  })
})

describe('apply: generated class', () => {
  it('contains the forced values, escaped', async () => {
    await writeTree(root, { [ADJUST_PATH]: ADJUST_CS })
    await applyPatch({ projectRoot: root, segment: segment(), stateFile })
    const text = await read(CLASS_PATH)
    expect(text).toContain('namespace AdjustSdk')
    expect(text).toContain('internal static class AdjustCiForcedSegment')
    expect(text).toContain('private const string ForcedCampaign = "QA_IAPROAS";')
    expect(text).toContain('private const string ForcedCreative = "c\\"1";')
    expect(text).toContain('private const string ForcedTrackerName = "ForcedSegment::QA_IAPROAS";')
    expect(text).toContain('public static Action<AdjustAttribution> Wrap(')
    expect(text).toContain('TrackerToken = real?.TrackerToken ?? ""')
    expect(text).toContain('ClickLabel = ""')
    expect(text).toContain('Debug.Log("[ci-sdk] forced Adjust attribution')
    expect(text.split('\n')[0]).toMatch(/Generated by ci-sdk unity-force-segment.*never commit/)
  })

  it('escapes backslashes', () => {
    const s = { ...segment(), campaign: 'a\\b' }
    expect(forcedSegmentSource(s)).toContain('ForcedCampaign = "a\\\\b";')
  })

  it('overwrites a stale class and keeps its meta', async () => {
    await writeTree(root, {
      [ADJUST_PATH]: ADJUST_CS,
      [CLASS_PATH]: '// Generated by ci-sdk unity-force-segment\nstale',
      [`${CLASS_PATH}.meta`]: 'guid: 1'
    })
    await applyPatch({ projectRoot: root, segment: segment(), stateFile })
    expect(await read(CLASS_PATH)).toContain('ForcedCampaign')
    expect(await read(`${CLASS_PATH}.meta`)).toBe('guid: 1')
  })
})

describe('apply: country', () => {
  it('makes a sync source return the country', async () => {
    await writeTree(root, { [ADJUST_PATH]: ADJUST_CS, [TRACKER_PATH]: TRACKER_SYNC_CS })
    const patched = await applyPatch({
      projectRoot: root,
      segment: segment('\n    country: us'),
      stateFile
    })
    expect(patched).toContain(TRACKER_PATH)
    expect(await read(TRACKER_PATH)).toBe(
      TRACKER_SYNC_CS.replace(
        'GetIpCountryCodeAsync()\n        {\n',
        `GetIpCountryCodeAsync()\n        {\n            return System.Threading.Tasks.Task.FromResult("US"); ${M}\n`
      )
    )
  })

  it('returns a plain value from an async source', async () => {
    await writeTree(root, { [ADJUST_PATH]: ADJUST_CS, [TRACKER_PATH]: TRACKER_ASYNC_CS })
    await applyPatch({ projectRoot: root, segment: segment('\n    country: VN'), stateFile })
    expect(await read(TRACKER_PATH)).toContain(`        {\n            return "VN"; ${M}\n`)
  })

  it('leaves the source alone without a country', async () => {
    await writeTree(root, { [ADJUST_PATH]: ADJUST_CS, [TRACKER_PATH]: TRACKER_SYNC_CS })
    await applyPatch({ projectRoot: root, segment: segment(), stateFile })
    expect(await read(TRACKER_PATH)).toBe(TRACKER_SYNC_CS)
  })

  it('patches a country source inside the facade file on top of the facade edits', async () => {
    const source = /public static Task<string> GetIpCountryCodeAsync\(\)\s*\{[^}]*\}/.exec(
      TRACKER_SYNC_CS
    )![0]
    const text = ADJUST_CS.replace(
      'public static void InitSdk(',
      `${source}\n\n        public static void InitSdk(`
    )
    await writeTree(root, { [ADJUST_PATH]: text })
    await applyPatch({ projectRoot: root, segment: segment('\n    country: JP'), stateFile })
    const patched = await read(ADJUST_PATH)
    expect(patched).toContain('Task.FromResult("JP")')
    expect(patched.match(new RegExp(M, 'g'))).toHaveLength(4)
  })

  it('ignores a commented-out country source', async () => {
    await writeTree(root, {
      [ADJUST_PATH]: ADJUST_CS,
      [TRACKER_PATH]: TRACKER_SYNC_CS,
      'Assets/Old.cs': '/*\npublic static Task<string> GetIpCountryCodeAsync()\n{\n*/'
    })
    await applyPatch({ projectRoot: root, segment: segment('\n    country: US'), stateFile })
    expect(await read('Assets/Old.cs')).not.toContain(M)
  })

  it('fails when a country is set but no source exists, changing nothing', async () => {
    await writeTree(root, { [ADJUST_PATH]: ADJUST_CS })
    await expect(
      applyPatch({ projectRoot: root, segment: segment('\n    country: US'), stateFile })
    ).rejects.toThrow(
      'country is set but no known IP country source (GetIpCountryCodeAsync) was found'
    )
    expect(await read(ADJUST_PATH)).toBe(ADJUST_CS)
  })
})

describe('restore', () => {
  it('puts every byte back and removes the added files and their meta', async () => {
    const adjust = Buffer.from(BOM + crlf(ADJUST_CS), 'utf8')
    const tracker = Buffer.from(TRACKER_ASYNC_CS, 'utf8')
    await writeTree(root, { [ADJUST_PATH]: adjust, [TRACKER_PATH]: tracker })
    await applyPatch({
      projectRoot: root,
      segment: segment('\n    country: US'),
      stateFile
    })
    // Unity creates the meta during the build.
    await writeFile(path.join(root, `${CLASS_PATH}.meta`), 'guid: 1')

    expect(await restorePatch(stateFile)).toBe(true)
    expect(await readFile(path.join(root, ADJUST_PATH))).toEqual(adjust)
    expect(await readFile(path.join(root, TRACKER_PATH))).toEqual(tracker)
    expect(existsSync(path.join(root, CLASS_PATH))).toBe(false)
    expect(existsSync(path.join(root, `${CLASS_PATH}.meta`))).toBe(false)
    expect(existsSync(stateFile)).toBe(false)
  })

  it('restores a stale class that was not ours', async () => {
    await writeTree(root, { [ADJUST_PATH]: ADJUST_CS, [CLASS_PATH]: 'mine' })
    await applyPatch({ projectRoot: root, segment: segment(), stateFile })
    await restorePatch(stateFile)
    expect(await read(CLASS_PATH)).toBe('mine')
  })

  it('writes the state before the first change', async () => {
    await writeTree(root, { [ADJUST_PATH]: ADJUST_CS })
    await applyPatch({ projectRoot: root, segment: segment(), stateFile })
    const state = JSON.parse(await readFile(stateFile, 'utf8')) as State
    expect(state.files.map(f => f.path)).toEqual([ADJUST_PATH])
    expect(state.added).toEqual([CLASS_PATH])
    expect(Buffer.from(state.files[0]!.original, 'base64').toString()).toBe(ADJUST_CS)
  })

  it('is safe after a half-done apply', async () => {
    await writeTree(root, { [ADJUST_PATH]: ADJUST_CS })
    await applyPatch({ projectRoot: root, segment: segment(), stateFile })
    // Crash simulation: the class was never written and the facade is back to original already.
    await rm(path.join(root, CLASS_PATH))
    await writeFile(path.join(root, ADJUST_PATH), ADJUST_CS)
    expect(await restorePatch(stateFile)).toBe(true)
    expect(await read(ADJUST_PATH)).toBe(ADJUST_CS)
  })

  it('does nothing without a state', async () => {
    expect(await restorePatch(stateFile)).toBe(false)
  })

  it('drops an unreadable state or one whose project is gone, so apply is not blocked', async () => {
    await writeTree(root, { [ADJUST_PATH]: ADJUST_CS })
    await mkdir(path.dirname(stateFile), { recursive: true })
    await writeFile(stateFile, '{"version": 1, "ro')
    expect(await restorePatch(stateFile)).toBe(false)
    expect(existsSync(stateFile)).toBe(false)

    const gone: State = { version: 1, root: path.join(root, 'gone'), files: [], added: ['x.cs'] }
    await writeFile(stateFile, JSON.stringify(gone))
    expect(await restorePatch(stateFile)).toBe(false)
    expect(existsSync(stateFile)).toBe(false)

    await applyPatch({ projectRoot: root, segment: segment(), stateFile })
    expect(await restorePatch(stateFile)).toBe(true)
    expect(await read(ADJUST_PATH)).toBe(ADJUST_CS)
  })

  it('apply first restores a state left by an unrestored job', async () => {
    await writeTree(root, { [ADJUST_PATH]: ADJUST_CS })
    await applyPatch({ projectRoot: root, segment: segment(), stateFile })
    await applyPatch({ projectRoot: root, segment: segment(), stateFile })
    await restorePatch(stateFile)
    expect(await read(ADJUST_PATH)).toBe(ADJUST_CS)
  })
})

describe('removeStaleGenerated', () => {
  it('deletes a leftover generated class and its meta, and nothing else', async () => {
    await writeTree(root, {
      [ADJUST_PATH]: ADJUST_CS,
      [CLASS_PATH]: forcedSegmentSource(segment()),
      [`${CLASS_PATH}.meta`]: 'guid: 1',
      'Assets/Mine/AdjustCiForcedSegment.cs': '// handwritten',
      'Assets/Library/Adjust/AdjustCiForcedSegment.cs': forcedSegmentSource(segment())
    })
    expect(await removeStaleGenerated(root)).toEqual([CLASS_PATH])
    expect(existsSync(path.join(root, CLASS_PATH))).toBe(false)
    expect(existsSync(path.join(root, `${CLASS_PATH}.meta`))).toBe(false)
    expect(await read('Assets/Mine/AdjustCiForcedSegment.cs')).toBe('// handwritten')
    expect(await read(ADJUST_PATH)).toBe(ADJUST_CS)
  })

  it('finds nothing in a clean project or without Assets', async () => {
    expect(await removeStaleGenerated(root)).toEqual([])
    await writeTree(root, { [ADJUST_PATH]: ADJUST_CS })
    expect(await removeStaleGenerated(root)).toEqual([])
  })
})

describe('defaultStateFile', () => {
  it('uses RUNNER_TEMP when set, else the OS temp dir', () => {
    expect(defaultStateFile({ RUNNER_TEMP: '/rt' })).toBe(
      path.join('/rt', 'ci-sdk-unity-force-segment', 'state.json')
    )
    expect(defaultStateFile({})).toContain('ci-sdk-unity-force-segment')
  })
})

describe('maskComments', () => {
  it.each([
    ['a line comment', 'x // c\ny', 'x     \ny'],
    ['a block comment over lines', 'a /* b\r\nc */ d', 'a     \r\n     d'],
    ['a // inside a string', '"http://x" // c', '"http://x"     '],
    ['a quote char literal', `'"' // c`, `'"'     `],
    ['a verbatim string', '@"C:\\" /* c */', '@"C:\\"        '],
    ['an @$ verbatim string', '@$"C:\\" /* c */', '@$"C:\\"        '],
    ['a $@ verbatim string', '$@"C:\\" /* c */', '$@"C:\\"        ']
  ])('blanks %s, keeping the length', (_name, text, masked) => {
    expect(maskComments(text)).toBe(masked)
  })
})
