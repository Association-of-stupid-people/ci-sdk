# ci-sdk

Shared TypeScript SDK and the JavaScript actions of the CI system, rebuilt on top of
it. Successor of the `actions` branch of `sdk` (template submodule + `script/build.js`).

Actions are published to the `runner` branch and used as before:

```yaml
- uses: <owner>/sdk/.github/actions/runs-on@runner
  with:
    branch: develop*, main, !develop_old
```

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
  unity-build/          NEW: replaces the unity-build composite (host or Docker, see below)
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

| Export                                                                           | Purpose                                                                                                                                        |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `readInputs`, `input.*`                                                          | `string`, `number`, `boolean` (true/yes/on/1), `list`, `lines`, `oneOf`, `duration`, `json`                                                    |
| `getCiContext()`                                                                 | Typed `GITHUB_*` env: repo, branch (PR head aware), PR number, run URL, `uniqueName()`                                                         |
| `exec(cmd, args, opts)`                                                          | No shell, live log + captured output, `timeout`/`signal` kill the process tree, Windows `.cmd` shims work                                      |
| `parseCommandLine(line)`                                                         | Shell-free argv splitting (quotes, escapes; no pipes/globs)                                                                                    |
| `retry(fn, opts)`                                                                | Exponential backoff + jitter, `retryIf`, abortable                                                                                             |
| `withTimeout(fn, ms)`                                                            | Time budget with an AbortSignal handed to `fn`                                                                                                 |
| `Pipeline`                                                                       | Steps with `retry`, `timeout`, `continueOnError`, `if`, `always`; SIGINT/SIGTERM (run cancelled) stops the running step and still runs cleanup |
| `writeJobSummary`, `reportToMarkdown`                                            | Results table on the run page                                                                                                                  |
| `group`, `mask`, `annotate`                                                      | Timed log groups, secret masking (incl. base64/URL forms), file annotations                                                                    |
| `runAction`                                                                      | Entrypoint wrapper                                                                                                                             |
| `CiError`, `InputError`, `TimeoutError`, `AbortError`, `RetryError`, `ExecError` | Errors with a stable `code`                                                                                                                    |

## `run` action

```yaml
- uses: <owner>/sdk/.github/actions/run@runner
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

- **Secrets in env, not argv**: `keystore-*` inputs reach Unity as `UNITY_KEYSTORE_PATH`,
  `UNITY_KEYSTORE_PASS`, `UNITY_KEYALIAS_NAME`, `UNITY_KEYALIAS_PASS`. The action's own `INPUT_*`
  variables are removed from Unity's environment. Passwords left in `args` still work but warn.
- **Timeouts**: `timeout` (default 3h) and `idle-timeout` (default 30m without any log line =
  hung) kill the Unity process tree (or the container).
- **Finds Unity on every OS** from `version`, else `UNITY_VER`, else `ProjectVersion.txt`: Hub
  registered editors, Hub secondary install path, default Hub folders (Windows/macOS/Linux),
  `/opt/unity/editors`, `editors-dir`, pre-Hub installs.
- **Installs what is missing** with the Unity Hub headless CLI (`install`, `install-modules
--childModules`); modules come from `-buildTarget` (Android → `android`) or `modules`.
- **Retries only license errors** (`license-retries`, default 2). A run that also shows compile,
  build or exception errors is never retried.
- **Job summary** with the errors from the Unity log (compile errors also become annotations), and
  outputs `status`, `failure-kind` (`license|build|timeout|hang`), `log-file`, `errors`.
- **`mode: docker`**: builds `ci-unity-editor:<version>-<modules>` from
  [`assets/Dockerfile`](packages/unity-build/assets/Dockerfile) (Ubuntu + Unity Hub CLI) the first
  time a version is needed on that Docker daemon, then builds inside it. License: `unity-license-file`
  (.ulf, mounted read-only) or `unity-serial` + `unity-email` + `unity-password` (activated in the
  container and returned after the build). `docker-image` uses a prebuilt image from a registry.

```yaml
- name: Build APK
  uses: <owner>/sdk/.github/actions/unity-build@runner
  with:
    version: ${{ vars.UNITY_VER }}
    args: ${{ inputs.apk-build-args }}
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
  In Docker mode `-serial` is on the command line _inside_ the container (Unity has no other way);
  a container killed on timeout does not return its serial seat. The Docker image is Linux-only
  (Android/WebGL/Linux targets; iOS still needs a macOS host).
- Logs and the job summary show commands and errors verbatim (no escaping or truncation) so the
  runner's masker can find secrets. Still, prefer passing secrets through `env` or stdin
  (`exec(..., { input })`) rather than argv.
