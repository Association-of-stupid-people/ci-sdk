import { describe, expect, it, vi } from 'vitest'
import { buildUnityArgs, DEFAULT_ARGS, modulesForTarget } from '../src/args.js'
import {
  CONTAINER_SCRIPT,
  NOT_PUBLISHED,
  containerPath,
  dockerRunArgs,
  dockerWarnings,
  ensureImage,
  gameciTag,
  imagePlan,
  imageTag,
  pathsOutsideProject
} from '../src/docker.js'
import {
  AbortError,
  ExecError,
  InputError,
  TimeoutError,
  type ExecResult,
  type exec
} from '../../sdk/src/index.js'
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

  it('keeps the container script lines as notices, never as issues', () => {
    const s = scan(
      'ci-unity: could not return the license seat (exit 1)\n' +
        'ci-unity:   Unable to return the license: Code 500\n'
    )
    expect(s.notices).toEqual([
      'ci-unity: could not return the license seat (exit 1)',
      'ci-unity:   Unable to return the license: Code 500'
    ])
    expect(s.issues).toEqual([])
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
      '--stop-timeout',
      '300',
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

  it('runs the container for the given platform', () => {
    const args = dockerRunArgs({
      name: 'n',
      image: 'img',
      projectHost: '/w',
      platform: 'linux/amd64',
      unityArgs: []
    })
    expect(args.slice(0, 11)).toEqual([
      'run',
      '--rm',
      '--init',
      '--name',
      'n',
      '-w',
      '/project',
      '--stop-timeout',
      '300',
      '--platform',
      'linux/amd64'
    ])
    expect(
      dockerRunArgs({ name: 'n', image: 'img', projectHost: '/w', unityArgs: [] })
    ).not.toContain('--platform')
  })

  it('names GameCI images, one module each', () => {
    expect(gameciTag('2022.3.20f1', ['android'], '3')).toBe(
      'unityci/editor:ubuntu-2022.3.20f1-android-3'
    )
    expect(gameciTag('6000.0.30f1', [], '3.2.2')).toBe(
      'unityci/editor:ubuntu-6000.0.30f1-base-3.2.2'
    )
    expect(gameciTag('2022.3.20f1', ['android', 'ios'], '3')).toBeUndefined()
  })

  describe('ensureImage', () => {
    const build = {
      tag: 'ci-unity-editor:v-android',
      version: 'v',
      changeset: async (): Promise<string | undefined> => 'abcdef123456',
      modules: ['android'],
      dockerfile: '/d/Dockerfile'
    }
    type Answer = (args: readonly string[]) => Promise<ExecResult>
    const result = (exitCode = 0, stderr = ''): ExecResult => ({
      command: 'docker',
      exitCode,
      signal: null,
      stdout: '',
      stderr,
      durationMs: 0
    })
    /**
     * Fake docker CLI: `local` tags exist, `published` tags are on the registry;
     * `manifest` / `pull` replace the registry's answers.
     */
    const fakeDocker = (
      local: string[],
      published: string[],
      over: { manifest?: Answer; pull?: Answer } = {}
    ): { calls: string[][]; run: typeof exec } => {
      const calls: string[][] = []
      const run = async (_cmd: string, args: readonly string[] = []): Promise<ExecResult> => {
        calls.push([...args])
        const tag = args.at(-1) ?? ''
        if (args[0] === 'image') return result(local.includes(tag) ? 0 : 1)
        if (args[0] === 'manifest') {
          if (over.manifest) return over.manifest(args)
          return published.includes(tag)
            ? result()
            : result(1, `no such manifest: docker.io/${tag}`)
        }
        if (args[0] === 'pull' && over.pull) return over.pull(args)
        return result()
      }
      return { calls, run }
    }
    /** `image inspect`, `manifest inspect`, `pull <tag>`, `build <context>`. */
    const verbs = (calls: string[][]): string[] =>
      calls.map(c =>
        c[0] === 'pull' || c[0] === 'build' ? `${c[0]} ${c.at(-1)}` : `${c[0]} ${c[1]}`
      )
    const pullFails =
      (stderr: string): Answer =>
      async args => {
        throw new ExecError({
          command: `docker ${args.join(' ')}`,
          exitCode: 1,
          signal: null,
          stdout: '',
          stderr
        })
      }

    it('reuses a local image without touching the registry', async () => {
      const d = fakeDocker(['gameci:x'], [])
      expect(await ensureImage({ pull: 'gameci:x', build, timeoutMs: 1, run: d.run })).toEqual({
        tag: 'gameci:x',
        how: 'cached'
      })
      expect(verbs(d.calls)).toEqual(['image inspect'])
    })

    it('reuses an earlier fallback build before asking the registry', async () => {
      const d = fakeDocker([build.tag], [])
      const onWarning = vi.fn()
      const got = await ensureImage({
        pull: 'gameci:x',
        build,
        timeoutMs: 1,
        run: d.run,
        onWarning
      })
      expect(got).toEqual({ tag: build.tag, how: 'cached' })
      expect(verbs(d.calls)).toEqual(['image inspect', 'image inspect'])
      expect(onWarning).not.toHaveBeenCalled()
    })

    it('pulls a published image for the given platform', async () => {
      const d = fakeDocker([], ['gameci:x'])
      const got = await ensureImage({
        pull: 'gameci:x',
        build,
        platform: 'linux/amd64',
        timeoutMs: 1,
        run: d.run
      })
      expect(got).toEqual({ tag: 'gameci:x', how: 'pulled' })
      expect(verbs(d.calls)).toEqual([
        'image inspect',
        'image inspect',
        'manifest inspect',
        'pull gameci:x'
      ])
      expect(d.calls.at(-1)).toEqual(['pull', '--platform', 'linux/amd64', 'gameci:x'])
    })

    it('builds locally when the registry does not publish the tag', async () => {
      const d = fakeDocker([], [])
      const warnings: string[] = []
      const got = await ensureImage({
        pull: 'gameci:x',
        build,
        platform: 'linux/amd64',
        timeoutMs: 1,
        run: d.run,
        onWarning: m => warnings.push(m)
      })
      expect(got).toEqual({ tag: build.tag, how: 'built' })
      expect(warnings).toEqual([expect.stringMatching(/^gameci:x is not published: building /)])
      expect(verbs(d.calls)).toEqual([
        'image inspect',
        'image inspect',
        'manifest inspect',
        'build /d'
      ])
      expect(d.calls.at(-1)).toEqual(
        expect.arrayContaining(['--platform', 'linux/amd64', 'UNITY_CHANGESET=abcdef123456'])
      )
    })

    it('lets the pull decide when the registry check fails for another reason', async () => {
      const d = fakeDocker([], [], {
        manifest: async () => result(1, 'toomanyrequests: You have reached your pull rate limit')
      })
      const got = await ensureImage({ pull: 'gameci:x', build, timeoutMs: 1, run: d.run })
      expect(got).toEqual({ tag: 'gameci:x', how: 'pulled' })
    })

    it('fails on a pull error other than "not found", without building', async () => {
      const d = fakeDocker([], ['gameci:x'], { pull: pullFails('net/http: TLS handshake timeout') })
      await expect(
        ensureImage({ pull: 'gameci:x', build, timeoutMs: 1, run: d.run })
      ).rejects.toBeInstanceOf(ExecError)
      expect(verbs(d.calls)).not.toContain('build /d')
    })

    it('builds when only the pull says the tag is missing (probe timed out, containerd store)', async () => {
      const d = fakeDocker([], [], {
        manifest: async () => {
          throw new TimeoutError(120_000)
        },
        pull: pullFails(
          'Error response from daemon: failed to resolve reference "docker.io/gameci:x": docker.io/gameci:x: not found'
        )
      })
      const got = await ensureImage({ pull: 'gameci:x', build, timeoutMs: 1, run: d.run })
      expect(got).toEqual({ tag: build.tag, how: 'built' })
    })

    it('stops when the job is cancelled during the registry check', async () => {
      const d = fakeDocker([], [], {
        manifest: async () => {
          throw new AbortError()
        }
      })
      await expect(
        ensureImage({ pull: 'gameci:x', build, timeoutMs: 1, run: d.run })
      ).rejects.toBeInstanceOf(AbortError)
      expect(verbs(d.calls)).toEqual(['image inspect', 'image inspect', 'manifest inspect'])
    })

    it('pulls without probing when there is no fallback', async () => {
      const d = fakeDocker([], [])
      await ensureImage({ pull: 'my/img:1', timeoutMs: 1, run: d.run })
      expect(verbs(d.calls)).toEqual(['image inspect', 'pull my/img:1'])
    })

    it('build only: reuses the local image, else builds it', async () => {
      const cached = fakeDocker([build.tag], [])
      expect(await ensureImage({ build, timeoutMs: 1, run: cached.run })).toEqual({
        tag: build.tag,
        how: 'cached'
      })
      const fresh = fakeDocker([], [])
      expect(await ensureImage({ build, timeoutMs: 1, run: fresh.run })).toEqual({
        tag: build.tag,
        how: 'built'
      })
      expect(verbs(fresh.calls)).toEqual(['image inspect', 'build /d'])
    })

    it('needs a changeset to build', async () => {
      const d = fakeDocker([], [])
      const noChangeset = { ...build, changeset: async (): Promise<undefined> => undefined }
      await expect(
        ensureImage({ build: noChangeset, timeoutMs: 1, run: d.run })
      ).rejects.toMatchObject({ code: 'E_UNITY_CHANGESET' })
    })

    it('treats only "no such tag" registry answers as not published', () => {
      for (const s of [
        'no such manifest: docker.io/unityci/editor:ubuntu-1-android-3',
        'manifest for unityci/editor:x not found: manifest unknown: manifest unknown',
        'failed to resolve reference "docker.io/unityci/editor:x": docker.io/unityci/editor:x: not found'
      ])
        expect(s).toMatch(NOT_PUBLISHED)
      for (const s of [
        'toomanyrequests: You have reached your pull rate limit',
        'unauthorized: authentication required',
        'no matching manifest for linux/arm64/v8 in the manifest list entries',
        'failed to resolve reference "docker.io/x:y": dial tcp: lookup registry-1.docker.io: no such host'
      ])
        expect(s).not.toMatch(NOT_PUBLISHED)
    })
  })

  describe('imagePlan', () => {
    const build = {
      tag: 'ci-unity-editor:v-android',
      version: 'v',
      changeset: async (): Promise<string | undefined> => undefined,
      modules: ['android'],
      dockerfile: '/d/Dockerfile'
    }
    const plan = (o: Partial<Parameters<typeof imagePlan>[0]>): ReturnType<typeof imagePlan> =>
      imagePlan({
        source: 'auto',
        version: 'v',
        modules: ['android'],
        gameciVersion: '3',
        build,
        ...o
      })

    it('docker-image wins over every source', () => {
      expect(plan({ dockerImage: 'mirror/unity:1', source: 'build' })).toEqual({
        pull: 'mirror/unity:1'
      })
    })
    it('auto pulls GameCI with the local build as fallback', () => {
      expect(plan({})).toEqual({ pull: 'unityci/editor:ubuntu-v-android-3', build })
    })
    it('auto builds when 2+ modules are needed', () => {
      expect(plan({ modules: ['android', 'ios'] })).toEqual({ build })
    })
    it('gameci never builds, build never pulls', () => {
      expect(plan({ source: 'gameci' })).toEqual({ pull: 'unityci/editor:ubuntu-v-android-3' })
      expect(plan({ source: 'build' })).toEqual({ build })
    })
    it('gameci with 2+ modules is an input error', () => {
      expect(() => plan({ source: 'gameci', modules: ['android', 'ios'] })).toThrow(InputError)
      expect(() => plan({ source: 'gameci', modules: ['android', 'ios'] })).toThrow(
        /docker-image-source: .*android, ios/
      )
    })
  })

  describe('docker mode warnings', () => {
    const base = {
      argv: ['-quit', '-logFile', '-', '-projectPath', '/project'],
      buildTarget: 'Android' as string | undefined,
      autoModules: true,
      hostOnlyInputs: [] as string[]
    }

    it('says nothing for a plain build', () => {
      expect(dockerWarnings(base)).toEqual([])
    })

    it('warns when no -buildTarget leaves the base image', () => {
      expect(dockerWarnings({ ...base, buildTarget: undefined })).toEqual([
        expect.stringMatching(/^No -buildTarget/)
      ])
      expect(dockerWarnings({ ...base, buildTarget: undefined, autoModules: false })).toEqual([])
    })

    it('names the host-only inputs it ignores', () => {
      expect(dockerWarnings({ ...base, hostOnlyInputs: ['editor-path', 'hub-path'] })).toEqual([
        'editor-path, hub-path only apply to mode: host and are ignored in mode: docker (the default since v3)'
      ])
    })

    it('flags paths the container cannot see', () => {
      expect(
        pathsOutsideProject([
          '/project',
          '/project/Builds/x.apk',
          '-',
          'Builds/x.apk',
          'GameBuildCheck.AndroidDebugApk',
          '/dev/stdout',
          '/home/runner/work/g/g/Builds/x.apk',
          '/project/../out.apk',
          '/projectX/a',
          '/tmp/x.apk',
          'C:\\out\\x.apk',
          '\\\\share\\x'
        ])
      ).toEqual([
        '/home/runner/work/g/g/Builds/x.apk',
        '/project/../out.apk',
        '/projectX/a',
        '/tmp/x.apk',
        'C:\\out\\x.apk',
        '\\\\share\\x'
      ])
      expect(dockerWarnings({ ...base, argv: ['-customBuildPath', '/tmp/x.apk'] })).toEqual([
        expect.stringMatching(/^"\/tmp\/x\.apk" is outside the project/)
      ])
    })
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
