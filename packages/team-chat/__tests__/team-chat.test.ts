import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { run } from '../src/main.js'
import {
  LIMITS,
  buildPayload,
  checkLimits,
  defang,
  escapeMrkdwn,
  formatDuration,
  mrkdwnLink,
  oneLine,
  safeUrl,
  truncate,
  type Block,
  messageVariant,
  runStatus,
  type Payload,
  type TableCell
} from '../src/payload.js'
import { parseReport, type Build, type Report } from '../src/report.js'
import { sendPayload, webhookKeyForms, webhookLabel, type Fetch } from '../src/send.js'

const RUN = 'https://github.com/acme/Game/actions/runs/1'
const segment = (name: string, ok = true, extra: Partial<Build> = {}): Build => ({
  name,
  kind: 'segment',
  status: ok ? 'success' : 'failure',
  campaign: `QA_${name.toUpperCase()}`,
  country: 'US',
  ...(ok
    ? { link: `https://drive.google.com/file/d/${name}/view`, size: 2097152 }
    : {
        failedStep: 'Unity build',
        logUrl: 'https://github.com/acme/Game/actions/runs/1/artifacts/9'
      }),
  ...extra
})

function debugReport(over: Partial<Report> = {}): Report {
  return {
    name: 'BGPZ-005-Gem',
    kind: 'debug',
    status: 'success',
    game: 'Gem Blast',
    platform: 'Android',
    project: { name: 'acme/BGPZ-005-Gem', url: 'https://github.com/acme/BGPZ-005-Gem' },
    run: { url: RUN, number: 128 },
    ref: { type: 'branch', name: 'main' },
    commit: {
      sha: 'abcdef0123456789',
      url: 'https://github.com/acme/Game/commit/abcdef0',
      subject: 'feat: new level'
    },
    actor: 'dev',
    durationSeconds: 754,
    version: { name: '1.0.9', code: 19 },
    builds: [
      {
        name: 'Normal',
        kind: 'normal',
        status: 'success',
        link: 'https://drive.google.com/file/d/n/view',
        size: 1048576
      },
      segment('iaproas-us'),
      segment('organic-us', true, { campaign: '' })
    ],
    changelog: [
      {
        sha: 'abcdef0123',
        subject: 'feat: new level',
        author: 'dev',
        url: 'https://github.com/acme/Game/commit/abcdef0'
      }
    ],
    ...over
  }
}

function releaseReport(over: Partial<Report> = {}): Report {
  return {
    name: 'BGPZ-005-Gem',
    kind: 'release',
    status: 'success',
    platform: 'Android',
    run: { url: RUN, number: 60 },
    ref: { type: 'tag', name: 'v1.0.2' },
    commit: { sha: 'abcdef0123', subject: 'chore: release' },
    durationSeconds: 1800,
    version: { name: '1.0.2', code: '10002' },
    builds: [
      {
        name: 'AAB (store)',
        kind: 'aab',
        status: 'success',
        link: 'https://drive.google.com/file/d/a/view',
        size: 167772160
      },
      {
        name: 'APK (QA, universal)',
        kind: 'apk',
        status: 'success',
        link: 'https://drive.google.com/file/d/b/view',
        size: 236630648
      }
    ],
    ...over
  }
}

const find = <T extends Block['type']>(p: Payload, type: T): Extract<Block, { type: T }>[] =>
  p.blocks.filter((b): b is Extract<Block, { type: T }> => b.type === type)
const json = (p: Payload): string => JSON.stringify(p)
/** Visible text of a table cell. */
const cellText = (c: TableCell): string =>
  c.type === 'raw_text' ? c.text : c.elements.flatMap(e => e.elements.map(x => x.text)).join('')
/** Every string the server reads as mrkdwn: `text` and the mrkdwn text objects. */
function mrkdwnStrings(p: Payload): string[] {
  const out = [p.text]
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>
      if (o.type === 'mrkdwn' && typeof o.text === 'string') out.push(o.text)
      Object.values(o).forEach(walk)
    }
  }
  walk(p.blocks)
  return out
}

describe('escaping', () => {
  it('mrkdwn entities, links, one line, URLs', () => {
    expect(escapeMrkdwn('<!channel> & <@U1>')).toBe('&lt;!channel&gt; &amp; &lt;@U1&gt;')
    expect(oneLine(' a\nb\r\n\tc  d ')).toBe('a b c d')
    expect(oneLine(`x${String.fromCodePoint(0x2028)}y`)).toBe('x y')
    expect(safeUrl('javascript:alert(1)')).toBeUndefined()
    expect(safeUrl('https://x.test/a|b>c')).toBe('https://x.test/a%7Cb%3Ec')
    expect(mrkdwnLink('https://x.test', 'Run #1')).toBe('<https://x.test/|Run #1>')
    expect(mrkdwnLink(undefined, 'a<b')).toBe('a&lt;b')
    expect(formatDuration(754)).toBe('12m34s')
    expect(formatDuration(45)).toBe('45s')
    expect(formatDuration(3900)).toBe('1h05m')
  })

  it('untrusted text can inject no mention, broadcast or link', () => {
    const evil = '<!channel> <!here> <@U123> <https://evil.test|click> &lt;'
    const p = buildPayload(
      debugReport({
        status: 'failure',
        failedStep: evil,
        game: evil,
        actor: evil,
        ref: { type: 'branch', name: evil },
        commit: { sha: 'abc1234', subject: evil },
        warnings: [evil],
        builds: [{ name: evil, kind: 'normal', status: 'failure', failedStep: evil }],
        changelog: [{ sha: 'abc1234', subject: evil, author: evil }]
      })
    )
    const body = json(p)
    for (const text of mrkdwnStrings(p)) expect(text).not.toMatch(/<!|<@|<https:\/\/evil/)
    // Untrusted text elsewhere is only in literal rich_text `text` elements and plain_text.
    expect(body).not.toMatch(/"type":"(broadcast|user)"/)
    for (const cell of find(p, 'table')[0]!.rows.slice(1).flat()) {
      if (cell.type === 'raw_text') expect(cell.text).not.toContain('<')
    }
    expect(p.text).toContain('&lt;!channel&gt;')
    // rich_text and raw_text cells are literal text, not mrkdwn.
    expect(body).toContain(JSON.stringify(evil).slice(1, -1).slice(0, 20))
    expect(checkLimits(p)).toEqual([])
  })
})

describe('hardening', () => {
  const WJ = String.fromCharCode(0x2060)
  const allAlerts = (p: Payload): string[] => find(p, 'alert').map(a => a.text.text)

  it('defang: plain URLs, domains and @names are not linked; versions stay as they are', () => {
    expect(defang('https://evil.test/x')).toBe(`https:${WJ}//evil.${WJ}test/x`)
    expect(defang('mail me@evil.com @here')).toBe(`mail me@${WJ}evil.${WJ}com @${WJ}here`)
    expect(defang('v1.0.2 (10002)')).toBe('v1.0.2 (10002)')
    const lure = 'fix: see https://evil.test/login or evil.com, ping @here'
    const p = buildPayload(
      debugReport({
        status: 'failure',
        failedStep: lure,
        game: lure,
        actor: lure,
        runner: lure,
        commit: { sha: 'abc1234', subject: lure },
        ref: { type: 'branch', name: lure },
        warnings: [lure],
        project: { name: lure, url: 'https://github.com/acme/Game' },
        builds: [
          { name: lure, kind: 'normal', status: 'failure', failedStep: lure },
          { name: 'seg', kind: 'segment', status: 'success', campaign: lure, country: lure }
        ],
        changelog: [{ sha: 'abc1234', subject: lure, author: lure }]
      })
    )
    for (const text of mrkdwnStrings(p).slice(1)) {
      expect(text).not.toMatch(/https:\/\/evil|evil\.test|evil\.com|@here/)
    }
    // Link labels, table cells and the changelog too (rich_text `text` elements).
    expect(JSON.stringify(p.blocks)).not.toMatch(/https:\/\/evil|evil\.test|evil\.com|@here/)
    // The notification line is not rendered: it stays searchable.
    expect(p.text).toContain('https://evil.test/login')
  })

  it('every alert stays under 3000 chars after escaping', () => {
    const heavy = '&<>'.repeat(100)
    const many = Array.from({ length: 40 }, (_, i): Build => ({
      name: `${heavy}${i}`,
      kind: 'segment',
      status: 'success',
      fallback: true,
      link: 'https://github.com/acme/Game/actions/runs/1/artifacts/1'
    }))
    const longUrl = `https://github.com/acme/Game/actions/runs/2?${'q'.repeat(450)}`
    const reports: Report[] = [
      releaseReport({ builds: many }),
      debugReport({
        status: undefined,
        jobs: { apk: 'cancelled' },
        failedStep: '&'.repeat(5000),
        supersededBy: { number: 129, url: longUrl },
        logUrl: longUrl,
        run: { url: longUrl, number: 128 },
        builds: many
      }),
      debugReport({
        status: 'failure',
        failedStep: '&'.repeat(5000),
        logUrl: longUrl,
        run: { url: longUrl, number: 128 },
        builds: [debugReport().builds[0]!, ...many, segment('x', false)],
        warnings: Array.from({ length: 20 }, () => '&'.repeat(1000))
      })
    ]
    for (const report of reports) {
      const p = buildPayload(report)
      expect(checkLimits(p)).toEqual([])
      for (const text of allAlerts(p)) expect(text.length).toBeLessThanOrEqual(LIMITS.alertText)
      expect(allAlerts(p).join('\n')).toMatch(/\+\d+ more/)
    }
  })

  it('numbers where strings are expected do not crash the card', () => {
    const report = debugReport({
      name: 5 as unknown as string,
      actor: 7 as unknown as string,
      commit: { sha: 1234567890 as unknown as string, subject: 42 as unknown as string },
      version: { name: 1 as unknown as string, code: 19 },
      builds: [{ name: 3 as unknown as string, kind: 'normal', status: 'success' }],
      changelog: [{ sha: 99 as unknown as string, subject: 'x', author: 8 as unknown as string }]
    })
    const p = buildPayload(report)
    expect(p.text.startsWith('✅ 5 · Debug #128')).toBe(true)
    expect(checkLimits(p)).toEqual([])
    expect(() =>
      parseReport(
        JSON.stringify({
          ...report,
          builds: [{ name: 'a', kind: 'segment', status: 'success', campaign: 5 }]
        })
      )
    ).toThrow(
      /commit\.sha must be a string[\s\S]*version\.name must be a string[\s\S]*builds\[0\]\.campaign must be a string[\s\S]*changelog\[0\]\.sha must be a string/
    )
  })

  it('cuts by UTF-16 length and never splits an emoji', () => {
    expect(truncate(`a${'😀'.repeat(10)}`, 6)).toBe('a😀😀…')
    expect(truncate('abc', 3)).toBe('abc')
    expect(truncate('abc', 0)).toBe('')
    const p = buildPayload(debugReport({ name: '😀'.repeat(200) }))
    expect(find(p, 'header')[0]!.text.text.length).toBeLessThanOrEqual(LIMITS.header)
    expect(checkLimits(p)).toEqual([])
  })
})

describe('buildPayload', () => {
  it('debug all green', () => {
    const p = buildPayload(debugReport(), { sdkVersion: '3.4.0' })
    expect(p.text).toBe('✅ BGPZ-005-Gem · Debug #128 · 3/3 builds OK · 12m34s')
    expect(find(p, 'header')[0]!.text).toEqual({
      type: 'plain_text',
      text: '✅ BGPZ-005-Gem · Debug #128'
    })
    const fields = find(p, 'section')[0]!.fields!.map(f => f.text)
    expect(fields).toEqual([
      '*Branch*\nmain',
      '*Commit*\n<https://github.com/acme/Game/commit/abcdef0|abcdef0> feat: new level',
      '*Version*\n1.0.9 (19)',
      '*Duration*\n12m34s',
      '*Game*\nGem Blast',
      '*Build*\nAndroid · Debug',
      '*Triggered by*\ndev'
    ])
    const rows = find(p, 'table')[0]!.rows
    expect(rows[0]!.map(cellText)).toEqual(['Build', 'Campaign', 'Country', 'Result', 'Link'])
    expect(rows[1]!.slice(0, 4).map(cellText)).toEqual(['Normal', '—', '—', '✅'])
    expect(rows[2]!.slice(0, 3).map(cellText)).toEqual(['iaproas-us', 'QA_IAPROAS-US', 'US'])
    expect(rows[1]![4]).toEqual({
      type: 'rich_text',
      elements: [
        {
          type: 'rich_text_section',
          elements: [
            { type: 'link', url: 'https://drive.google.com/file/d/n/view', text: 'Drive · 1.0 MB' }
          ]
        }
      ]
    })
    expect(cellText(rows[3]![1]!)).toBe('(organic)')
    expect(find(p, 'alert')).toEqual([
      { type: 'alert', level: 'success', text: { type: 'mrkdwn', text: 'All 3 builds OK.' } }
    ])
    expect(find(p, 'context')[0]!.elements[0]!.text).toBe(
      `GitHub Actions · <https://github.com/acme/BGPZ-005-Gem|acme/BGPZ-005-Gem> · <${RUN}|Run #128> · ci-sdk v3.4.0`
    )
    expect(checkLimits(p)).toEqual([])
  })

  it('debug with failed segments is a warning, not an error', () => {
    const p = buildPayload(
      debugReport({
        status: 'failure',
        failedStep: 'segment organic-us',
        builds: [debugReport().builds[0]!, segment('iaproas-us'), segment('organic-us', false)]
      })
    )
    expect(p.text).toBe(
      '⚠️ BGPZ-005-Gem · Debug #128 failed at segment organic-us · 2/3 builds OK · 12m34s'
    )
    const [alert] = find(p, 'alert')
    expect(alert!.level).toBe('warning')
    expect(alert!.text.text).toContain('*Failed:* segment organic-us')
    const failedRow = find(p, 'table')[0]!.rows[3]!
    expect(cellText(failedRow[3]!)).toBe('❌ Unity build')
    expect(JSON.stringify(failedRow[4])).toContain('Unity log')
  })

  it('debug whose normal build failed is an error with the log link', () => {
    const p = buildPayload(
      debugReport({
        status: 'failure',
        failedStep: 'Unity build',
        logUrl: 'https://github.com/acme/Game/actions/runs/1/artifacts/7',
        builds: [{ name: 'Normal', kind: 'normal', status: 'failure', failedStep: 'Unity build' }]
      })
    )
    expect(p.text.startsWith('❌ BGPZ-005-Gem · Debug #128 failed at Unity build')).toBe(true)
    const [alert] = find(p, 'alert')
    expect(alert!.level).toBe('error')
    expect(alert!.text.text).toBe(
      `*Failed at* Unity build · <https://github.com/acme/Game/actions/runs/1/artifacts/7|Unity log> · <${RUN}|Run #128>`
    )
    // No segment columns without segments.
    expect(find(p, 'table')[0]!.rows[0]!.length).toBe(3)
  })

  it('release ready', () => {
    const p = buildPayload(releaseReport())
    expect(p.text).toBe('🚀 BGPZ-005-Gem · Release v1.0.2 (10002) ready')
    expect(find(p, 'header')[0]!.text.text).toBe('🚀 BGPZ-005-Gem · Release v1.0.2 (10002)')
    const [alert] = find(p, 'alert')
    expect(alert).toEqual({
      type: 'alert',
      level: 'success',
      text: {
        type: 'mrkdwn',
        text: 'Release v1.0.2 (10002) is ready: AAB (store), APK (QA, universal).'
      }
    })
    expect(find(p, 'table')[0]!.rows.map(r => r.length)).toEqual([3, 3, 3])
    expect(json(p)).toContain('Drive · 160.0 MB')
  })

  it('release failed, and release built with a fallback upload', () => {
    const failed = buildPayload(
      releaseReport({
        status: 'failure',
        failedStep: 'AAB to APK',
        builds: [
          releaseReport().builds[0]!,
          { name: 'APK (QA, universal)', kind: 'apk', status: 'failure', failedStep: 'AAB to APK' }
        ]
      })
    )
    expect(failed.text).toBe('❌ BGPZ-005-Gem · Release v1.0.2 (10002) failed at AAB to APK')
    expect(find(failed, 'alert').map(a => a.level)).toEqual(['error'])

    const fallback = buildPayload(
      releaseReport({
        status: 'failure',
        failedStep: 'Upload to Drive (release APK)',
        builds: [
          releaseReport().builds[0]!,
          {
            name: 'APK (QA, universal)',
            kind: 'apk',
            status: 'success',
            link: 'https://github.com/a/b/artifacts/1',
            fallback: true
          }
        ],
        warnings: ['Drive is not set up']
      })
    )
    expect(fallback.text).toBe(
      '⚠️ BGPZ-005-Gem · Release v1.0.2 (10002) built · Upload to Drive (release APK) failed'
    )
    const [alert] = find(fallback, 'alert')
    expect(alert!.level).toBe('warning')
    expect(alert!.text.text.split('\n')).toEqual([
      `*Failed:* Upload to Drive (release APK) · <${RUN}|Run #60>`,
      'Not on Drive, GitHub artifact instead: APK (QA, universal)',
      'Drive is not set up'
    ])
    expect(json(fallback)).toContain('GitHub artifact')
  })

  it('a release that failed before the version is known', () => {
    const p = buildPayload(
      releaseReport({
        status: 'failure',
        failedStep: 'Release setup (tag vX.Y.Z or keystore)',
        ref: { type: 'tag', name: 'v1.2' },
        version: {},
        builds: [
          { name: 'AAB (store)', kind: 'aab', status: 'failure', failedStep: 'Release setup' },
          {
            name: 'APK (QA, universal)',
            kind: 'apk',
            status: 'failure',
            failedStep: 'Release setup'
          }
        ]
      })
    )
    expect(p.text).toBe(
      '❌ BGPZ-005-Gem · Release v1.2 failed at Release setup (tag vX.Y.Z or keystore)'
    )
    expect(find(p, 'section')[0]!.fields!.some(f => f.text.startsWith('*Version*'))).toBe(false)
  })

  it('changelog: newest 10, then +N earlier', () => {
    const changelog = Array.from({ length: 14 }, (_, i) => ({
      sha: `${i}`.padStart(7, '0'),
      subject: `change ${i}`,
      author: 'a'
    }))
    const p = buildPayload(debugReport({ changelog }))
    const rich = find(p, 'rich_text')[0]!
    const list = rich.elements[1]!
    expect(list.type).toBe('rich_text_list')
    const items = (list as { elements: { elements: { text: string }[] }[] }).elements
    expect(items).toHaveLength(11)
    expect(items[0]!.elements[0]!.text).toBe('change 4 (')
    expect(items[10]!.elements[0]!.text).toBe('+4 earlier')
  })

  it('cuts to the limits: many builds, long names, long changelog', () => {
    const builds: Build[] = [
      {
        name: 'Normal',
        kind: 'normal',
        status: 'success',
        link: 'https://drive.google.com/file/d/n/view'
      },
      ...Array.from({ length: 150 }, (_, i) =>
        segment(`segment-with-a-rather-long-name-${i}-${'x'.repeat(40)}`, i % 7 !== 3, {
          campaign: 'C'.repeat(300)
        })
      )
    ]
    const changelog = Array.from({ length: 50 }, (_, i) => ({
      sha: `${i}abcdef`,
      subject: 'S'.repeat(500),
      author: 'A'.repeat(100)
    }))
    const p = buildPayload(
      debugReport({
        status: 'failure',
        failedStep: 'F'.repeat(5000),
        name: 'N'.repeat(400),
        game: 'G'.repeat(5000),
        commit: { sha: 'abc', subject: 'S'.repeat(5000) },
        builds,
        changelog,
        warnings: Array.from({ length: 20 }, () => 'W'.repeat(1000))
      })
    )
    expect(checkLimits(p)).toEqual([])
    expect(Array.from(find(p, 'header')[0]!.text.text).length).toBeLessThanOrEqual(LIMITS.header)
    const rows = find(p, 'table')[0]!.rows
    // Main build first, then the failed segments, then a "+N more" row.
    expect(cellText(rows[1]![0]!)).toBe('Normal')
    expect(cellText(rows[2]![3]!)).toBe('❌ Unity build')
    expect(cellText(rows.at(-1)![0]!)).toMatch(/^\+\d+ more \(see the run\)$/)
    expect(rows.at(-1)!.slice(1).map(cellText)).toEqual(['—', '—', '—', '—'])
    expect(p.text.length).toBeLessThanOrEqual(LIMITS.text)
  })

  it('no builds: no table, still valid', () => {
    const p = buildPayload(
      debugReport({ builds: [], changelog: [], status: 'failure', failedStep: 'Unity license' })
    )
    expect(find(p, 'table')).toEqual([])
    expect(find(p, 'alert')[0]!.level).toBe('error')
    expect(p.text).toBe(
      '❌ BGPZ-005-Gem · Debug #128 failed at Unity license · 0/0 builds OK · 12m34s'
    )
    expect(checkLimits(p)).toEqual([])
  })
})

describe('message lifecycle', () => {
  const debugStart = (): Report => ({
    ...debugReport(),
    phase: 'start',
    event: 'push',
    runner: 'runner-windows',
    startedAt: '05/11/2026 14:30 (UTC+7)',
    durationSeconds: undefined,
    changelog: [],
    builds: [
      { name: 'Normal', kind: 'normal', status: 'planned' },
      ...['iaproas-us', 'iaaroas-us', 'organic-us', 'iaproas-vn', 'iaaroas-vn', 'organic-vn'].map(
        (name): Build => ({
          name,
          kind: 'segment',
          status: 'planned',
          campaign: 'QA',
          country: 'US'
        })
      )
    ]
  })

  it.each<[string, Partial<Report>, Build[] | undefined, string]>([
    ['start', { phase: 'start' }, undefined, 'start'],
    [
      'all jobs green',
      { jobs: { apk: 'success', segment: 'success', release: 'skipped' } },
      undefined,
      'success'
    ],
    [
      'a segment job failed, normal OK',
      { jobs: { apk: 'success', segment: 'failure', release: 'skipped' } },
      [debugReport().builds[0]!, segment('a'), segment('b', false)],
      'partial'
    ],
    [
      'the normal build failed',
      { jobs: { apk: 'failure', segment: 'skipped', release: 'skipped' } },
      [{ name: 'Normal', kind: 'normal', status: 'failure' }],
      'failure'
    ],
    [
      'cancelled during the segments',
      { jobs: { apk: 'success', segment: 'cancelled', release: 'skipped' } },
      undefined,
      'cancelled'
    ],
    ['cancelled while queued', { jobs: { apk: 'cancelled', segment: 'skipped' } }, [], 'cancelled'],
    [
      'a failed job, then the run was cancelled',
      { jobs: { apk: 'failure', segment: 'cancelled' } },
      undefined,
      'cancelled'
    ],
    [
      'release built, Drive upload failed (status from the workflow)',
      { kind: 'release', status: 'failure', jobs: { apk: 'skipped', release: 'success' } },
      releaseReport().builds,
      'partial'
    ],
    [
      'release: aab-to-apk failed',
      { kind: 'release', jobs: { release: 'failure' } },
      [releaseReport().builds[0]!, { name: 'APK', kind: 'apk', status: 'failure' }],
      'failure'
    ],
    ['no jobs, explicit status', { status: 'cancelled' }, undefined, 'cancelled']
  ])('%s -> %s', (_label, over, builds, variant) => {
    const report = { ...debugReport(over), ...(builds ? { builds } : {}) }
    delete (report as { status?: string }).status
    if (over.status) report.status = over.status
    expect(messageVariant(report)).toBe(variant)
  })

  it('runStatus ignores skipped jobs', () => {
    expect(
      runStatus({ ...debugReport(), status: undefined, jobs: { a: 'skipped', b: 'success' } })
    ).toBe('success')
  })

  it('START (debug): planned outputs, info alert, no links or duration', () => {
    const p = buildPayload(debugStart())
    expect(p.text).toBe('🛠️ BGPZ-005-Gem · Đang build Debug #128 · 7 bản (normal + 6 segment)')
    expect(find(p, 'header')[0]!.text.text).toBe('🛠️ BGPZ-005-Gem · Đang build Debug #128')
    const fields = find(p, 'section')[0]!.fields!.map(f => f.text.split('\n')[0])
    expect(fields).toEqual([
      '*Branch*',
      '*Commit*',
      '*Version*',
      '*Game*',
      '*Build*',
      '*Triggered by*',
      '*Event*',
      '*Runner*',
      '*Started*'
    ])
    const rows = find(p, 'table')[0]!.rows
    expect(rows[0]!.map(cellText)).toEqual(['Build', 'Campaign', 'Country', 'Status'])
    expect(rows).toHaveLength(8)
    expect(rows.slice(1).every(r => cellText(r[3]!) === '⏳ planned')).toBe(true)
    const [alert] = find(p, 'alert')
    expect(alert!.level).toBe('info')
    expect(alert!.text.text).toContain('Building 7 builds on runner-windows.')
    expect(find(p, 'section')[0]!.fields!.find(f => f.text.startsWith('*Event*'))!.text).toBe(
      '*Event*\npush'
    )
    expect(checkLimits(p)).toEqual([])
  })

  it('START (release)', () => {
    const p = buildPayload({
      ...releaseReport(),
      phase: 'start',
      builds: releaseReport().builds.map(b => ({
        name: b.name,
        kind: b.kind,
        status: 'planned' as const
      }))
    })
    expect(p.text).toBe('🛠️ BGPZ-005-Gem · Đang build Release v1.0.2 (10002)')
    expect(find(p, 'table')[0]!.rows.map(r => r.map(cellText))).toEqual([
      ['Build', 'Status'],
      ['AAB (store)', '⏳ planned'],
      ['APK (QA, universal)', '⏳ planned']
    ])
  })

  it('END cancelled: duration, stage, superseded run, what finished', () => {
    const p = buildPayload(
      debugReport({
        status: undefined,
        jobs: { apk: 'success', segment: 'cancelled', release: 'skipped' },
        failedStep: 'segment builds',
        supersededBy: { number: 129, url: 'https://github.com/acme/Game/actions/runs/2' },
        builds: [
          debugReport().builds[0]!,
          segment('iaproas-us'),
          { name: 'organic-us', kind: 'segment', status: 'cancelled', campaign: '', country: 'US' }
        ]
      })
    )
    expect(p.text).toBe(
      '🚫 BGPZ-005-Gem · Debug #128 cancelled after 12m34s · during segment builds · superseded by run #129'
    )
    const [alert] = find(p, 'alert')
    expect(alert!.level).toBe('default')
    expect(alert!.text.text).toBe(
      `*Cancelled* after 12m34s, during segment builds. Superseded by <https://github.com/acme/Game/actions/runs/2|Run #129>. Finished before the cancel: Normal, iaproas-us. · <${RUN}|Run #128>`
    )
    const rows = find(p, 'table')[0]!.rows
    expect(cellText(rows[3]![3]!)).toBe('🚫 cancelled')
    expect(cellText(rows[3]![4]!)).toBe('—')
    expect(cellText(rows[1]![4]!)).toBe('Drive · 1.0 MB')
  })

  it('END cancelled while queued: nothing finished', () => {
    const p = buildPayload(
      debugReport({
        status: undefined,
        jobs: { apk: 'cancelled' },
        durationSeconds: undefined,
        builds: []
      })
    )
    expect(p.text).toBe('🚫 BGPZ-005-Gem · Debug #128 cancelled')
    expect(find(p, 'alert')[0]!.text.text).toContain('Nothing finished before the cancel.')
  })
})

describe('parseReport', () => {
  it('accepts a report and ignores unknown keys', () => {
    expect(parseReport(JSON.stringify({ ...debugReport(), extra: 1 })).name).toBe('BGPZ-005-Gem')
  })
  it('lists every problem', () => {
    expect(() => parseReport('nope')).toThrow(/not valid JSON/)
    expect(() => parseReport('[]')).toThrow(/JSON object/)
    let message = ''
    try {
      parseReport(
        JSON.stringify({
          kind: 'nightly',
          status: 'ok',
          run: {},
          builds: [{ name: 'x', kind: 'ipa', status: 'success' }]
        })
      )
    } catch (err) {
      message = String(err)
    }
    for (const part of [
      'name is required',
      'kind must be one of',
      'status must be one of',
      'run.url is required',
      'builds[0].kind'
    ]) {
      expect(message).toContain(part)
    }
  })
})

describe('sendPayload', () => {
  const URL_ = 'https://chat.example.test/hooks/incoming?ma=0123456789abcdefSECRETXY'
  const reply = (status: number, body = '', headers: Record<string, string> = {}): Response =>
    new Response(body, { status, headers })
  const sleep = vi.fn(async (_ms: number) => Promise.resolve())

  beforeEach(() => sleep.mockClear())

  it('posts UTF-8 JSON once on 200', async () => {
    const fetchImpl = vi.fn<Fetch>(async () => Promise.resolve(reply(200, 'ok')))
    const result = await sendPayload(URL_, { text: 'Bản build ✅' }, { fetchImpl, sleep })
    expect(result).toEqual({ ok: true, attempts: 1, status: 200 })
    const [, init] = fetchImpl.mock.calls[0]!
    expect(init!.method).toBe('POST')
    expect((init!.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json; charset=utf-8'
    )
    expect(JSON.parse(init!.body as string)).toEqual({ text: 'Bản build ✅' })
  })

  it('429 waits for Retry-After, 5xx backs off 5 s then 30 s, 3 tries at most', async () => {
    const fetchImpl = vi
      .fn<Fetch>()
      .mockResolvedValueOnce(reply(429, 'rate_limited', { 'Retry-After': '2' }))
      .mockResolvedValueOnce(reply(503))
      .mockResolvedValueOnce(reply(200, 'ok'))
    expect(await sendPayload(URL_, {}, { fetchImpl, sleep })).toEqual({
      ok: true,
      attempts: 3,
      status: 200
    })
    expect(sleep.mock.calls.map(c => c[0])).toEqual([2000, 30_000])

    const down = vi.fn<Fetch>(async () => Promise.resolve(reply(502, 'bad gateway')))
    const result = await sendPayload(URL_, {}, { fetchImpl: down, sleep })
    expect(result).toEqual({ ok: false, attempts: 3, status: 502, error: 'HTTP 502 bad gateway' })
    expect(down).toHaveBeenCalledTimes(3)
  })

  it('4xx and network errors stop at once; the URL never shows', async () => {
    const forbidden = vi.fn<Fetch>(async () => Promise.resolve(reply(403, 'action_prohibited')))
    expect(await sendPayload(URL_, {}, { fetchImpl: forbidden, sleep })).toEqual({
      ok: false,
      attempts: 1,
      status: 403,
      error: 'HTTP 403 action_prohibited'
    })
    const broken = vi.fn<Fetch>(async () =>
      Promise.reject(new TypeError(`fetch failed for ${URL_}`))
    )
    const result = await sendPayload(URL_, {}, { fetchImpl: broken, sleep })
    expect(result.ok).toBe(false)
    expect(broken).toHaveBeenCalledTimes(1)
    expect(result.error).not.toContain('SECRET')
    expect(result.error).toContain('ma=0123456789ab…')
    expect(sleep).not.toHaveBeenCalled()
  })

  it('a redirect is not followed or retried', async () => {
    const moved = vi.fn<Fetch>(async () =>
      Promise.resolve(reply(302, '', { Location: 'https://elsewhere.test/' }))
    )
    const result = await sendPayload(URL_, {}, { fetchImpl: moved, sleep })
    expect(result).toEqual({ ok: false, attempts: 1, status: 302, error: 'HTTP 302' })
    expect(moved.mock.calls[0]![1]!.redirect).toBe('manual')
  })

  it('the response body is one line and never shows the key', async () => {
    const log = vi.fn()
    const fetchImpl = vi
      .fn<Fetch>()
      .mockResolvedValueOnce(reply(500, 'oops\n::error::injected key=0123456789abcdefSECRETXY'))
      .mockResolvedValueOnce(reply(400, 'bad\r\nrequest'))
    const result = await sendPayload(URL_, {}, { fetchImpl, sleep, log })
    expect(result.error).toBe('HTTP 400 bad request')
    expect(log).toHaveBeenCalledTimes(1)
    const line = String(log.mock.calls[0]![0])
    expect(line).not.toContain('\n')
    expect(line).not.toContain('SECRET')
    expect(line).toContain('oops ::error::injected key=ma=0123456789ab…')
  })

  it('the key is redacted as written in the URL and decoded', async () => {
    const url = 'https://chat.example.test/hook?ma=0123%2B456789abcdef'
    expect(webhookKeyForms(url)).toEqual(['0123+456789abcdef', '0123%2B456789abcdef'])
    const fetchImpl = vi.fn<Fetch>(async () =>
      Promise.resolve(reply(400, 'bad key 0123%2B456789abcdef / 0123+456789abcdef'))
    )
    const result = await sendPayload(url, {}, { fetchImpl, sleep })
    expect(result.error).toBe('HTTP 400 bad key ma=0123+456… / ma=0123+456…')
    expect(webhookLabel('https://x.test/h?ma=abcdefghij')).toBe('ma=abcde…')
    expect(webhookLabel('https://x.test/h?ma=abcdefghijklmnopqrst')).toBe('ma=abcdefghij…')
  })

  it('logs show at most 12 characters of the ma= key', () => {
    expect(webhookLabel(URL_)).toBe('ma=0123456789ab…')
    expect(webhookLabel('https://x.test/hook')).toBe('webhook (no ma= key)')
    expect(webhookLabel('nope')).toBe('webhook (not a URL)')
  })
})

describe('run', () => {
  let temp: string
  let outputFile: string
  let stdout: string[]

  async function call(
    inputs: Record<string, string>,
    fetchImpl?: Mock<Fetch>
  ): Promise<Record<string, string>> {
    const all: Record<string, string> = {
      'webhook-url': '',
      report: '',
      'report-file': '',
      'payload-file': '',
      'dry-run': 'false',
      attempts: '3',
      ...inputs
    }
    for (const [key, value] of Object.entries(all)) vi.stubEnv(`INPUT_${key.toUpperCase()}`, value)
    await run(fetchImpl ? { fetchImpl, sleep: async () => Promise.resolve() } : {})
    const out: Record<string, string> = {}
    const text = (await readFile(outputFile, 'utf8')).split(/\r?\n/).join('\n')
    for (const m of text.matchAll(/^(.+)<<(ghadelimiter_[\w-]+)\n([\s\S]*?)\n\2$/gm))
      out[m[1]!] = m[3]!
    return out
  }

  beforeEach(async () => {
    temp = await mkdtemp(path.join(os.tmpdir(), 'team-chat-'))
    outputFile = path.join(temp, 'output')
    await writeFile(outputFile, '')
    vi.stubEnv('GITHUB_OUTPUT', outputFile)
    stdout = []
    vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
      stdout.push(String(chunk))
      return true
    })
  })
  afterEach(async () => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    await rm(temp, { recursive: true, force: true })
  })

  it('dry-run writes the payload file and sends nothing', async () => {
    const fetchImpl = vi.fn<Fetch>()
    const payloadFile = path.join(temp, 'preview', 'payload.json')
    const out = await call(
      {
        report: JSON.stringify(releaseReport()),
        'payload-file': payloadFile,
        'dry-run': 'true',
        'webhook-url': 'https://x.test/h?ma=k'
      },
      fetchImpl
    )
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(out).toMatchObject({
      sent: 'false',
      text: '🚀 BGPZ-005-Gem · Release v1.0.2 (10002) ready'
    })
    const payload = JSON.parse(await readFile(payloadFile, 'utf8')) as Payload
    expect(checkLimits(payload)).toEqual([])
    expect(JSON.stringify(payload)).toMatch(/ci-sdk v\d+\.\d+\.\d+/)
  })

  it('an empty webhook sends nothing; a report file works', async () => {
    const file = path.join(temp, 'report.json')
    await writeFile(file, JSON.stringify(debugReport()))
    const out = await call({ 'report-file': file })
    expect(out.sent).toBe('false')
    expect(stdout.join('')).toContain('webhook-url is empty')
  })

  it('a webhook failure is a warning, never a failed step, and the URL is not logged', async () => {
    const url = 'https://chat.example.test/hook?ma=0123456789abcdefSECRETXY'
    const fetchImpl = vi.fn<Fetch>(async () =>
      Promise.resolve(new Response('no_active_hooks', { status: 404 }))
    )
    const out = await call({ report: JSON.stringify(debugReport()), 'webhook-url': url }, fetchImpl)
    expect(out).toMatchObject({ sent: 'false', status: '404' })
    const log = stdout.join('')
    expect(log).toContain(
      '::warning::Chat message not sent (ma=0123456789ab…, 1 tries): HTTP 404 no_active_hooks'
    )
    // The only copy is the runner's own ::add-mask:: command (consumed, never shown in the log).
    expect(
      log
        .split('\n')
        .filter(l => !l.startsWith('::add-mask::'))
        .join('\n')
    ).not.toContain('SECRET')
  })

  it('posts and reports sent', async () => {
    const fetchImpl = vi.fn<Fetch>(async () => Promise.resolve(new Response('ok', { status: 200 })))
    const out = await call(
      { report: JSON.stringify(debugReport()), 'webhook-url': 'https://x.test/h?ma=k' },
      fetchImpl
    )
    expect(out).toMatchObject({ sent: 'true', status: '200' })
  })

  it('needs exactly one report source, and a valid one', async () => {
    await expect(call({})).rejects.toThrow(/exactly one of report and report-file/)
    await expect(call({ report: '{}', 'report-file': 'x' })).rejects.toThrow(/exactly one/)
    await expect(call({ report: '{"kind":"x"}' })).rejects.toThrow(/name is required/)
  })
})
