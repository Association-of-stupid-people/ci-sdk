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
  type Payload
} from '../src/payload.js'
import { parseReport, type Build, type Report } from '../src/report.js'
import { sendPayload, webhookKeyForms, webhookLabel, type Fetch } from '../src/send.js'

const RUN = 'https://github.com/acme/Game/actions/runs/1'
const DRIVE = 'https://drive.google.com/drive/folders/EXAMPLE'
/** U+2060 WORD JOINER: `defang` inserts it after a `.` before a letter (invisible in the client). */
const WJ = String.fromCharCode(0x2060)
/** The keystore file name as it renders after defang (the `.k` gets a word joiner). */
const KEYSTORE = `My-Game.${WJ}keystore`
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
    name: 'My-Game',
    kind: 'debug',
    status: 'success',
    game: 'My Game',
    platform: 'Android',
    driveFolderUrl: DRIVE,
    project: { name: 'acme/My-Game', url: 'https://github.com/acme/My-Game' },
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
    name: 'My-Game',
    kind: 'release',
    status: 'success',
    game: 'My Game',
    platform: 'Android',
    keystore: 'My-Game.keystore',
    driveFolderUrl: DRIVE,
    actor: 'dev',
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
/** The one alert block's three lines. */
const alertLines = (p: Payload): string[] => find(p, 'alert')[0]!.text.text.split('\n')
/** The one context line. */
const contextText = (p: Payload): string => find(p, 'context')[0]!.elements[0]!.text
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
        driveFolderUrl: undefined,
        builds: [{ name: evil, kind: 'normal', status: 'failure', failedStep: evil }]
      })
    )
    const body = json(p)
    for (const text of mrkdwnStrings(p)) expect(text).not.toMatch(/<!|<@|<https:\/\/evil/)
    expect(body).not.toMatch(/"type":"(broadcast|user)"/)
    // The push line is the only place untrusted text is left raw (it is never rendered).
    expect(p.text).toContain('&lt;!channel&gt;')
    expect(checkLimits(p)).toEqual([])
  })
})

describe('hardening', () => {
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
        driveFolderUrl: undefined,
        builds: [{ name: lure, kind: 'normal', status: 'failure', failedStep: lure }]
      })
    )
    // Every rendered mrkdwn string (all but the push line) is defanged.
    for (const text of mrkdwnStrings(p).slice(1)) {
      expect(text).not.toMatch(/https:\/\/evil|evil\.test|evil\.com|@here/)
    }
    expect(JSON.stringify(p.blocks)).not.toMatch(/https:\/\/evil|evil\.test|evil\.com|@here/)
    // The notification line is not rendered: it stays searchable.
    expect(p.text).toContain('https://evil.test/login')
  })

  it('never exceeds the alert limit, even with pathological input', () => {
    const heavy = '&<>'.repeat(100)
    const many = Array.from({ length: 40 }, (_, i): Build => ({
      name: `${heavy}${i}`,
      kind: 'segment',
      status: 'success',
      size: 85_000_000,
      link: `https://drive.google.com/file/d/seg${i}/view`
    }))
    const longUrl = `https://github.com/acme/Game/actions/runs/2?${'q'.repeat(450)}`
    const reports: Report[] = [
      releaseReport({ builds: many }),
      debugReport({
        status: undefined,
        jobs: { apk: 'cancelled' },
        failedStep: '&'.repeat(5000),
        supersededBy: { number: 129, url: longUrl },
        run: { url: longUrl, number: 128 },
        builds: many
      }),
      debugReport({
        status: 'failure',
        failedStep: '&'.repeat(5000),
        run: { url: longUrl, number: 128 },
        builds: [
          debugReport().builds[0]!,
          ...Array.from({ length: 40 }, (_, i): Build => ({
            name: `${heavy}${i}`,
            kind: 'segment',
            status: 'failure',
            failedStep: '&'.repeat(200),
            logUrl: 'https://github.com/acme/Game/actions/runs/1/artifacts/1'
          }))
        ]
      })
    ]
    for (const report of reports) {
      const p = buildPayload(report)
      expect(checkLimits(p)).toEqual([])
      for (const text of allAlerts(p)) expect(text.length).toBeLessThanOrEqual(LIMITS.alertText)
    }
  })

  it('caps long lists with +N more', () => {
    const many = Array.from({ length: 40 }, (_, i): Build => ({
      name: `seg-${i}`,
      kind: 'segment',
      status: 'success',
      size: 85_000_000,
      link: `https://drive.google.com/file/d/seg${i}/view`
    }))
    const p = buildPayload(debugReport({ builds: [debugReport().builds[0]!, ...many] }))
    // The downloads line is capped and ends with "+N more".
    expect(alertLines(p)[2]).toMatch(/\+\d+ more$/)
    expect(checkLimits(p)).toEqual([])

    const failed = Array.from({ length: 6 }, (_, i): Build => ({
      name: `seg-${i}`,
      kind: 'segment',
      status: 'failure',
      failedStep: 'Unity build'
    }))
    const q = buildPayload(
      debugReport({ status: 'failure', builds: [debugReport().builds[0]!, ...failed] })
    )
    // The failed-build list on line 2 keeps the first two, then "+N more".
    expect(alertLines(q)[1]).toContain('+4 more')
  })

  it('numbers where strings are expected do not crash the card', () => {
    const report = debugReport({
      name: 5 as unknown as string,
      game: 5 as unknown as string,
      actor: 7 as unknown as string,
      commit: { sha: 1234567890 as unknown as string, subject: 42 as unknown as string },
      version: { name: 1 as unknown as string, code: 19 },
      builds: [{ name: 3 as unknown as string, kind: 'normal', status: 'success' }]
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
      /commit\.sha must be a string[\s\S]*version\.name must be a string[\s\S]*builds\[0\]\.campaign must be a string/
    )
  })

  it('cuts by UTF-16 length and never splits an emoji', () => {
    expect(truncate(`a${'😀'.repeat(10)}`, 6)).toBe('a😀😀…')
    expect(truncate('abc', 3)).toBe('abc')
    expect(truncate('abc', 0)).toBe('')
    const p = buildPayload(debugReport({ name: '😀'.repeat(200), game: '😀'.repeat(200) }))
    expect(find(p, 'alert')[0]!.text.text.length).toBeLessThanOrEqual(LIMITS.alertText)
    expect(checkLimits(p)).toEqual([])
  })
})

describe('buildPayload (compact card v3)', () => {
  it('debug all green: three lines, sizes on every link, grey context', () => {
    const p = buildPayload(debugReport())
    expect(p.text).toBe('✅ My Game · Debug #128 · 3/3 OK · 12m')
    expect(alertLines(p)).toEqual([
      '*✅ My Game · Debug #128 · 3/3 OK*',
      '⏱ 12m34s · 1.0.9 (19)',
      '📦 <https://drive.google.com/file/d/n/view|Normal (1.0 MB)> · <https://drive.google.com/file/d/iaproas-us/view|iaproas-us (2.0 MB)> · <https://drive.google.com/file/d/organic-us/view|organic-us (2.0 MB)>'
    ])
    expect(find(p, 'alert')[0]!.level).toBe('success')
    expect(contextText(p)).toBe(
      `main · <https://github.com/acme/Game/commit/abcdef0|abcdef0> feat: new level · dev · <${DRIVE}|Drive> · <${RUN}|Run #128>`
    )
    expect(p.blocks).toHaveLength(2)
    expect(checkLimits(p)).toEqual([])
  })

  it('debug with a failed segment is a warning, names the failed build with its log', () => {
    const p = buildPayload(
      debugReport({
        status: 'failure',
        failedStep: 'segment organic-us',
        builds: [debugReport().builds[0]!, segment('iaproas-us'), segment('organic-us', false)]
      })
    )
    expect(p.text).toBe('⚠️ My Game · Debug #128 · 2/3 OK')
    expect(find(p, 'alert')[0]!.level).toBe('warning')
    expect(alertLines(p)).toEqual([
      '*⚠️ My Game · Debug #128 · 2/3 OK*',
      '⏱ 12m34s · ❌ organic-us: Unity build (<https://github.com/acme/Game/actions/runs/1/artifacts/9|log>)',
      '📦 <https://drive.google.com/file/d/n/view|Normal (1.0 MB)> · <https://drive.google.com/file/d/iaproas-us/view|iaproas-us (2.0 MB)>'
    ])
  })

  it('debug whose normal build failed is an error; no downloads line', () => {
    const p = buildPayload(
      debugReport({
        status: 'failure',
        failedStep: 'Unity build',
        builds: [
          {
            name: 'Normal',
            kind: 'normal',
            status: 'failure',
            failedStep: 'Unity build',
            logUrl: 'https://github.com/acme/Game/actions/runs/1/artifacts/7'
          }
        ]
      })
    )
    expect(p.text).toBe('❌ My Game · Debug #128 · 0/1 OK')
    expect(find(p, 'alert')[0]!.level).toBe('error')
    expect(alertLines(p)).toEqual([
      '*❌ My Game · Debug #128 · 0/1 OK*',
      '⏱ 12m34s · ❌ Normal: Unity build (<https://github.com/acme/Game/actions/runs/1/artifacts/7|log>)'
    ])
  })

  it('release ready: keystore key fact and AAB/APK sizes', () => {
    const p = buildPayload(releaseReport())
    expect(p.text).toBe('🚀 My Game · Release v1.0.2 ready')
    expect(find(p, 'alert')[0]!.level).toBe('success')
    expect(alertLines(p)).toEqual([
      '*🚀 My Game · Release v1.0.2 (10002)*',
      `⏱ 30m00s · 🔑 ${KEYSTORE}`,
      '📦 <https://drive.google.com/file/d/a/view|AAB (store) (160.0 MB)> · <https://drive.google.com/file/d/b/view|APK (QA, universal) (225.7 MB)>'
    ])
    expect(contextText(p)).toBe(
      `v1.0.2 · abcdef0 chore: release · dev · <${DRIVE}|Drive> · <${RUN}|Run #60>`
    )
  })

  it('release failed at AAB to APK: error, the built AAB still shows', () => {
    const p = buildPayload(
      releaseReport({
        status: 'failure',
        failedStep: 'AAB to APK',
        logUrl: 'https://github.com/acme/Game/actions/runs/1',
        builds: [
          releaseReport().builds[0]!,
          { name: 'APK (QA, universal)', kind: 'apk', status: 'failure', failedStep: 'AAB to APK' }
        ]
      })
    )
    expect(p.text).toBe('❌ My Game · Release v1.0.2 failed: AAB to APK')
    expect(find(p, 'alert')[0]!.level).toBe('error')
    expect(alertLines(p)).toEqual([
      '*❌ My Game · Release v1.0.2 (10002) · failed*',
      '⏱ 30m00s · ❌ AAB to APK (<https://github.com/acme/Game/actions/runs/1|log>)',
      '📦 <https://drive.google.com/file/d/a/view|AAB (store) (160.0 MB)>'
    ])
  })

  it('release built but the Drive upload failed is a warning (partial)', () => {
    const p = buildPayload(
      releaseReport({
        status: 'failure',
        failedStep: 'Upload to Drive (release APK)',
        logUrl: 'https://github.com/acme/Game/actions/runs/1'
      })
    )
    expect(p.text).toBe('⚠️ My Game · Release v1.0.2 · Upload to Drive (release APK) failed')
    expect(find(p, 'alert')[0]!.level).toBe('warning')
    expect(alertLines(p)[0]).toBe('*⚠️ My Game · Release v1.0.2 (10002) · built*')
  })

  it('a build with an unknown size shows its name only', () => {
    const p = buildPayload(
      debugReport({
        builds: [
          { name: 'Normal', kind: 'normal', status: 'success', link: 'https://x.test/a' },
          segment('iaproas-us')
        ]
      })
    )
    expect(alertLines(p)[2]).toBe(
      '📦 <https://x.test/a|Normal> · <https://drive.google.com/file/d/iaproas-us/view|iaproas-us (2.0 MB)>'
    )
  })
})

describe('message lifecycle', () => {
  const debugStart = (over: Partial<Report> = {}): Report => ({
    ...debugReport(),
    phase: 'start',
    event: 'push',
    runner: 'runner-windows',
    startedAt: '05/11/2026 14:30 (UTC+7)',
    eta: '~36m (~18:58)',
    durationSeconds: undefined,
    changelog: [],
    builds: [
      { name: 'Normal', kind: 'normal', status: 'planned' },
      ...['iaproas-us', 'iaaroas-us', 'organic-us', 'iaproas-vn', 'iaaroas-vn', 'organic-vn'].map(
        (name): Build => ({ name, kind: 'segment', status: 'planned' })
      )
    ],
    ...over
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

  it('START (debug): ETA, version, planned list, short push text', () => {
    const p = buildPayload(debugStart())
    expect(p.text).toBe('🛠️ My Game · Đang build Debug #128')
    expect(find(p, 'alert')[0]!.level).toBe('info')
    expect(alertLines(p)).toEqual([
      '*🛠️ My Game · Đang build Debug #128*',
      '⏱ ETA ~36m (~18:58) · 1.0.9 (19)',
      '🎯 Normal + 6 segment: iaproas-us · iaaroas-us · organic-us · iaproas-vn · iaaroas-vn · organic-vn'
    ])
    // The context line is the same shape on START and END (no event/runner in v3).
    expect(contextText(p)).toBe(
      `main · <https://github.com/acme/Game/commit/abcdef0|abcdef0> feat: new level · dev · <${DRIVE}|Drive> · <${RUN}|Run #128>`
    )
    expect(checkLimits(p)).toEqual([])
  })

  it('START without a previous run omits the ETA', () => {
    const p = buildPayload(debugStart({ eta: undefined }))
    expect(alertLines(p)[1]).toBe('⏱ 1.0.9 (19)')
    expect(alertLines(p)[1]).not.toContain('ETA')
  })

  it('START (release): keystore and the AAB + APK plan', () => {
    const p = buildPayload({
      ...releaseReport(),
      phase: 'start',
      eta: '~25m (~18:47)',
      durationSeconds: undefined,
      builds: releaseReport().builds.map(b => ({
        name: b.name,
        kind: b.kind,
        status: 'planned' as const
      }))
    })
    expect(p.text).toBe('🛠️ My Game · Đang build Release v1.0.2')
    expect(alertLines(p)).toEqual([
      '*🛠️ My Game · Đang build Release v1.0.2 (10002)*',
      `⏱ ETA ~25m (~18:47) · 🔑 ${KEYSTORE}`,
      '🎯 AAB (store) + APK (QA, universal)'
    ])
  })

  it('END cancelled: stage, superseded run, what finished with sizes', () => {
    const p = buildPayload(
      debugReport({
        status: undefined,
        jobs: { apk: 'success', segment: 'cancelled', release: 'skipped' },
        failedStep: 'organic-us',
        supersededBy: { number: 129, url: 'https://github.com/acme/Game/actions/runs/2' },
        builds: [
          debugReport().builds[0]!,
          segment('iaproas-us'),
          { name: 'organic-us', kind: 'segment', status: 'cancelled' }
        ]
      })
    )
    expect(p.text).toBe('🚫 My Game · Debug #128 cancelled')
    expect(find(p, 'alert')[0]!.level).toBe('default')
    expect(alertLines(p)).toEqual([
      '*🚫 My Game · Debug #128 · cancelled*',
      '⏱ 12m34s · during organic-us · superseded by <https://github.com/acme/Game/actions/runs/2|#129>',
      '📦 <https://drive.google.com/file/d/n/view|Normal (1.0 MB)> · <https://drive.google.com/file/d/iaproas-us/view|iaproas-us (2.0 MB)>'
    ])
  })

  it('END cancelled while queued: nothing finished, two lines', () => {
    const p = buildPayload(
      debugReport({
        status: undefined,
        jobs: { apk: 'cancelled' },
        durationSeconds: undefined,
        builds: []
      })
    )
    expect(p.text).toBe('🚫 My Game · Debug #128 cancelled')
    expect(alertLines(p)[0]).toBe('*🚫 My Game · Debug #128 · cancelled*')
  })
})

describe('parseReport', () => {
  it('accepts a report (with the v3 fields) and ignores unknown keys', () => {
    const r = parseReport(
      JSON.stringify({
        ...debugReport(),
        eta: '~36m (~18:58)',
        keystore: 'My-Game.keystore',
        driveFolderUrl: DRIVE,
        extra: 1
      })
    )
    expect(r.name).toBe('My-Game')
    expect(r.eta).toBe('~36m (~18:58)')
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
      text: '🚀 My Game · Release v1.0.2 ready'
    })
    const payload = JSON.parse(await readFile(payloadFile, 'utf8')) as Payload
    expect(checkLimits(payload)).toEqual([])
    expect(payload.blocks.map(b => b.type)).toEqual(['alert', 'context'])
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
