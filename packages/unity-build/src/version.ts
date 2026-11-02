import { errorMessage } from '../../sdk/src/index.js'

export interface ProjectVersion {
  version: string
  /** Short revision hash ("changeset"), needed by Unity Hub for versions it does not list. */
  changeset?: string
}

/** e.g. 2022.3.20f1, 6000.0.23f1, 2021.3.45f1c1 (China releases). */
export const UNITY_VERSION = /^\d{4}\.\d+\.\d+[abfpx]\d+(?:c\d+)?$/

/** Parse `ProjectSettings/ProjectVersion.txt`. */
export function parseProjectVersion(text: string): ProjectVersion | undefined {
  const withRevision = /m_EditorVersionWithRevision:\s*(\S+)\s*\(([0-9a-f]+)\)/.exec(text)
  if (withRevision?.[1] && withRevision[2]) {
    return { version: withRevision[1], changeset: withRevision[2] }
  }
  const plain = /m_EditorVersion:\s*(\S+)/.exec(text)
  return plain?.[1] ? { version: plain[1] } : undefined
}

const RELEASES_API = 'https://services.api.unity.com/unity/editor/release/v1/releases'

/**
 * Look up the changeset of a Unity version with Unity's public release API.
 * Returns undefined (never throws) when the API is unreachable or does not
 * know the version; callers then fall back to installing without a changeset.
 */
export async function lookupChangeset(
  version: string,
  options: { fetch?: typeof fetch; timeoutMs?: number; onWarning?: (m: string) => void } = {}
): Promise<string | undefined> {
  const doFetch = options.fetch ?? fetch
  const url = `${RELEASES_API}?version=${encodeURIComponent(version)}&limit=5`
  try {
    const res = await doFetch(url, { signal: AbortSignal.timeout(options.timeoutMs ?? 15_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = (await res.json()) as { results?: { version?: string; shortRevision?: string }[] }
    const match = body.results?.find(r => r.version === version)
    return match?.shortRevision || undefined
  } catch (err) {
    options.onWarning?.(`Could not look up the changeset of Unity ${version}: ${errorMessage(err)}`)
    return undefined
  }
}
