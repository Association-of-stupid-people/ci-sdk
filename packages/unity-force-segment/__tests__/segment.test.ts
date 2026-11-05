import { describe, expect, it } from 'vitest'
import { InputError } from '../../sdk/src/index.js'
import { csString, listSegments, parseSegmentFile, resolveSegment } from '../src/segment.js'

const GOOD = `
segments:
  - name: iaproas-us
    campaign: QA_IAPROAS
    country: us
  - name: organic
    campaign: ""
    network: Organic
    adgroup: g
    creative: c
    tracker-name: custom
`

function issues(text: string): string {
  try {
    parseSegmentFile(text)
  } catch (err) {
    expect(err).toBeInstanceOf(InputError)
    return (err as InputError).message
  }
  throw new Error('expected parseSegmentFile to throw')
}

describe('parseSegmentFile', () => {
  it('parses a good file and applies the defaults', () => {
    const file = parseSegmentFile(GOOD)
    expect(file.segments[0]).toEqual({
      name: 'iaproas-us',
      campaign: 'QA_IAPROAS',
      network: 'ForcedSegment',
      adgroup: '',
      creative: '',
      trackerName: 'ForcedSegment::QA_IAPROAS',
      country: 'US'
    })
    expect(file.segments[1]).toMatchObject({
      campaign: '',
      network: 'Organic',
      trackerName: 'custom',
      country: undefined
    })
  })

  it.each([
    ['not a mapping', '- a', 'must be a YAML mapping'],
    ['invalid yaml', 'a: [', 'invalid YAML'],
    [
      'unknown top-level key',
      'x: 1\nsegments:\n  - {name: a, campaign: x}',
      'unknown top-level key "x"'
    ],
    ['no segments', 'segments: []', '"segments" must be a non-empty list'],
    [
      'the removed default key',
      'default: a\nsegments:\n  - {name: a, campaign: x}',
      'unknown top-level key "default"'
    ],
    ['unknown key', 'segments:\n  - {name: a, campaign: x, color: red}', 'unknown key "color"'],
    ['missing campaign', 'segments:\n  - {name: a}', 'segments[0].campaign is required'],
    ['missing name', 'segments:\n  - {campaign: x}', 'segments[0].name is required'],
    ['bad name', 'segments:\n  - {name: Bad_Name, campaign: x}', 'must match'],
    ['empty name', 'segments:\n  - {name: "", campaign: x}', 'must match'],
    ['reserved name', 'segments:\n  - {name: none, campaign: x}', 'is reserved'],
    [
      'duplicate name',
      'segments:\n  - {name: a, campaign: x}\n  - {name: a, campaign: y}',
      '"a" is duplicated'
    ],
    ['wrong type', 'segments:\n  - {name: a, campaign: 12}', 'campaign must be a string'],
    ['bad country', 'segments:\n  - {name: a, campaign: x, country: USA}', 'ISO 3166-1 alpha-2'],
    ['reserved name all', 'segments:\n  - {name: all, campaign: x}', 'is reserved'],
    [
      'newline in a value',
      'segments:\n  - {name: a, campaign: "x\\ny"}',
      'must not contain control characters'
    ],
    [
      'too long',
      `segments:\n  - {name: a, campaign: "${'x'.repeat(201)}"}`,
      'at most 200 characters'
    ]
  ])('rejects %s', (_name, text, message) => {
    expect(issues(text)).toContain(message)
  })

  it('reports every problem at once', () => {
    const message = issues('segments:\n  - {name: A, campaign: 1, country: x}')
    expect(message).toContain('name')
    expect(message).toContain('campaign')
    expect(message).toContain('country')
  })
})

describe('resolveSegment', () => {
  const file = parseSegmentFile(GOOD)
  it('finds a segment by name', () => {
    expect(resolveSegment(file, 'organic')?.name).toBe('organic')
  })
  it.each(['', '  ', 'none', 'NONE'])('returns nothing for %j', selector => {
    expect(resolveSegment(file, selector)).toBeUndefined()
  })
  it.each(['default', 'all'])('treats %s as an unknown name', selector => {
    expect(() => resolveSegment(file, selector)).toThrow(/unknown segment/)
  })
  it('rejects an unknown name and lists the known ones', () => {
    expect(() => resolveSegment(file, 'nope')).toThrow(
      /unknown segment "nope".*iaproas-us, organic/
    )
  })
})

describe('listSegments', () => {
  const file = parseSegmentFile(GOOD)
  it.each(['', 'all', 'ALL'])('lists every segment for %j', filter => {
    expect(listSegments(file, filter)).toEqual(['iaproas-us', 'organic'])
  })
  it('lists nothing for none', () => {
    expect(listSegments(file, 'none')).toEqual([])
  })
  it('filters by a comma-separated list, in file order without duplicates', () => {
    expect(listSegments(file, 'organic, iaproas-us,organic')).toEqual(['iaproas-us', 'organic'])
    expect(listSegments(file, 'organic')).toEqual(['organic'])
  })
  it('rejects an unknown name', () => {
    expect(() => listSegments(file, 'organic,nope')).toThrow(/unknown segment "nope"/)
  })
  it.each([',', ' , ,'])('rejects a filter with no name: %j', filter => {
    expect(() => listSegments(file, filter)).toThrow(/no segment name/)
  })
})

describe('csString', () => {
  it('escapes backslashes and quotes', () => {
    expect(csString('a"b\\c')).toBe('a\\"b\\\\c')
  })
  it('refuses control characters', () => {
    expect(() => csString('a\nb')).toThrow()
  })
  it('keeps escaped quotes through the parser', () => {
    const file = parseSegmentFile(`segments:\n  - name: a\n    campaign: 'say "hi" \\ bye'`)
    expect(csString(file.segments[0]!.campaign)).toBe('say \\"hi\\" \\\\ bye')
  })
})
