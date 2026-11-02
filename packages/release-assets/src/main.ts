import * as core from '@actions/core'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  CiError,
  GitHubApiError,
  GitHubClient,
  getCiContext,
  input,
  readEventPayload,
  readInputs
} from '../../sdk/src/index.js'
import {
  assertAssetNames,
  assertChecksumsName,
  assertUniqueNames,
  buildUploadUrl,
  checksumText,
  renderNotes,
  replaceNotesBlock,
  resolveFiles,
  sha256File,
  type LocalFile
} from './lib.js'

interface Asset {
  id: number
  name: string
  size: number
  browser_download_url: string
}

interface Release {
  id: number
  html_url: string
  upload_url: string
  tag_name: string
  body: string | null
}

export interface AssetInfo {
  name: string
  size: number
  url: string
}

function resolveTag(explicit: string | undefined): string {
  if (explicit) return explicit
  const ctx = getCiContext()
  const fromEvent = readEventPayload<{ release?: { tag_name?: string } }>(ctx)?.release?.tag_name
  if (fromEvent) return fromEvent
  if (ctx.refType === 'tag' && ctx.refName) return ctx.refName
  throw new CiError('E_NO_TAG', 'No release tag: set the `tag` input or run on a release/tag event')
}

/** Tag lookup first; drafts have no tag endpoint, so fall back to scanning all releases. */
async function findRelease(gh: GitHubClient, repo: string, tag: string): Promise<Release> {
  try {
    return (await gh.request<Release>(`/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`))
      .data
  } catch (err) {
    if (!(err instanceof GitHubApiError) || err.status !== 404) throw err
  }
  const releases = await gh.paginate<Release>(`/repos/${repo}/releases`)
  const found = releases.find(r => r.tag_name === tag)
  if (!found) throw new CiError('E_NO_RELEASE', `No release found for tag "${tag}"`)
  return found
}

const listAssets = async (gh: GitHubClient, repo: string, releaseId: number): Promise<Asset[]> =>
  gh.paginate<Asset>(`/repos/${repo}/releases/${releaseId}/assets`)

const deleteAsset = async (gh: GitHubClient, repo: string, id: number): Promise<unknown> =>
  gh.request(`/repos/${repo}/releases/assets/${id}`, { method: 'DELETE' })

async function postAsset(gh: GitHubClient, release: Release, file: LocalFile): Promise<Asset> {
  const res = await gh.request<Asset>(buildUploadUrl(release.upload_url, file.name), {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: new Uint8Array(await readFile(file.path))
  })
  return res.data
}

/** Fail loudly if GitHub stored the asset under a different name than requested. */
function checked(file: LocalFile, asset: Asset): Asset {
  if (asset.name !== file.name) {
    throw new CiError('E_ASSET_NAME', `GitHub stored "${file.name}" as "${asset.name}"`)
  }
  return asset
}

async function uploadAsset(
  gh: GitHubClient,
  repo: string,
  release: Release,
  file: LocalFile,
  overwrite: boolean,
  existing: Asset[]
): Promise<Asset> {
  if (overwrite) {
    for (const old of existing.filter(a => a.name === file.name)) {
      core.info(`Deleting existing asset ${old.name}`)
      await deleteAsset(gh, repo, old.id)
    }
  }
  try {
    return checked(file, await postAsset(gh, release, file))
  } catch (err) {
    // 422 = name already taken, e.g. a retried request that had in fact succeeded.
    if (!overwrite || !(err instanceof GitHubApiError) || err.status !== 422) throw err
    core.info(`Asset ${file.name} already exists, replacing it`)
    for (const old of (await listAssets(gh, repo, release.id)).filter(a => a.name === file.name)) {
      await deleteAsset(gh, repo, old.id)
    }
    return checked(file, await postAsset(gh, release, file))
  }
}

export async function run(): Promise<void> {
  const cfg = readInputs({
    token: input.string({ required: true, secret: true }),
    tag: input.string(),
    files: input.lines({ default: [] }),
    failIfNoFiles: input.boolean({ name: 'fail-if-no-files', default: true }),
    // No code default: action.yml supplies SHA256SUMS, an explicit empty value disables it.
    checksums: input.string(),
    notes: input.string(),
    notesId: input.string({ name: 'notes-id', default: 'ci-sdk-release-assets' }),
    overwrite: input.boolean({ default: true })
  })

  const ctx = getCiContext()
  if (!ctx.repository) throw new CiError('E_NO_REPO', 'GITHUB_REPOSITORY is not set')
  const repo = ctx.repository.fullName
  const tag = resolveTag(cfg.tag)
  const gh = new GitHubClient({ token: cfg.token })

  if (cfg.checksums) assertChecksumsName(cfg.checksums)
  const files = await resolveFiles(cfg.files, ctx.workspace ?? process.cwd())
  assertAssetNames(files.map(f => f.name))
  if (files.length === 0 && cfg.files.length > 0 && cfg.failIfNoFiles) {
    throw new CiError('E_NO_FILES', `No files matched: ${cfg.files.join(', ')}`)
  }
  if (files.length === 0) core.warning('No files to upload')

  const release = await findRelease(gh, repo, tag)
  core.info(`Release ${release.tag_name} (id ${release.id})`)

  const tmpDir = await mkdtemp(path.join(ctx.runner.temp ?? os.tmpdir(), 'release-assets-'))
  try {
    let text = ''
    const uploads: LocalFile[] = [...files]
    if (cfg.checksums && files.length > 0) {
      const entries = await Promise.all(
        files.map(async f => ({ name: f.name, sha256: await sha256File(f.path) }))
      )
      text = checksumText(entries)
      const sumsPath = path.join(tmpDir, cfg.checksums)
      await writeFile(sumsPath, text)
      uploads.push({ path: sumsPath, name: cfg.checksums })
    }
    assertUniqueNames(uploads)

    const existing = await listAssets(gh, repo, release.id)
    if (!cfg.overwrite) {
      const clash = uploads.find(u => existing.some(a => a.name === u.name))
      if (clash) {
        throw new CiError(
          'E_ASSET_EXISTS',
          `Asset "${clash.name}" already exists (overwrite=false)`
        )
      }
    }

    const assets: AssetInfo[] = []
    for (const upload of uploads) {
      const asset = await uploadAsset(gh, repo, release, upload, cfg.overwrite, existing)
      core.info(`Uploaded ${asset.name} (${asset.size} bytes)`)
      assets.push({ name: asset.name, size: asset.size, url: asset.browser_download_url })
    }

    if (cfg.notes) {
      // Fresh body (by id, works for drafts): parallel jobs may have edited it during the uploads.
      const fresh = (await gh.request<Release>(`/repos/${repo}/releases/${release.id}`)).data
      const body = replaceNotesBlock(fresh.body ?? '', cfg.notesId, renderNotes(cfg.notes, text))
      await gh.request(`/repos/${repo}/releases/${release.id}`, { method: 'PATCH', body: { body } })
      core.info('Release notes updated')
    }

    core.setOutput('release-id', String(release.id))
    core.setOutput('release-url', release.html_url)
    core.setOutput('assets', JSON.stringify(assets))
    core.setOutput('checksums', text)
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
}
