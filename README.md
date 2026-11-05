# ci-sdk

Shared TypeScript SDK and the JavaScript actions of the CI system, rebuilt on top of
it. Successor of the `actions` branch of `sdk` (template submodule + `script/build.js`).

Actions are published to the `runner` branch and used as before:

```yaml
- uses: <owner>/ci-sdk/.github/actions/runs-on@runner
  with:
    branch: develop*, main, !develop_old
```

The repository is public so that workflows in other orgs can use the actions (GitHub shares a
private repository's actions only within its own org). `@runner` follows every publish, breaking
ones included (v3.0.0 changed the `unity-build` default, see below). Workflows that must not change
under them pin a commit of the `runner` branch instead: `.../unity-build@<runner commit sha> # v3.0.0`.

## Layout

```text
packages/
  sdk/                  shared library (not an action)
  eval/                 {secrets:X} / {vars:X} / {github:path} template interpolation
  extract-unity-serial/ serial from a Unity .ulf license
  runs-on/              allow a job only on some branches (globs supported)
  string-interpolate/   pass a value through, optionally masked
  unity-project-info/   read ProjectSettings.asset (company, name, version, web size)
  run/                  NEW: run commands with retries, timeouts and a job summary
  unity-build/          NEW: replaces the unity-build composite (Docker by default, or host)
  unity-force-segment/  NEW: force a UA segment in the Adjust SDK for a QA build, then restore
  gdrive-upload/        NEW: upload a file to a Google Shared Drive folder with a service account key
  unity-android-build-script/ NEW: CI-only Unity build script: signed AAB/APK, version from a tag, then restore
  aab-to-apk/           NEW: universal APK from an AAB (pinned bundletool), signed with the same keystore
  team-chat/            NEW: CI run report -> team chat webhook card (Block Kit, escaped, limits, retries)
  compose-deploy/       NEW: SSH deploy of a Compose service (backup, pull, up, health, rollback)
  docker-smoke/         NEW: run a container, wait for health, dump logs, always clean up
  release-gate/         NEW: release waits for a green CI run of the same commit; tag == version
  release-assets/       NEW: upload files + SHA256SUMS to a GitHub Release, marked notes section
scripts/build.mjs       bundles each action -> dist/<name>/{action.yml,dist/index.js}
```

Each action is `action.yml` + `src/index.ts` (entrypoint) + `src/main.ts` (logic) + `__tests__/`.

## Commands

| Command                                                       | What it does                                         |
| ------------------------------------------------------------- | ---------------------------------------------------- |
| `npm run build`                                               | Bundle all actions (in parallel) into `dist/<name>/` |
| `node scripts/build.mjs runs-on eval`                         | Bundle only some actions                             |
| `npm test` / `npm run ci-test`                                | Unit tests (vitest) / with coverage                  |
| `npm run lint` / `npm run typecheck` / `npm run format:check` | Static checks                                        |
| `npm run all`                                                 | Everything, in CI order                              |

Run a built action locally exactly like the runner does (inputs are `INPUT_<NAME>` env vars):

```bash
GITHUB_REF=refs/heads/develop INPUT_BRANCH='develop*' node dist/runs-on/dist/index.js
env 'INPUT_RUN=npm ci' INPUT_RETRIES=2 'INPUT_RETRY-DELAY=5s' node dist/run/dist/index.js
```

## Publishing

`.github/workflows/publish.yml` runs on every push to `actions`: lint, typecheck, test,
build, then copies `dist/<name>/` into `runner:.github/actions/<name>/` and pushes. Only the
folders of the actions built here are replaced; composite actions and reusable workflows on
`runner` are not touched. `ci.yml` runs the same checks on PRs and executes the built actions.

Actions run on `node24` (Node 20 actions are deprecated). Self-hosted runners must be recent
enough to support `node24`.

## Writing an action with the SDK

```ts
// packages/my-action/src/main.ts
import * as core from '@actions/core'
import { Pipeline, input, readInputs, writeJobSummary } from '../../sdk/src/index.js'

export async function run(): Promise<void> {
  // Typed and validated; every bad input is reported at once.
  const cfg = readInputs({
    bucket: input.string({ required: true }),
    keep: input.number({ default: 3, min: 1, integer: true }),
    timeout: input.duration({ default: '10m' }), // -> milliseconds
    token: input.string({ required: true, secret: true }) // masked in logs
  })

  const report = await new Pipeline({ name: 'upload', timeout: '30m' })
    .step('upload', ctx => ctx.exec('mc', ['put', 'Build/game.apk', `${cfg.bucket}/game.apk`]), {
      retry: { attempts: 3, minDelay: '5s' }, // flaky network
      timeout: cfg.timeout // kills the whole process tree
    })
    .step(
      'notify',
      async () => {
        /* ... */
      },
      { continueOnError: true }
    )
    .always('cleanup', ctx => ctx.exec('mc', ['alias', 'rm', 'tmp'])) // runs even on failure/cancel
    .run()

  await writeJobSummary(report)
  if (report.status !== 'success') core.setFailed(`upload ${report.status}`)
}
```

`src/index.ts` is always:

```ts
import { runAction } from '../../sdk/src/index.js'
import { run } from './main.js'

await runAction(run) // any thrown error -> core.setFailed, exit code 1
```

### SDK modules

| Export                                                                           | Purpose                                                                                                                                         |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `readInputs`, `input.*`                                                          | `string`, `number`, `boolean` (true/yes/on/1), `list`, `lines`, `oneOf`, `duration`, `json`                                                     |
| `getCiContext()`                                                                 | Typed `GITHUB_*` env: repo, branch (PR head aware), PR number, run URL, `uniqueName()`                                                          |
| `exec(cmd, args, opts)`                                                          | No shell, live log + captured output, `timeout`/`signal` kill the process tree (`killGrace`, also per reason), Windows `.cmd` shims work        |
| `parseCommandLine(line)`                                                         | Shell-free argv splitting (quotes, escapes; no pipes/globs)                                                                                     |
| `retry(fn, opts)`                                                                | Exponential backoff + jitter, `retryIf`, abortable                                                                                              |
| `withTimeout(fn, ms)`                                                            | Time budget with an AbortSignal handed to `fn`                                                                                                  |
| `Pipeline`                                                                       | Steps with `retry`, `timeout`, `continueOnError`, `if`, `always`; SIGINT/SIGTERM (run cancelled) stops the running step and still runs cleanup  |
| `writeJobSummary`, `reportToMarkdown`                                            | Results table on the run page                                                                                                                   |
| `group`, `mask`, `annotate`                                                      | Timed log groups, secret masking (incl. base64/URL forms), file annotations                                                                     |
| `printUntrusted`, `withoutCommands`                                              | Print or stream untrusted output (container logs, remote scripts) inside `::stop-commands::`, so `::error::`-like lines are shown, not executed |
| `resolveKeystore`, `generateKeystore`, `removeWrittenKeystore`                   | Android release keystore: secret inputs, else the ProjectSettings or project-root keystore (password = file name); generate one by convention   |
| `runAction`                                                                      | Entrypoint wrapper                                                                                                                              |
| `CiError`, `InputError`, `TimeoutError`, `AbortError`, `RetryError`, `ExecError` | Errors with a stable `code`                                                                                                                     |

## `run` action

```yaml
- uses: <owner>/ci-sdk/.github/actions/run@runner
  with:
    name: install
    run: |
      pnpm install --frozen-lockfile
      pnpm run build
    retries: 2 # extra attempts per line, for flaky network steps
    retry-delay: 10s # doubles each attempt, with jitter
    timeout: 15m # per attempt; process tree is killed
    shell: none # none (default, no injection) | bash | sh | pwsh
```

Outputs: `status`, `failed-steps` (JSON), `duration-ms`, `report` (JSON). A results list is
added to the job summary.

## `unity-build` action

Replaces the `unity-build` composite (same `version`, `workdir`, `default-args-override`, `args`
inputs), with:

> Since v3.0.0 the default is `mode: docker`. The old composite (and v2.x) used the editor installed
> on the runner: set `mode: host` to keep that. In docker mode the container sees only `workdir`
> (at `/project`), `keystore-path` and `unity-license-file`: write build output under `$(pwd)`
> (e.g. `-customBuildPath $(pwd)/Builds/game.apk`), not to `${{ github.workspace }}` or
> `${{ runner.temp }}` paths, which the action warns about. Give `-buildTarget` in `args`: it
> picks the image (without it the container gets the base editor, Linux standalone only).
> With a subfolder `workdir` the repository's `.git` is not mounted: BuildScripts that call git
> should read the forwarded `GITHUB_SHA` / `GITHUB_RUN_NUMBER` instead. v2 docker-mode workflows
> with their own `dockerfile`: set `docker-image-source: build`, or `auto` uses the GameCI image
> (with a warning that the Dockerfile was not used).

- **Secrets in env, not argv**: `keystore-*` inputs reach Unity as `UNITY_KEYSTORE_PATH`,
  `UNITY_KEYSTORE_PASS`, `UNITY_KEYALIAS_NAME`, `UNITY_KEYALIAS_PASS`. The action's own `INPUT_*`
  variables are removed from Unity's environment. Passwords left in `args` still work but warn.
- **Timeouts**: `timeout` (default 3h) and `idle-timeout` (default 30m without any log line =
  hung) kill the Unity process tree (or the container). Keep the job's `timeout-minutes` above
  `timeout` + the image pull + 5 min (the container's stop, below): a job stopped by its own limit
  counts as cancelled, so `if: failure()` steps (the log upload) are skipped.
- **Docker by default** (`mode: docker`): the runner only needs Docker. The editor image is the
  prebuilt [GameCI](https://game.ci/docs/docker/docker-images) image of the project's version,
  `unityci/editor:ubuntu-<version>-<module>-3` (module from `-buildTarget`: `android`, `ios`,
  `webgl`, `windows-mono`, `mac-mono`, ...; `base` for Linux), pulled once and then reused from the
  runner's Docker cache. Upgrading Unity = changing `ProjectVersion.txt`; nothing to install.
  - GameCI has no image for that version, or the build needs 2+ modules: `docker-image-source: auto`
    builds `ci-unity-editor:<version>-<modules>` from
    [`assets/Dockerfile`](packages/unity-build/assets/Dockerfile) (Ubuntu + Unity Hub CLI) once per
    Docker daemon. `gameci` fails instead, `build` always builds locally, `docker-image` forces an
    image (e.g. your own registry mirror). `gameci-version` pins the GameCI release (`3.2.2`).
  - License: `unity-license-file` (.ulf, mounted read-only), or `unity-serial` + `unity-email` +
    `unity-password` (all three required; activated in the container against an empty project,
    returned after the build, also after a timeout, a hung editor or a cancel; a seat that could
    not be returned is a warning with the end of Unity's log, except after a cancel: free it in your
    Unity account). Personal license:
    read the serial from the .ulf with `extract-unity-serial` (example below); these `F...` serials
    get a fresh machine id in every container, as GameCI does.
  - The project is bind-mounted at `/project`, Gradle caches live in the `ci-unity-gradle` volume
    (`clean-gradle-cache: true` removes it first), and files go back to the owner of the project
    folder (the runner user; a no-op on rootless Docker).
  - `CI` and the GitHub context variables (`GITHUB_SHA`, `GITHUB_RUN_NUMBER`, `GITHUB_REF_NAME`,
    ...) are forwarded into the container; other variables need `docker-env`.
  - Images run as `linux/amd64` (`docker-platform`; `none` leaves it to the daemon): the Unity
    Linux editor is x86_64 only.
- **`mode: host`** (opt-in) **finds Unity on every OS** from `version`, else `UNITY_VER`, else `ProjectVersion.txt`: Hub
  registered editors, Hub secondary install path, default Hub folders (Windows/macOS/Linux),
  `/opt/unity/editors`, `editors-dir`, pre-Hub installs.
- **Host-mode license** from `unity-serial` + `unity-email` + `unity-password` (all three
  required), for runners where nobody can sign in to Unity Hub (e.g. a Windows service account):
  after the editor is found or installed, it runs once against an empty project in `RUNNER_TEMP`
  (`<editor> -batchmode -nographics -quit -logFile <tmp> -projectPath <blank> -serial <s> -username <e> -password <p>`,
  as in Unity's
  [command-line activation](https://docs.unity.com/en-us/engine/6000.0/manual/get-started/install-and-upgrade/licenses-and-activation/managing-your-unity-license)).
  Unity documents this for paid serials; a Personal serial read from a .ulf with
  `extract-unity-serial` is activated the same way in docker mode (as GameCI does).
  - Skipped when the machine-wide license file already holds this serial and has not expired
    (`%PROGRAMDATA%\Unity\Unity_lic.ulf`, `/Library/Application Support/Unity/Unity_lic.ulf`,
    `~/.local/share/unity3d/Unity/Unity_lic.ulf`). That file is only a hint (the server may have
    revoked the seat), so every license retry of the build activates again; with
    `license-retries: 0` the action always activates.
  - Failures are retried like license errors (`license-retries`, `license-retry-delay`, 10 min per
    attempt) and then fail the step with `failure-kind: license` and the license lines of Unity's
    log, with the serial, email and password replaced by `***`. The log itself (it echoes the
    command line) and the blank project are deleted.
  - `return-license: auto` (default) keeps the seat: the machine persists and other runners on it
    use the same machine-wide license. `true` runs `-returnlicense` after the build, also after a
    failure, a timeout or a cancel (a cancel leaves about 10 s before the runner kills the action, so
    the return may not finish). In docker mode the container always returns its seat.
  - `unity-license-file` stays docker-only: a .ulf is bound to the machine it was made for, and
    copying one over the machine-wide file would also replace the license of other runners there.
- **Installs what is missing** with the Unity Hub headless CLI (`install`, `install-modules
--childModules`); modules come from `-buildTarget` (Android → `android`) or `modules`.
- **Retries only license errors** (`license-retries`, default 2). A run that also shows compile,
  build or exception errors is never retried.
- **Job summary** with the errors from the Unity log (compile errors also become annotations), and
  outputs `status`, `failure-kind` (`license|build|timeout|hang`), `log-file`, `errors`.

```yaml
- id: serial # Personal license: the UNITY_LICENSE secret holds the .ulf content
  uses: <owner>/ci-sdk/.github/actions/extract-unity-serial@runner
  with:
    license: ${{ secrets.UNITY_LICENSE }}

- name: Build APK
  uses: <owner>/ci-sdk/.github/actions/unity-build@runner
  with:
    version: ${{ vars.UNITY_VER }} # optional: default is ProjectSettings/ProjectVersion.txt
    args: ${{ inputs.apk-build-args }} # e.g. -buildTarget Android -> unityci/editor:ubuntu-<ver>-android-3
    unity-serial: ${{ steps.serial.outputs.serial }} # or a Plus/Pro serial secret
    unity-email: ${{ secrets.UNITY_EMAIL }}
    unity-password: ${{ secrets.UNITY_PASSWORD }}
    keystore-path: ${{ inputs.keystore-path }}
    keystore-alias: ${{ inputs.keystore-name }}
    keystore-password: ${{ secrets.KEYSTORE_PASSWORD }}
    keystore-alias-password: ${{ secrets.KEYSTORE_ALIAS_PASSWORD }}

- uses: actions/upload-artifact@<sha> # v7
  if: failure()
  with:
    name: unity-log
    path: ${{ runner.temp }}/unity-build-*.log
```

Host mode on a self-hosted Windows runner (the editor is found under
`C:\Program Files\Unity\Hub\Editor\<version>\Editor\Unity.exe`, or installed with Hub):

```yaml
jobs:
  build:
    runs-on: [self-hosted, Windows, runner-windows]
    steps:
      - uses: actions/checkout@<sha> # v7
        with:
          clean: false # keep Library/ between builds on a persistent runner

      - id: serial
        uses: <owner>/ci-sdk/.github/actions/extract-unity-serial@runner
        with:
          license: ${{ secrets.UNITY_LICENSE }}

      - uses: <owner>/ci-sdk/.github/actions/unity-build@runner
        with:
          mode: host
          args: -buildTarget Android
          unity-serial: ${{ steps.serial.outputs.serial }}
          unity-email: ${{ secrets.UNITY_EMAIL }}
          unity-password: ${{ secrets.UNITY_PASSWORD }}
          # return-license: true # only if no other runner on this machine shares the license
```

The `BuildScript` must read the keystore from the environment (Unity has no built-in flag for it).
Keep the flag as a fallback so old workflows still build:

```csharp
static string Arg(string flag, string envVar)
{
    var value = System.Environment.GetEnvironmentVariable(envVar);
    if (!string.IsNullOrEmpty(value)) return value;
    var args = System.Environment.GetCommandLineArgs();
    var i = System.Array.IndexOf(args, flag);
    return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
}

PlayerSettings.Android.useCustomKeystore = true;
PlayerSettings.Android.keystoreName = Arg("-keystoreName", "UNITY_KEYSTORE_PATH");
PlayerSettings.Android.keystorePass = Arg("-keystorePassword", "UNITY_KEYSTORE_PASS");
PlayerSettings.Android.keyaliasName = Arg("-keystoreAliasName", "UNITY_KEYALIAS_NAME");
PlayerSettings.Android.keyaliasPass = Arg("-keystoreAliasPassword", "UNITY_KEYALIAS_PASS");
```

Also make the build method call `EditorApplication.Exit(1)` on failure; the action additionally
fails on `Build Finished, Result: Failure` when Unity exits 0.

## `unity-force-segment` action

Builds a "segment QA" player, one build per segment of the segment file: `mode: list` returns the
segment names (a matrix input), `mode: apply` temporarily patches the vendored Adjust Unity SDK (v5,
namespace `AdjustSdk`) so every attribution Adjust calls back with is replaced by the forced one,
and optionally the IP-country source; `mode: restore` puts every file back. Game code is never
changed in the repository, so any game can test a UA segment. The patched files are for the CI
build only and must never be committed.

Inputs: `mode` (`apply` default, `restore` or `list`), `config` (segment file relative to
`project-path`, default `segment-ci.yml`), `segment` (`apply`: a segment `name`, or `none`/empty to
do nothing; `list`: a filter, see below), `project-path` (default `.`).

```yaml
# segment-ci.yml
segments:
  - name: iaproas-us # required, [a-z0-9][a-z0-9-]{0,39}, unique ("all" and "none" are reserved)
    campaign: QA_IAPROAS # required key, may be "" (organic), max 200 chars
    network: ForcedSegment # optional, default ForcedSegment
    adgroup: '' # optional
    creative: '' # optional
    tracker-name: '' # optional, default "<network>::<campaign>"
    country: US # optional ISO 3166-1 alpha-2; forces the IP country source too
```

The file is validated strictly (unknown keys, wrong types, duplicate names all fail with a clear
message). Values are escaped for C# string literals.

`mode: list` reads the file and outputs `segments` (compact JSON array of names, in file order),
`details` (the same segments as `{name, campaign, network, country}` objects, for a build table)
and `count`. The `segment` input filters: empty or `all` = every segment, `none` = `[]`, or a
comma-separated list of names (each must exist; a filter with no name, like `,`, fails). A missing file gives `[]` / `0` with a notice. It
changes nothing in the project. Typical use: a `list` job feeds
`strategy.matrix.segment: ${{ fromJSON(needs.segments.outputs.segments) }}`, and each matrix job
applies one segment. A matrix over `[]` fails the workflow, so guard the matrix job with
`if: needs.<job>.outputs.count != '0'`.

Outputs of `apply`: `enabled` (`true` when a segment was applied), `name`, `campaign`, `network`,
`adgroup`, `creative`, `tracker-name`, `country`, `json` (the segment as one compact JSON object:
`name`, `campaign`, `network`, `adgroup`, `creative`, `trackerName`, `country`, `""` when unset) and
`patched` (newline-separated project-relative paths of the files changed or added). `enabled` is
`false` (with a notice, not an error) when the segment is `none`/empty. A missing file or an unknown
name fails.

What `apply` changes:

1. The single `*.cs` under `Assets` that declares `public static void InitSdk(AdjustConfig ...)`
   inside `class Adjust` (normally `Assets/Adjust/Scripts/Adjust.cs`; the platform layers
   `AdjustAndroid`/`AdjustiOS` are not it; `Library`, `Temp`, `obj`, hidden and `~` folders are
   skipped; commented-out code never matches): the first statement of `InitSdk`, `GetAttribution` and, when present,
   `GetAttributionWithTimeout` wraps the callback with `AdjustCiForcedSegment.Wrap` (in `InitSdk`
   guarded by a null check, as the SDK's own check comes after). Each inserted
   line ends with `// ci-sdk unity-force-segment`. `InitSdk` and `GetAttribution` are required
   ("Adjust SDK layout not supported" otherwise), and so is a readable `GetAttributionWithTimeout`
   when the file declares one. A file that already has the marker fails with
   "already patched; run mode: restore first".
2. A new `AdjustCiForcedSegment.cs` next to it (the forced values; the real attribution is replaced
   even when Adjust answered nothing). An existing `.meta` is kept.
3. With `country`: every `*.cs` with `public static [async] Task<string> GetIpCountryCodeAsync()` (the
   Databuckets tracker) returns the country first. No such method fails the step.

Line endings and the BOM of every edited file are kept. Before the first change the original bytes
are saved to `$RUNNER_TEMP/ci-sdk-unity-force-segment/state.json` (OS temp dir when unset), so
`restore` is byte-exact, also after an `apply` that died half way, and deletes the added file and
its `.meta`. Without a state (e.g. a fresh `RUNNER_TEMP`), `restore` still deletes a generated
`AdjustCiForcedSegment.cs` (and `.meta`) left under `Assets` by a hard-killed job, found by its
header; when nothing is found it is a no-op notice. Call it before the first build too. `apply`
first restores a state left by a job that never restored (self-hosted runners). The state is
written atomically; one that cannot be read, or whose project folder is gone, is dropped.

```yaml
- uses: <owner>/ci-sdk/.github/actions/unity-force-segment@runner
  with:
    segment: ${{ inputs.segment }}
- uses: <owner>/ci-sdk/.github/actions/unity-build@runner
  # ...
- uses: <owner>/ci-sdk/.github/actions/unity-force-segment@runner
  if: always()
  with:
    mode: restore
```

## `gdrive-upload` action

Uploads one file (an APK, a build zip) into a folder of a Google **Shared Drive** with a service
account key, and outputs `id`, `link` (webViewLink), `name` and `size`. No gcloud, no credentials
file on the runner and no IAM role: the access token is minted from the key itself (OAuth 2.0 JWT
bearer grant, signed RS256), and registered with the log masker.

Inputs: `service-account-key` (JSON key, required), `folder-id` (required), `file` (required),
`name` (default the local file name), `mime-type` (default from the extension), `attempts`
(default 3).

- The folder must be inside a Shared Drive that has the service account as a member (Content
  manager). A My Drive folder shared with the service account fails with `storageQuotaExceeded`
  (a service account has no storage of its own); the error says so, and it is not retried.
- Resumable upload, streamed from disk (never held in memory). 429, 5xx and network errors are
  retried with backoff; other 4xx errors (bad folder, auth, quota) fail at once.

Upload from the job that built the file: a self-hosted runner often downloads GitHub artifacts
far slower than it uploads, so a separate job that downloads every artifact to upload it again
can cost minutes per file.

```yaml
- id: drive
  if: env.HAVE_DRIVE == 'true'
  uses: <owner>/ci-sdk/.github/actions/gdrive-upload@runner
  with:
    service-account-key: ${{ secrets.GDRIVE_SERVICE_ACCOUNT_KEY }}
    folder-id: ${{ secrets.GDRIVE_FOLDER_ID }}
    file: Builds/game.apk
    name: game_${{ github.run_number }}.apk
# ${{ steps.drive.outputs.link }}
```

## Android release signing (keystore resolution)

`unity-android-build-script` and `aab-to-apk` pick the release keystore the same way
(`resolveKeystore` in the SDK), so one workflow works for every game without per-game setup:

1. **Keystore inputs**, when any of them is set: `keystore-base64`, `keystore-password`,
   `keystore-alias`, `keystore-alias-password` (from the secrets `KEYSTORE_BASE64`,
   `KEYSTORE_PASSWORD`, `KEYSTORE_ALIAS`, `KEYSTORE_ALIAS_PASSWORD`). All four are required
   together; a partial set fails and names the missing ones (sources are never mixed). The file is
   written under `$RUNNER_TEMP` (mode 0600) and deleted when the action is done (`aab-to-apk`) or
   by `mode: restore` (`unity-android-build-script`). The values are masked: GitHub hides a
   secret's value in every log line and drops a job output holding it, so do not use a common
   word (an alias like `release`) or the repository name as one. bundletool reads the passwords
   from files, but takes the alias on its command line.
2. Otherwise the **project keystore**: `AndroidKeystoreName` (`{inproject}:` resolved against the
   project) and `AndroidKeyaliasName` from `ProjectSettings/ProjectSettings.asset`, when that file
   exists.
3. Otherwise a **keystore at the project root** (`*.keystore` / `*.jks` next to `Assets`), else
   one **committed anywhere in the project** (`git ls-files`; Android `debug.keystore` files are
   skipped): the only one, or `<keystore-name>.keystore` (default the repository name) among
   several. Its alias is the one ProjectSettings gives the same file name, else the convention
   below.
4. Otherwise, with `generate-keystore: true` (`unity-android-build-script` only), the keystore of
   the default branch, or a **new one** committed there (see that action). That mode also checks a
   keystore of steps 2 and 3 that git does not track against the default branch. Without it, the step
   **fails before the build** with code `E_NO_KEYSTORE`, explaining the options. A release is never
   signed with a debug key.

The project convention for 2 to 4: **password = keystore file name without its extension** for the
store and the key, **alias = that name in lower case** (e.g. `My-Game.keystore` -> password
`My-Game`, alias `my-game`). The file must be committed (`*.keystore` is often gitignored: add a
`!/My-Game.keystore` exception).

An unset secret reaches the action as an empty input, so passing all four secrets always is safe.
A PKCS12 keystore and its password are checked before the build ("wrong store password"); a JKS
keystore cannot be checked here (warning), the build will tell.

## `unity-android-build-script` action

Adds a CI-only Editor build script to a Unity project for one build (signed AAB or APK, version
from a tag), then puts the project back byte-exact. The game needs no build script of its own.

Inputs: `mode` (`apply` default, or `restore`), `project-path` (default `.`), `format` (`aab`
default, or `apk`), `output` (relative to the project, default `Builds/release.<format>`),
`version` (`vX.Y.Z` or `X.Y.Z`, e.g. `${{ github.ref_name }}`; empty keeps the project's),
`version-code` (instead of the derived one), `development` (default `false`), `signing`
(`release` default, or `debug` = Unity debug key), the four keystore inputs above,
`generate-keystore` (default `false`), `commit-keystore` (default `true`), `keystore-name`
(default the repository name), `github-token` (default `github.token`) and `editor-path` (Unity
editor, to find keytool).

**`generate-keystore: true`** handles a project with no keystore at all (step 4 above), so a game
needs no signing setup before its first release. The **default branch is the reference**, so a
game never gets a second key. This mode needs a git checkout of the repository it runs for
(`remote.origin.url` must name `GITHUB_REPOSITORY`) and `github-token`; without them it stops
rather than guess (one exception below).

- A keystore committed in this commit, or given as secrets, is used as it is (no API call). So is
  one ProjectSettings points to outside the repository (kept on the runner). Without a git checkout,
  only a keystore ProjectSettings names by an absolute path outside the project folder is used,
  unchecked; any other stops the step.
- A keystore found but **not tracked by git** (one an earlier run generated and never committed,
  left in a persistent checkout, or one copied by hand; inside the project or elsewhere in the
  repository) is compared with this game's keystores on the default branch (in the project folder,
  at that path, or where ProjectSettings points; another game's key in the same repository does not
  count). The same file there: used. None there: used, and committed like a new one (with a
  warning when the same file sits outside the project folder, e.g. another game's key). Otherwise
  the step **fails before the build** (delete that copy, e.g. a run with a clean checkout).
- No keystore: every `*.keystore` / `*.jks` of the default branch under the project folder is
  listed (one trees API call; `debug.keystore` is ignored). The file at the path ProjectSettings
  names (any file name, even outside the project folder), else `<keystore-name>.keystore` at the
  project root, else the only keystore there when it is at the root, is written into the checkout
  and used. Any other keystore there stops the step: tag a commit that has it. A tree too large
  for one call stops the step too.
- Only when the default branch has none is a new one generated, and only when `project-path` is a
  Unity project (`Assets` and `ProjectSettings/ProjectSettings.asset`). It uses keytool (the Unity
  editor's OpenJDK, from `editor-path` or `ProjectVersion.txt`, else `JAVA_HOME`, else the OpenJDK
  of any installed Unity editor, else PATH): PKCS12, RSA 2048, valid 10000 days, password = its
  name, alias = its name in lower case (or the alias ProjectSettings gives that file name), at the
  project root. When ProjectSettings names another keystore that is missing, there is a warning:
  if Google Play knows that key, find and commit it instead.
- A keystore that is not on the default branch (only a `*.keystore` / `*.jks` file) is then
  **committed there** through the contents API with `github-token`, at the path git gives (`Game/`
  for a project in a subfolder, spelled as on the branch), so every later release signs with it.
  The job needs `permissions: contents: write`. A refused commit (409/422) is retried while the
  file is still absent. When another release committed a keystore first, a generated one is
  dropped for it, and a found one stops the step. A failed commit (a protected branch) is a
  warning and `keystore-committed: false`: commit the file yourself before the next release.
- **`commit-keystore: false`** keeps the build job read-only: the action does everything but the
  commit, and a later job with `contents: write` commits the file to `keystore-repo-path` (upload
  it as an artifact in between) whenever `keystore-committed` is `false`.

Version mapping: bundleVersion `X.Y.Z`, version code `X*10000 + Y*100 + Z` (`v1.0.2` -> `10002`).
A version that is not strict `X.Y.Z` (`v1.2`, `v1.2.3-rc1`, `v01.2.3`) or has Y or Z >= 100 fails
at once.

Outputs: `execute-method` (pass to Unity with `-executeMethod`), `output` (absolute),
`version-name`, `version-code`, `keystore-path` (absolute), `keystore-source` (`explicit`,
`project-settings`, `project-file`, `default-branch`, `generated`, or empty for debug),
`keystore-committed` (for a keystore that is not in this commit: `true` when it is on the
default branch, `false` when it still has to be committed; empty otherwise),
`keystore-commit-url`, `keystore-repo-path` (the keystore's path in the repository when it is not
in this commit) and `patched`.
The keystore outputs are set as soon as the keystore is ready, so they are there even when the
step fails afterwards.

What `apply` adds: `Assets/CiSdkBuild/CiSdkAndroidBuild.cs` and an editor-only assembly definition
next to it (so it compiles in projects with their own asmdefs too). The script builds the scenes
enabled in Build Settings with `BuildOptions.None` (or `Development`), sets the version for this
build only, signs with the custom keystore, checks the result and the output file, exits non-zero
on failure, and restores the PlayerSettings it changed. Keystore values from the secret inputs are
**not** written into the script: Unity reads them from `UNITY_KEYSTORE_PATH`,
`UNITY_KEYSTORE_PASS`, `UNITY_KEYALIAS_NAME` and `UNITY_KEYALIAS_PASS`, which the `unity-build`
`keystore-*` inputs set. A path in the environment always wins (docker mode maps it). The password,
alias and alias password come as a set: all from the environment when any of them is there, else
all baked, so two keystores are never mixed; a missing one fails the build by name. The project convention
values (not secrets) are baked in, so a game that follows it needs no configuration.

`restore` deletes the folder (and its `.meta`), rewrites any saved file byte-exact and deletes a
keystore written from `keystore-base64`. The state is kept in
`$RUNNER_TEMP/ci-sdk-unity-android-build-script/state.json`; without it, `restore` still removes a
generated folder left by a hard-killed job (found by its header) and stray written keystores. An
`Assets/CiSdkBuild` folder the action did not generate is never touched (`apply` fails). `apply`
first restores a state left by a job that never restored (self-hosted runners).

```yaml
- id: script
  uses: <owner>/ci-sdk/.github/actions/unity-android-build-script@runner
  with:
    version: ${{ github.ref_name }}
    output: Builds/game.aab
    keystore-base64: ${{ secrets.KEYSTORE_BASE64 }}
    keystore-password: ${{ secrets.KEYSTORE_PASSWORD }}
    keystore-alias: ${{ secrets.KEYSTORE_ALIAS }}
    keystore-alias-password: ${{ secrets.KEYSTORE_ALIAS_PASSWORD }}
- id: build
  uses: <owner>/ci-sdk/.github/actions/unity-build@runner
  with:
    mode: host
    default-args-override: -batchmode -nographics -silent-crashes -quit -logFile - -executeMethod ${{ steps.script.outputs.execute-method }}
    args: -buildTarget Android
    keystore-path: ${{ steps.script.outputs.keystore-path }}
    keystore-password: ${{ secrets.KEYSTORE_PASSWORD }}
    keystore-alias: ${{ secrets.KEYSTORE_ALIAS }}
    keystore-alias-password: ${{ secrets.KEYSTORE_ALIAS_PASSWORD }}
- uses: <owner>/ci-sdk/.github/actions/unity-android-build-script@runner
  if: always()
  with:
    mode: restore
```

## `aab-to-apk` action

Turns an Android App Bundle into one installable universal APK with
`bundletool build-apks --mode=universal`, signed with the same keystore, so QA installs exactly
what goes to the store.

Inputs: `aab` (required), `output` (default the `.aab` path with `.apk`), `project-path` (default
`.`, for the project keystore), `signing` (`release` default, or `debug` = bundletool's
`~/.android/debug.keystore` when present), the four keystore inputs above, `keystore-name`
(default the repository name, preferred among several keystores at the project root), `java-path`,
`editor-path` (the `unity-build` output), `bundletool-version` / `bundletool-sha256`, `timeout`
(default `20m`). Outputs: `apk-path`, `size`, `java`, `bundletool`.

- **bundletool** is pinned (1.18.3) and downloaded once into the runner tool cache
  (`$RUNNER_TOOL_CACHE/bundletool/<version>/`). Its sha256 is checked on download and on every
  use: a bad download fails, a changed cached jar is downloaded again. Another version needs its
  `bundletool-sha256`.
- **java**: `java-path`, else `$JAVA_HOME/bin/java`, else the OpenJDK of the Unity editor in
  `editor-path` (`<Editor>/Data/PlaybackEngines/AndroidPlayer/OpenJDK`), else `java` on PATH. A
  `java-path` that does not exist fails.
- Passwords reach bundletool as `--ks-pass=file:` / `--key-pass=file:` files in a private temp
  folder, never on the command line; the folder and any written keystore are deleted afterwards.
- `universal.apk` is extracted from the `.apks` with its size and CRC-32 checked.

```yaml
- id: apk
  uses: <owner>/ci-sdk/.github/actions/aab-to-apk@runner
  with:
    aab: ${{ steps.script.outputs.output }}
    editor-path: ${{ steps.build.outputs.editor-path }}
    keystore-base64: ${{ secrets.KEYSTORE_BASE64 }}
    keystore-password: ${{ secrets.KEYSTORE_PASSWORD }}
    keystore-alias: ${{ secrets.KEYSTORE_ALIAS }}
    keystore-alias-password: ${{ secrets.KEYSTORE_ALIAS_PASSWORD }}
# ${{ steps.apk.outputs.apk-path }}
```

## `team-chat` action

Posts one CI run report to a team chat incoming webhook (a Slack Block Kit subset). The workflow
only assembles a `report` JSON from its job results; the action builds the message and sends it.

A webhook message cannot be edited or threaded, so a run posts two messages:

- **START** (`"phase": "start"`), right before the first Unity build: `🛠️ Game · Đang build
Debug #128 · 7 bản (normal + 6 segment)`, the run's fields (ref, commit, version, game, build,
  actor, event, runner, start time), the planned builds (`"status": "planned"`) and an `info`
  alert with the run link.
- **END** (default), exactly one per run, picked from `jobs` (`needs.<job>.result`) and
  `status` (`messageVariant`): `✅`/`🚀` success, `⚠️` partial (the run failed but every main
  build exists: only segments or an upload failed), `❌` failure (the failed step, the log link,
  what finished) and `🚫` cancelled (duration, the stage it was in, what finished, and "superseded
  by run #N" when `supersededBy` is set). A cancelled job wins over a failed one. Run the notify
  job with `if: always()` so a cancelled run still posts its END message; it is posted even when
  START never was.

Inputs: `webhook-url` (secret; empty = nothing sent, notice), `report` (JSON) or `report-file`,
`payload-file` (also write the webhook body there, to preview it), `dry-run` (build, write
`payload-file`, send nothing), `attempts` (default 3). Outputs: `sent`, `status`, `text`.

The message:

- `text`: one line, the push notification and sidebar preview (with `blocks`, only the blocks show
  in the channel), e.g. `✅ Game · Debug #128 · 7/7 builds OK · 12m34s`,
  `🚀 Game · Release v1.0.2 (10002) ready`, `❌ Game · Release v1.0.2 failed at Unity build`,
  `🚫 Game · Debug #128 cancelled after 12m34s · during segment builds · superseded by run #129`.
- `header`, a `section` of fields (branch/tag/PR, commit, version, duration, game, build, actor,
  event, runner, start time), a `table` with one row per build (Build, Campaign and Country when
  there are segments, Status/Result, Link to Drive / the GitHub artifact / the Unity log; no links
  in START), `alert`s (`info`: START; `success`: all green / a release is ready; `error`: a main
  build failed, with the log link; `default`: cancelled; `warning`: only segments or uploads
  failed, files on the artifact fallback, report warnings), the changelog as a bullet list (newest
  10, then "+N earlier") and a `context` footer (`GitHub Actions · repo · Run #N · ci-sdk vX.Y.Z`).
- Untrusted text (branch, commit subjects, actor, segment names) goes into `plain_text` or literal
  `rich_text` elements, or is escaped (`& < >`) in mrkdwn, so it can never form a mention,
  `<!channel>` or a link. A word joiner (U+2060, invisible) also goes into `://`, after a `.`
  before a letter and after `@` (mrkdwn, the header, link labels, table cells and the changelog), so the
  server does not turn a plain URL, a domain or an `@name` into a link. The action itself never
  writes a mention.
- Limits: 50 blocks, blocks kept under 14,000 bytes (the server allows 16 kB after normalising),
  header 150, fields 2,000, alerts 3,000 (name lists and warning lines are kept whole, then
  "+N more"), table 100 rows / 10,000 characters, lengths in UTF-16 units without splitting an
  emoji. Over a limit the changelog is shortened first, then table rows (main builds and failures
  kept, then "+N more (see the run)"), then the table is dropped.

Sending: UTF-8 JSON (`Content-Type: application/json; charset=utf-8`). 429 waits for
`Retry-After` (at most 2 min), 5xx backs off 5 s then 30 s, at most 3 tries; any other status,
a redirect (not followed) or a network error stops at once (a POST that may have arrived is not
sent twice). A 502/504 from a proxy after the server took the message could still post it twice.
A failure is a warning with the status and the first line of the response body
(e.g. `HTTP 404 no_active_hooks`), never a failed step. Logs show at most the first 12 characters
of the `ma=` key, never the URL; the key is masked too, decoded and as written in the URL.

Report (unknown keys are ignored; strings may be untrusted):

```json
{
  "name": "BGPZ-005-Gem",
  "kind": "release",
  "status": "failure",
  "failedStep": "AAB to APK",
  "game": "Gem Blast",
  "platform": "Android",
  "clean": false,
  "project": { "name": "acme/BGPZ-005-Gem", "url": "https://github.com/acme/BGPZ-005-Gem" },
  "run": { "url": "https://github.com/acme/BGPZ-005-Gem/actions/runs/1", "number": 131 },
  "ref": { "type": "tag", "name": "v1.0.2" },
  "commit": { "sha": "abcdef0123", "url": "https://github.com/...", "subject": "chore: release" },
  "actor": "dev",
  "durationSeconds": 1800,
  "version": { "name": "1.0.2", "code": 10002 },
  "builds": [
    {
      "name": "AAB (store)",
      "kind": "aab",
      "status": "success",
      "link": "https://drive...",
      "size": 167772160
    },
    {
      "name": "APK (QA, universal)",
      "kind": "apk",
      "status": "failure",
      "failedStep": "AAB to APK",
      "logUrl": "https://..."
    }
  ],
  "changelog": [
    { "sha": "abcdef0123", "subject": "chore: release", "author": "dev", "url": "https://..." }
  ],
  "warnings": [],
  "logUrl": "https://..."
}
```

`kind` is `debug` or `release`; `phase` is `start` or `end` (default); `status` is `success`,
`failure` or `cancelled` (default `success`; a `cancelled` or `failure` value in `jobs` wins);
`jobs` maps job names to `needs.<job>.result`; `failedStep` is what failed, or the stage a
cancelled run was in; `supersededBy` is `{ "number": 129, "url": "..." }`; `event`, `runner` and
`startedAt` (already formatted) are shown as fields; `ref.type` is `branch`, `tag` or `pr`
(`title` for a PR); `builds[].kind` is `normal`, `segment`, `aab` or `apk` (only `segment` builds
are extras); `builds[].status` is `success`, `failure`, `skipped`, `cancelled` or `planned`;
`fallback: true` marks a link to the GitHub artifact instead of Drive; `campaign: ""` shows as
`(organic)`. Text fields must be strings (`version.code` and `run.number` may be numbers).

```yaml
- id: report
  uses: actions/github-script@<sha>
  with:
    script: core.setOutput('json', JSON.stringify({ /* the report */ }))
- if: always()
  continue-on-error: true
  uses: <owner>/ci-sdk/.github/actions/team-chat@runner
  with:
    webhook-url: ${{ secrets.CHAT_WEBHOOK_URL }}
    report: ${{ steps.report.outputs.json }}
```

Preview without posting: `dry-run: true` with `payload-file: chat.json`.

## `compose-deploy` action

Replaces the `appleboy/ssh-action` deploy script copied between projects (tool-gen-level-*): over
SSH it backs up Postgres, pulls, runs `docker compose up -d --remove-orphans`, checks health and
rolls back to the previous image when `compose up` or the health check fails.

- **Nothing secret in argv**: settings reach the VPS as an `export` preamble on the stdin of
  `ssh ... 'sh -s'` (the script is wrapped in a function run with `</dev/null`, so commands that
  read stdin cannot eat it). Password auth uses `SSH_ASKPASS` with the password in the environment
  (Linux/macOS runners); `ssh-key` is written to a `0600` temp file. Temp files are always removed.
- **Registry login** (`registry-username`/`registry-password`) uses a temporary `DOCKER_CONFIG` on the
  VPS, removed afterwards, so the host's own logins are untouched. If the host's `config.json` uses a
  credential helper (`credsStore`/`credHelpers`), or the docker CLI finds an installed
  `pass`/`secretservice` helper, the credentials may be kept by that helper.
- **Host keys**: pass `known-hosts` (`ssh-keyscan -p 22 host` output). Without it the first key is
  accepted (`accept-new`) and a warning is printed.
- **Health**: `health-command` runs in the service container, `health-url` is fetched on the VPS
  (curl, else wget); with neither, the container's `HEALTHCHECK` status, else "running".
- **Backup** (`backup: postgres`): `pg_dump -Fc` of `db-service` into `backup-dir`, keeping the
  newest `backup-keep`; skipped on a first deploy (no db container), fatal if the dump fails.
- Outputs `status` (`deployed`, `rolled-back`, `failed`), `previous-image-id`, `image-id`,
  `backup-file`; the step fails unless `deployed`. A job summary lists them.

```yaml
deploy-vps:
  needs: docker-publish
  runs-on: ubuntu-latest
  timeout-minutes: 30
  environment: production
  steps:
    - uses: <owner>/ci-sdk/.github/actions/compose-deploy@runner
      with:
        host: ${{ secrets.VPS_HOST }}
        port: ${{ secrets.VPS_PORT || '22' }}
        username: ${{ secrets.VPS_USER }}
        password: ${{ secrets.VPS_PASSWORD }} # or ssh-key: ${{ secrets.VPS_SSH_KEY }}
        known-hosts: ${{ vars.VPS_KNOWN_HOSTS }}
        directory: /root/toolgenlevelmanhunt
        compose-file: docker-compose.production.yml
        env: |
          DOCKER_IMAGE=hungtrinh203/human-hunt-level-editor:latest
          APP_PORT=8092
        backup: postgres
        health-command: python -c 'import os, urllib.request; urllib.request.urlopen("http://127.0.0.1:%s/api/health" % os.getenv("PORT", "5000"), timeout=5)'
```

## `docker-smoke` action

Replaces the "`docker run` → poll health → `docker logs` on failure → `docker rm` in `if: always()`"
steps. The container name is unique per run attempt and step (`smoke-<run_id>-<attempt>-<step id>`), so parallel jobs
on a shared Docker daemon do not collide.

- Health: `health-url` (polled from the runner; `expect-status` `2xx` or `200,204`, optional
  `expect-body`), `health-command` (`docker exec <name> sh -c ...`), else the image `HEALTHCHECK`,
  else "running". Fails at once if the container exits, with its exit code.
- `env` / `secret-env` values are passed through the docker CLI's environment (`-e KEY`), never
  argv; `secret-env` values are masked.
- `keep: true` leaves a healthy container running for later steps; the action's `post` step removes
  it (and a `network` it created) even when the job fails or is cancelled. A failed check always
  removes it right away after dumping `log-lines` of logs.

```yaml
- uses: <owner>/ci-sdk/.github/actions/docker-smoke@runner
  with:
    image: ${{ env.SMOKE }}:test
    secret-env: |
      MASTER_ENCRYPTION_KEY=${{ secrets.CI_MASTER_KEY }}
    health-command: /lsm healthcheck
    health-retries: 15
    health-interval: 1s

- id: be
  uses: <owner>/ci-sdk/.github/actions/docker-smoke@runner
  with:
    image: bibg-backend:ci
    network: bibg-ci-be-net
    ports: 127.0.0.1:18181:8080
    env: |
      DATABASE_URL=postgres://bibg:bibg@bibg-ci-pg:5432/bibg
    health-url: http://127.0.0.1:18181/api/v1/health
    keep: true # later steps call the API; removed in the post step
```

## `release-gate` action

For workflows that build on `push` and publish on `release`: the release run first waits (up to
`timeout`, default 60 min) for a green run of `workflow` (default: the current workflow file) for
the same commit, triggered by one of `events` (default `push, workflow_dispatch`), so a release
never ships an untested SHA. The current run is ignored.

- Passes as soon as one matching run succeeded; keeps waiting while one is still running.
- Fails at once when every matching run finished without success (e.g. the push run was cancelled
  by `cancel-in-progress`), and after `no-run-grace` (default 5 min) when no matching run is listed
  at all. The message says how to fix it: run the workflow with `workflow_dispatch` on the release
  tag, then re-run the failed release jobs.
- Transient API errors and rate limits are retried until `timeout`; a 401/403/404 fails at once.
- With `version-file` (`Cargo.toml`, `package.json` or `pyproject.toml`) it also checks
  `tag == tag-prefix + version`; `skip-ci-check: true` does only that check.

Needs `permissions: actions: read`.

```yaml
release-gate:
  if: github.event_name == 'release'
  runs-on: light
  timeout-minutes: 75
  permissions:
    actions: read
  steps:
    - uses: actions/checkout@<sha> # only needed for version-file
      with:
        persist-credentials: false
    - uses: <owner>/ci-sdk/.github/actions/release-gate@runner
      with:
        version-file: Cargo.toml
```

Jobs that also run outside releases and need `release-gate` must use
`if: ${{ !cancelled() && (needs.release-gate.result == 'success' || needs.release-gate.result == 'skipped') }}`:
a skipped `needs` otherwise skips the whole chain.

## `release-assets` action

Uploads `files` (paths, directories or globs) to the release of `tag` (default: the release that
triggered the run; drafts are found too), writes `SHA256SUMS` (`checksums: ''` to skip) and sets
the `notes` markdown between `<!-- <notes-id>:start/end -->` markers in the release body, where
`{checksums}` expands to the checksum list. Re-runs replace assets of the same name and the marked
section, so they are idempotent. Needs `permissions: contents: write`.

```yaml
- uses: <owner>/ci-sdk/.github/actions/release-assets@runner
  with:
    files: release-assets/*
    notes: |
      ## Binaries

      ~~~text
      {checksums}
      ~~~
```

## Changes from v1 (behaviour notes)

- **extract-unity-serial**: v1 called `core.setSecret('serial')` (the literal word), so the real
  serial was **not masked**. It is now masked before being set as output. A license without
  `<DeveloperData>` is now reported (v1's check could never trigger).
- **runs-on**: patterns support globs (`develop*`, `release/**`) and `!exclusions`, so the long
  list of `develop_*` branches can be one pattern. Tag pushes are reported clearly instead of
  matching `refs/tags/...`. Exact names behave as before.
  On pull requests the checked branch is the PR **head** branch (`GITHUB_HEAD_REF`), which the PR
  author chooses, exactly like v1: do not use `runs-on` alone to protect deploys or secrets; use
  `environment:` protection rules for that.
- **eval**: same `{provider:path}` syntax and v1 `github` keys (`repo.owner`, `payload.*`,
  `eventName`, `runId`...), plus workflow-style aliases (`ref_name`, `event.*`...). Values `0`
  and `false` are now substituted; unresolved placeholders are kept and logged as warnings;
  An empty `template` still returns `''` (k8s-deploy passes `submodules: ""`); a missing event
  payload falls back to `{}`. Quoted bracket paths (`a["b-c"]`) are no longer supported (use
  `a.b-c`). `lodash.get` removed.
- **unity-project-info**: errors (missing file, bad YAML, no `PlayerSettings`) fail the step
  with a clear message instead of an unhandled rejection; versions like `1.10` stay `1.10`; `yup` removed.
- **All actions**: invalid inputs are listed together, stack traces only in debug logs, `node24`.

## Known limits

- `exec` returns about 1 s after the direct child exits, even if it left a background process
  holding the output pipes (same as a `run:` step). On timeout/cancel the whole process group is
  killed on Linux/macOS; on Windows `taskkill /T` can only reach processes whose parent is still
  alive.
- When a run is cancelled, the runner sends SIGINT and force-kills about 10 s later. A step that
  ignores SIGTERM can use up to ~7 s of that (process-group reap), leaving `always` steps little time:
  keep cleanup steps short.
- **unity-build**: Hub install on Windows needs the runner service to have admin rights
  (Program Files). Two jobs installing the same version on one machine at once are not locked.
  In Docker mode `-serial` is on the command line _inside_ the container (Unity has no other way).
  In host mode the serial, email and password are on the editor's command line on the runner
  itself, visible to other processes of that machine while it activates or returns: use it on a
  single-tenant self-hosted machine. Two jobs activating the same serial on one machine at once
  are not locked (both write the same machine-wide license file).
  After a timeout or a hung editor the action stays attached for up to 5 min while the container
  stops Unity (SIGKILL after 30 s), returns the seat and restores file ownership, so the output of
  that (e.g. a seat that could not be returned) still reaches the log; on cancel it only signals
  the container, which finishes that on its own and removes itself. The container's `--stop-timeout`
  asks the Docker daemon for the same 5 min when it shuts down; a container killed sooner (the host
  goes away, or an ephemeral runner pod with a shorter termination grace period is deleted right
  after a cancelled job) does not return its seat. The editor in Docker is the Linux editor: Android, WebGL,
  Windows/macOS/Linux standalone build there, iOS exports the Xcode project (compiling and signing
  it still needs macOS). GameCI images are `linux/amd64` only: an arm64 host (Apple Silicon, ARM
  Linux) can only emulate them (slow, not tested with Unity), so prefer x86_64 runners. They are
  5-13 GB compressed: on GitHub-hosted runners free disk space first; on self-hosted runners
  remove old versions with `docker image rm <tag>` (plain `docker image prune` keeps tagged
  images; `docker image prune -a --filter label=ci-sdk.unity.version` removes unused local builds,
  `docker builder prune` the build cache they leave behind).
- **unity-build** with the Docker daemon in another container (Kubernetes/ARC `dind` sidecar):
  bind mounts are resolved on the daemon's side, so `workdir`, `keystore-path` and
  `unity-license-file` must be in a folder both containers share (the runner's `_work`: the
  workspace and `RUNNER_TEMP`). A file in `/tmp` or `$HOME` passes the action's check but shows up
  as an empty folder in the container.
- Logs and the job summary show commands and errors verbatim (no escaping or truncation) so the
  runner's masker can find secrets. Still, prefer passing secrets through `env` or stdin
  (`exec(..., { input })`) rather than argv.
