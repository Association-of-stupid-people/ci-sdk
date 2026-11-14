import { existsSync } from 'node:fs'
import { readFile, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeStaleGenerated, restorePatch } from '../src/patch.js'
import {
  SEGMENT_ENTRY,
  applyRuntimePatch,
  runtimeCountrySource,
  runtimeSegmentSource,
  segmentFileText
} from '../src/runtime.js'
import { parseSegmentFile } from '../src/segment.js'
import {
  ADJUST_CS,
  ADJUST_PATH,
  TRACKER_ASYNC_CS,
  TRACKER_PATH,
  TRACKER_SYNC_CS,
  tempDir,
  writeTree
} from './fixtures.js'

const M = '// ci-sdk unity-force-segment'
const CLASS_PATH = 'Assets/Adjust/Scripts/AdjustCiForcedSegment.cs'
const TRACKER_DIR = path.posix.dirname(TRACKER_PATH)

let root: string
let stateFile: string
beforeEach(async () => {
  root = await tempDir()
  stateFile = path.join(await tempDir(), 'state.json')
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(path.dirname(stateFile), { recursive: true, force: true })
})

const read = (rel: string): Promise<string> => readFile(path.join(root, rel), 'utf8')
const countryClass = async (): Promise<string | undefined> =>
  (await readdir(path.join(root, TRACKER_DIR))).find(f => f.startsWith('CiSdkSegmentCountry'))

describe('segmentFileText', () => {
  it('writes a header and one key=value line per field, country only when set', () => {
    const [plain, us] = parseSegmentFile(
      'segments:\n  - name: qa\n    campaign: C1\n  - name: us\n    campaign: C2\n    network: AppLovin\n    country: us\n'
    ).segments
    expect(segmentFileText(plain!)).toBe(
      'ci-sdk-segment 1\nname=qa\ntrackerName=ForcedSegment::C1\nnetwork=ForcedSegment\ncampaign=C1\nadgroup=\ncreative=\n'
    )
    expect(segmentFileText(us!)).toContain('\nnetwork=AppLovin\n')
    expect(segmentFileText(us!).endsWith('country=US\n')).toBe(true)
  })
})

describe('applyRuntimePatch', () => {
  it('patches the facade with the dormant class, and leaves the country source alone', async () => {
    await writeTree(root, { [ADJUST_PATH]: ADJUST_CS, [TRACKER_PATH]: TRACKER_SYNC_CS })
    const patched = await applyRuntimePatch({ projectRoot: root, country: false, stateFile })

    expect(patched).toEqual([ADJUST_PATH, CLASS_PATH])
    const facade = await read(ADJUST_PATH)
    expect(facade).toContain(
      `attributionCallback = AdjustCiForcedSegment.Wrap(attributionCallback); ${M}`
    )
    expect(await read(CLASS_PATH)).toBe(runtimeSegmentSource())
    expect(await read(TRACKER_PATH)).toBe(TRACKER_SYNC_CS)
    expect(runtimeSegmentSource()).toContain(`"${SEGMENT_ENTRY}"`)
    // No segment value is compiled in: the APK file decides.
    expect(runtimeSegmentSource()).not.toContain('ForcedCampaign')
  })

  it.each([
    ['sync', TRACKER_SYNC_CS, 'return System.Threading.Tasks.Task.FromResult(ciSdkCountry);'],
    ['async', TRACKER_ASYNC_CS, 'return ciSdkCountry;']
  ])('patches a %s country source with its own reader class', async (_kind, tracker, ret) => {
    await writeTree(root, { [ADJUST_PATH]: ADJUST_CS, [TRACKER_PATH]: tracker })
    const patched = await applyRuntimePatch({ projectRoot: root, country: true, stateFile })

    const file = await countryClass()
    expect(file).toMatch(/^CiSdkSegmentCountry[0-9a-f]{8}\.cs$/)
    const className = file!.slice(0, -3)
    expect(patched).toEqual([ADJUST_PATH, TRACKER_PATH, CLASS_PATH, `${TRACKER_DIR}/${file}`])
    expect(await read(`${TRACKER_DIR}/${file}`)).toBe(runtimeCountrySource(className))
    // Builds in an assembly without engine references: it only reads what the facade class set.
    expect(runtimeCountrySource(className)).not.toContain('UnityEngine')
    expect(runtimeCountrySource(className)).toContain(
      'GetEnvironmentVariable("CI_SDK_SEGMENT_COUNTRY")'
    )
    expect(runtimeSegmentSource()).toContain(
      'SetEnvironmentVariable(CiSdkCountryVariable, country)'
    )
    expect(await read(TRACKER_PATH)).toContain(
      `{ var ciSdkCountry = global::${className}.Country(); if (ciSdkCountry != null) { ${ret} } } ${M}`
    )
  })

  it('fails when a country is wanted but no country source exists, writing nothing', async () => {
    await writeTree(root, { [ADJUST_PATH]: ADJUST_CS })
    await expect(
      applyRuntimePatch({ projectRoot: root, country: true, stateFile })
    ).rejects.toThrow(/no known IP country source/)
    expect(await read(ADJUST_PATH)).toBe(ADJUST_CS)
    expect(existsSync(path.join(root, CLASS_PATH))).toBe(false)
    expect(existsSync(stateFile)).toBe(false)
  })

  it('is undone by restore, generated files and their .meta included', async () => {
    await writeTree(root, { [ADJUST_PATH]: ADJUST_CS, [TRACKER_PATH]: TRACKER_SYNC_CS })
    await applyRuntimePatch({ projectRoot: root, country: true, stateFile })
    const file = await countryClass()
    await writeTree(root, {
      [`${CLASS_PATH}.meta`]: 'guid',
      [`${TRACKER_DIR}/${file}.meta`]: 'guid'
    })

    expect(await restorePatch(stateFile)).toBe(true)
    expect(await read(ADJUST_PATH)).toBe(ADJUST_CS)
    expect(await read(TRACKER_PATH)).toBe(TRACKER_SYNC_CS)
    expect(await countryClass()).toBeUndefined()
    expect(existsSync(path.join(root, CLASS_PATH))).toBe(false)
  })

  it('leaves no country reader behind after a killed job (removeStaleGenerated)', async () => {
    await writeTree(root, { [ADJUST_PATH]: ADJUST_CS, [TRACKER_PATH]: TRACKER_SYNC_CS })
    await applyRuntimePatch({ projectRoot: root, country: true, stateFile })
    const file = await countryClass()
    const removed = await removeStaleGenerated(root)
    expect(removed.sort()).toEqual([CLASS_PATH, `${TRACKER_DIR}/${file}`].sort())
  })

  it('restores the previous state before patching again', async () => {
    await writeTree(root, { [ADJUST_PATH]: ADJUST_CS })
    await applyRuntimePatch({ projectRoot: root, country: false, stateFile })
    await applyRuntimePatch({ projectRoot: root, country: false, stateFile })
    expect((await read(ADJUST_PATH)).split(M).length - 1).toBe(3)
    await restorePatch(stateFile)
    expect(await read(ADJUST_PATH)).toBe(ADJUST_CS)
  })
})
