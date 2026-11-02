import { parseAllDocuments } from 'yaml'
import { CiError } from '../../sdk/src/index.js'

export interface UnityProjectInfo {
  companyName: string
  productName: string
  bundleVersion: string
  webScreenWidth: string
  webScreenHeight: string
}

const UNITY_TAG_PREFIX = 'tag:unity3d.com,2011:'

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const str = (v: unknown, fallback = ''): string =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : fallback

/**
 * Parse `ProjectSettings/ProjectSettings.asset` (Unity YAML 1.1 with `!u!` tags).
 * Unity's custom tags only produce "Unresolved tag" warnings, so the maps are
 * read as plain objects; the failsafe schema keeps every scalar a string
 * (versions like `1.10` stay `1.10`, not `1.1`).
 */
export function parseProjectSettings(text: string): UnityProjectInfo {
  // Unity always writes the `%TAG !u!` directive, but trimmed/hand-edited files
  // may lack it, which makes `!u!129` an unresolvable tag (a hard error).
  const source = /^%TAG !u! /m.test(text) ? text : `%TAG !u! ${UNITY_TAG_PREFIX}\n${text}`
  const docs = parseAllDocuments(source, { schema: 'failsafe', uniqueKeys: false })
  const list = Array.isArray(docs) ? docs : [docs]

  for (const doc of list) {
    if (doc.errors.length > 0) {
      throw new CiError(
        'E_UNITY_SETTINGS',
        `Cannot parse ProjectSettings: ${doc.errors.map(e => e.message).join('; ')}`
      )
    }
    const data: unknown = doc.toJS()
    const settings = isRecord(data) ? data.PlayerSettings : undefined
    if (!isRecord(settings)) continue
    return {
      companyName: str(settings.companyName),
      productName: str(settings.productName),
      bundleVersion: str(settings.bundleVersion),
      webScreenWidth: str(settings.defaultScreenWidthWeb, '0'),
      webScreenHeight: str(settings.defaultScreenHeightWeb, '0')
    }
  }
  throw new CiError('E_UNITY_SETTINGS', 'PlayerSettings not found in ProjectSettings file')
}
