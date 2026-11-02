import { describe, expect, it, vi } from 'vitest'
import { buildUnityArgs, DEFAULT_ARGS, modulesForTarget } from '../src/args.js'
import { CONTAINER_SCRIPT, containerPath, dockerRunArgs, imageTag } from '../src/docker.js'
import { hubArgs, hubErrors, installArgs, installModulesArgs } from '../src/hub.js'
import { UnityLogScanner, classifyFailure } from '../src/log-scan.js'
import { summaryMarkdown } from '../src/summary.js'
import { lookupChangeset, parseProjectVersion } from '../src/version.js'
import path from 'node:path'

describe('parseProjectVersion', () => {
  it('reads version and changeset', () => {
    const text =
      'm_EditorVersion: 2022.3.20f1\nm_EditorVersionWithRevision: 2022.3.20f1 (61c2feb0970d)\n'
    expect(parseProjectVersion(text)).toEqual({ version: '2022.3.20f1', changeset: '61c2feb0970d' })
  })
  it('falls back to the version alone', () => {
    expect(parseProjectVersion('m_EditorVersion: 2019.4.1f1\n')).toEqual({ version: '2019.4.1f1' })
    expect(parseProjectVersion('nothing')).toBeUndefined()
  })
})

describe('lookupChangeset', () => {
  it('returns the matching shortRevision', async () => {
    const fetch = vi.fn(async () =>
      Response.json({ results: [{ version: '6000.0.23f1', shortRevision: '1c4764c07fb4' }] })
    )
    await expect(lookupChangeset('6000.0.23f1', { fetch })).resolves.toBe('1c4764c07fb4')
  })
  it('never throws', async () => {
    const onWarning = vi.fn()
    const fetch = vi.fn(async () => new Response('nope', { status: 500 }))
    await expect(lookupChangeset('1.0.0f1', { fetch, onWarning })).resolves.toBeUndefined()
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining('HTTP 500'))
  })
})

describe('buildUnityArgs', () => {
  it('keeps the old composite command line working without a shell', () => {
    const r = buildUnityArgs({
      defaultArgs: DEFAULT_ARGS,
      args: '-buildTarget Android -keystoreAliasName "mirai keystore" -keystoreName $(pwd)/Assets/k.keystore',
      projectDir: '/w/my game'
    })
    expect(r.argv).toEqual([
      '-batchmode',
      '-nographics',
      '-silent-crashes',
      '-quit',
      '-logFile',
      '-',
      '-executeMethod',
      'BuildScript.BuildCLI',
      '-buildTarget',
      'Android',
      '-keystoreAliasName',
      'mirai keystore',
      '-keystoreName',
      '/w/my game/Assets/k.keystore',
      '-projectPath',
      '/w/my game'
    ])
    expect(r.buildTarget).toBe('Android')
    expect(r.secretFlags).toEqual([])
  })

  it('routes -logFile <file> to stdout and remembers the file', () => {
    const r = buildUnityArgs({
      defaultArgs: '-batchmode -logFile build.log',
      args: '',
      projectDir: '/p'
    })
    expect(r.argv).toEqual(['-batchmode', '-logFile', '-', '-projectPath', '/p'])
    expect(r.logFile).toBe('build.log')
  })

  it('adds -logFile - and keeps an explicit -projectPath', () => {
    const r = buildUnityArgs({ defaultArgs: '-projectPath x -logFile', args: '', projectDir: '/p' })
    expect(r.argv).toEqual(['-projectPath', 'x', '-logFile', '-'])
  })

  it('flags secrets on the command line', () => {
    const r = buildUnityArgs({
      defaultArgs: '-quit',
      args: '-keystorePassword s -serial X',
      projectDir: '/p'
    })
    expect(r.secretFlags).toEqual(['-keystorePassword', '-serial'])
  })

  it('maps build targets to Hub modules', () => {
    expect(modulesForTarget('Android', 'win32')).toEqual(['android'])
    expect(modulesForTarget('iOS', 'darwin')).toEqual(['ios'])
    expect(modulesForTarget('StandaloneWindows64', 'win32')).toEqual([])
    expect(modulesForTarget('StandaloneWindows64', 'darwin')).toEqual(['windows-mono'])
    expect(modulesForTarget('StandaloneOSX', 'linux')).toEqual(['mac-mono'])
    expect(modulesForTarget(undefined, 'linux')).toEqual([])
  })

  it('expands environment variables like the old bash step, per argument', () => {
    const r = buildUnityArgs({
      defaultArgs: '-quit',
      args: '-buildNumber $GITHUB_RUN_NUMBER \\\n -out "${OUT_DIR}/x y" -keep $MISSING -p ${PWD}',
      projectDir: '/p',
      env: { GITHUB_RUN_NUMBER: '42', OUT_DIR: '/build dir' }
    })
    expect(r.argv.slice(0, 9)).toEqual([
      '-quit',
      '-buildNumber',
      '42',
      '-out',
      '/build dir/x y',
      '-keep',
      '$MISSING',
      '-p',
      '/p'
    ])
    expect(r.unresolved).toEqual(['MISSING'])
  })

  it('collects secret flag values for redaction', () => {
    const r = buildUnityArgs({
      defaultArgs: '',
      args: '-keystorePass hunter2 -quit',
      projectDir: '/p'
    })
    expect(r.secretValues).toEqual(['hunter2'])
  })
})

describe('UnityLogScanner', () => {
  const scan = (text: string, chunk = 7): UnityLogScanner => {
    const s = new UnityLogScanner()
    for (let i = 0; i < text.length; i += chunk) s.push(text.slice(i, i + chunk))
    s.end()
    return s
  }

  it('extracts compile errors with location, across chunk boundaries', () => {
    const s = scan(
      'x\r\nAssets\\A.cs(3,7): error CS1002: ; expected\nAssets\\A.cs(3,7): error CS1002: ; expected\n'
    )
    expect(s.issues).toEqual([
      {
        kind: 'compile',
        message: 'Assets\\A.cs(3,7): error CS1002: ; expected',
        file: 'Assets/A.cs',
        line: 3,
        column: 7
      }
    ])
    expect(s.total).toBe(2)
  })

  it('takes the line after Gradle "What went wrong:"', () => {
    const s = scan('* What went wrong:\n\nExecution failed for task :launcher:bundleRelease.\n')
    expect(s.issues.map(i => i.message)).toEqual([
      'Gradle: Execution failed for task :launcher:bundleRelease.'
    ])
  })

  it('classifies a pure license failure as license', () => {
    const s = scan('No valid Unity Editor license found. Please activate your license.\n')
    expect(classifyFailure(s)).toBe('license')
  })

  it('never calls a build error a license error', () => {
    const s = scan('No valid Unity Editor license found.\nError building Player: 3 errors\n')
    expect(classifyFailure(s)).toBe('build')
  })

  it('ignores licensing noise seen in successful builds', () => {
    const s = scan(
      '[Licensing::Module] Error: Access token is unavailable; failed to update\n' +
        '[Licensing::Client] Error: Code 404 while processing request\n'
    )
    expect(s.issues).toEqual([])
  })

  it('treats a license error under "Aborting batchmode" as license', () => {
    const s = scan('Aborting batchmode due to failure:\nNo valid Unity Editor license found.\n')
    expect(s.issues).toEqual([{ kind: 'license', message: 'No valid Unity Editor license found.' }])
    expect(classifyFailure(s)).toBe('license')
  })

  it('records Build Finished, Result: Failure', () => {
    expect(scan('Build Finished, Result: Failure.\n').buildResultFailure).toBe(true)
  })

  it('accepts extra license patterns and caps the list', () => {
    const s = new UnityLogScanner(1, [/seat busy/i])
    s.push('SEAT BUSY\nNullReferenceException: boom\n')
    s.end()
    expect(s.issues).toEqual([{ kind: 'license', message: 'SEAT BUSY' }])
    expect(s.total).toBe(2)
  })
})

describe('hub', () => {
  it('builds platform-specific argv', () => {
    expect(hubArgs('win32', ['help'], false)).toEqual(['--', '--headless', 'help'])
    expect(hubArgs('linux', ['help'], true)).toEqual(['--no-sandbox', '--headless', 'help'])
    expect(installArgs('2022.3.20f1', 'abc', ['android'])).toEqual([
      'install',
      '--version',
      '2022.3.20f1',
      '--changeset',
      'abc',
      '--module',
      'android',
      '--childModules'
    ])
    expect(installArgs('2022.3.20f1', undefined, [])).toEqual([
      'install',
      '--version',
      '2022.3.20f1'
    ])
    expect(installModulesArgs('v', ['ios'])).toEqual([
      'install-modules',
      '--version',
      'v',
      '--module',
      'ios',
      '--childModules'
    ])
  })
  it('extracts Hub error lines', () => {
    expect(hubErrors({ stdout: 'ok\nError: download failed\n', stderr: '' })).toBe(
      ': Error: download failed'
    )
    expect(hubErrors({ stdout: 'ok', stderr: '' })).toBe('')
  })
})

describe('docker', () => {
  it('tags images per version and module set', () => {
    expect(imageTag('ci-unity-editor', '2022.3.20f1', ['webgl', 'android'])).toBe(
      'ci-unity-editor:2022.3.20f1-android-webgl'
    )
    expect(imageTag('r', 'v', [])).toBe('r:v-base')
  })

  it('passes secrets by name only', () => {
    const args = dockerRunArgs({
      name: 'unity-build-1-1-1',
      image: 'img',
      projectHost: '/w',
      mounts: [{ host: '/k.keystore', container: '/ci-keystore/k.keystore', readonly: true }],
      envNames: ['UNITY_KEYSTORE_PASS'],
      gradleVolume: 'g',
      unityArgs: ['-quit']
    })
    expect(args).toEqual([
      'run',
      '--rm',
      '--init',
      '--name',
      'unity-build-1-1-1',
      '-w',
      '/project',
      '-e',
      'TINI_KILL_PROCESS_GROUP=1',
      '-v',
      '/w:/project',
      '-v',
      '/k.keystore:/ci-keystore/k.keystore:ro',
      '-v',
      'g:/root/.gradle',
      '-e',
      'UNITY_KEYSTORE_PASS',
      'img',
      'sh',
      '-c',
      CONTAINER_SCRIPT,
      'ci-unity',
      '-quit'
    ])
  })

  it('maps host files into the container', () => {
    const project = path.resolve('/w/game')
    expect(containerPath(path.join(project, 'Assets', 'k.keystore'), project, '/ks')).toEqual({
      path: '/project/Assets/k.keystore'
    })
    const outside = path.resolve('/secrets/k.keystore')
    expect(containerPath(outside, project, '/ks')).toEqual({
      path: '/ks/k.keystore',
      mount: { host: outside, container: '/ks/k.keystore', readonly: true }
    })
  })
})

describe('summaryMarkdown', () => {
  it('shows the failure kind and log errors', () => {
    const md = summaryMarkdown({
      report: { name: 'unity-build', status: 'failure', durationMs: 1500, steps: [] },
      version: '2022.3.20f1',
      mode: 'host',
      runtime: '/u/Unity',
      attempts: 1,
      failureKind: 'hang',
      issues: [{ kind: 'build', message: 'Error building Player' }],
      totalIssues: 3,
      logFile: '/tmp/u.log'
    })
    expect(md).toContain('❌ Unity build: failure')
    expect(md).toContain('hung: no log output')
    expect(md).toContain('showing 1 of 3')
    expect(md).toContain('~~~\nError building Player\n~~~')
  })
})
