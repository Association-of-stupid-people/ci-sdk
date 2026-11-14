import { createHash } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { CiError } from '../../sdk/src/index.js'
import {
  COUNTRY_CLASS_PREFIX,
  COUNTRY_SOURCE,
  FACADE,
  FACADE_CLASS,
  FORCED_CLASS_FILE,
  GENERATED_HEADER,
  MARKER,
  exists,
  insertFirstStatement,
  isDir,
  maskComments,
  patchFacade,
  readSources,
  rel,
  restorePatch,
  type SavedFile,
  type Source,
  type State
} from './patch.js'
import type { Segment } from './segment.js'

// Runtime mode: the normal debug build carries a dormant patch that reads the segment from a file
// inside the APK (SEGMENT_ENTRY). Without that file the game gets the real attribution; `stamp`
// adds the file to a copy of the APK and signs it again, so a segment APK needs no Unity build.

/** APK entry holding the forced segment (stored, never compressed: the reader does not inflate). */
export const SEGMENT_ENTRY = 'assets/ci-segment.txt'
const SEGMENT_FILE_HEADER = 'ci-sdk-segment 1'
/** Process environment variable through which the facade class hands the country to other assemblies. */
const COUNTRY_VARIABLE = 'CI_SDK_SEGMENT_COUNTRY'

/** The segment file of `stamp`: a header line, then `key=value` lines (values have no newline). */
export function segmentFileText(segment: Segment): string {
  const lines = [
    SEGMENT_FILE_HEADER,
    `name=${segment.name}`,
    `trackerName=${segment.trackerName}`,
    `network=${segment.network}`,
    `campaign=${segment.campaign}`,
    `adgroup=${segment.adgroup}`,
    `creative=${segment.creative}`
  ]
  if (segment.country !== undefined) lines.push(`country=${segment.country}`)
  return `${lines.join('\n')}\n`
}

/**
 * C# members of the facade class that read the segment file from the running APK (Application.dataPath is the APK on
 * Android). A small reader for one stored zip entry: no System.IO.Compression reference, which a
 * .NET Framework API level does not give by default.
 */
function segmentReaderMembers(): string {
  return `        private const string CiSdkEntry = "${SEGMENT_ENTRY}";
        private const string CiSdkHeader = "${SEGMENT_FILE_HEADER}";
        private const string CiSdkCountryVariable = "${COUNTRY_VARIABLE}";
        private static readonly object CiSdkGate = new object();
        private static bool ciSdkLoaded;
        private static System.Collections.Generic.Dictionary<string, string> ciSdkValues;

        // On the main thread before the first scene: Application.dataPath is main-thread only.
        [UnityEngine.RuntimeInitializeOnLoadMethod(UnityEngine.RuntimeInitializeLoadType.SubsystemRegistration)]
        private static void CiSdkPreload()
        {
            CiSdkLoad();
        }

        // The segment, or null (no segment file: the normal APK).
        private static System.Collections.Generic.Dictionary<string, string> CiSdkLoad()
        {
            lock (CiSdkGate)
            {
                if (ciSdkLoaded)
                {
                    return ciSdkValues;
                }
                ciSdkLoaded = true;
#if UNITY_ANDROID && !UNITY_EDITOR
                try
                {
                    var apk = UnityEngine.Application.dataPath;
                    if (!apk.EndsWith(".apk", System.StringComparison.OrdinalIgnoreCase))
                    {
                        UnityEngine.Debug.LogWarning("[ci-sdk] not running from an APK (" + apk + "): no segment");
                    }
                    var bytes = CiSdkReadStoredEntry(apk, CiSdkEntry);
                    if (bytes != null)
                    {
                        var lines = System.Text.Encoding.UTF8.GetString(bytes).Split('\\n');
                        if (lines.Length > 0 && lines[0].Trim() == CiSdkHeader)
                        {
                            var values = new System.Collections.Generic.Dictionary<string, string>();
                            for (var i = 1; i < lines.Length; i++)
                            {
                                var line = lines[i].TrimEnd('\\r');
                                var eq = line.IndexOf('=');
                                if (eq > 0)
                                {
                                    values[line.Substring(0, eq)] = line.Substring(eq + 1);
                                }
                            }
                            ciSdkValues = values;
                            // For the country readers of other assemblies (no UnityEngine needed there).
                            string country;
                            if (values.TryGetValue("country", out country) && country.Length > 0)
                            {
                                System.Environment.SetEnvironmentVariable(CiSdkCountryVariable, country);
                            }
                            UnityEngine.Debug.Log("[ci-sdk] segment APK: " + CiSdkGet("name") + " (campaign " + CiSdkGet("campaign") + ")");
                        }
                    }
                }
                catch (System.Exception e)
                {
                    // Off the main thread dataPath throws: the next call (the main-thread preload) tries again.
                    ciSdkLoaded = false;
                    UnityEngine.Debug.LogWarning("[ci-sdk] segment file not read: " + e.Message);
                }
#endif
                return ciSdkValues;
            }
        }

        private static string CiSdkGet(string key)
        {
            var values = CiSdkLoad();
            string value;
            return values != null && values.TryGetValue(key, out value) ? value : "";
        }

        // The forced IP country, or null (no segment file, or a segment without country).
        public static string Country()
        {
            var country = CiSdkGet("country");
            return country.Length > 0 ? country : null;
        }

        private static long CiSdkU16(byte[] b, int i)
        {
            return b[i] | (b[i + 1] << 8);
        }

        private static long CiSdkU32(byte[] b, int i)
        {
            return (uint)(b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24));
        }

        private static void CiSdkRead(System.IO.Stream s, long offset, byte[] buffer)
        {
            s.Seek(offset, System.IO.SeekOrigin.Begin);
            var done = 0;
            while (done < buffer.Length)
            {
                var n = s.Read(buffer, done, buffer.Length - done);
                if (n <= 0)
                {
                    throw new System.IO.EndOfStreamException();
                }
                done += n;
            }
        }

        // The bytes of a stored entry of the zip, or null when it has none.
        private static byte[] CiSdkReadStoredEntry(string zip, string name)
        {
            using (var s = new System.IO.FileStream(zip, System.IO.FileMode.Open, System.IO.FileAccess.Read, System.IO.FileShare.Read))
            {
                var length = s.Length;
                var tail = new byte[(int)System.Math.Min(length, 22 + 65535)];
                CiSdkRead(s, length - tail.Length, tail);
                var eocd = -1;
                for (var i = tail.Length - 22; i >= 0; i--)
                {
                    if (CiSdkU32(tail, i) == 0x06054b50)
                    {
                        eocd = i;
                        break;
                    }
                }
                if (eocd < 0)
                {
                    return null;
                }
                var count = CiSdkU16(tail, eocd + 10);
                var cd = new byte[CiSdkU32(tail, eocd + 12)];
                CiSdkRead(s, CiSdkU32(tail, eocd + 16), cd);
                var wanted = System.Text.Encoding.UTF8.GetBytes(name);
                var p = 0;
                for (var n = 0; n < count && p + 46 <= cd.Length; n++)
                {
                    if (CiSdkU32(cd, p) != 0x02014b50)
                    {
                        return null;
                    }
                    var nameLength = (int)CiSdkU16(cd, p + 28);
                    var match = nameLength == wanted.Length && p + 46 + nameLength <= cd.Length;
                    for (var k = 0; match && k < nameLength; k++)
                    {
                        match = cd[p + 46 + k] == wanted[k];
                    }
                    if (match)
                    {
                        if (CiSdkU16(cd, p + 10) != 0)
                        {
                            return null;
                        }
                        var local = CiSdkU32(cd, p + 42);
                        var header = new byte[30];
                        CiSdkRead(s, local, header);
                        if (CiSdkU32(header, 0) != 0x04034b50)
                        {
                            return null;
                        }
                        var data = new byte[CiSdkU32(cd, p + 20)];
                        CiSdkRead(s, local + 30 + CiSdkU16(header, 26) + CiSdkU16(header, 28), data);
                        return data;
                    }
                    p += 46 + nameLength + (int)CiSdkU16(cd, p + 30) + (int)CiSdkU16(cd, p + 32);
                }
                return null;
            }
        }
`
}

/** Source of the dormant facade class: the real attribution unless the APK has a segment file. */
export function runtimeSegmentSource(): string {
  return `// ${GENERATED_HEADER}. CI build only, never commit.
using System;
using UnityEngine;

namespace AdjustSdk
{
    internal static class AdjustCiForcedSegment
    {
        public static Action<AdjustAttribution> Wrap(Action<AdjustAttribution> callback)
        {
            if (callback == null || CiSdkLoad() == null)
            {
                return callback;
            }
            return real => callback(Force(real));
        }

        // Also forces when Adjust answered nothing, so the segment does not depend on the network.
        public static AdjustAttribution Force(AdjustAttribution real)
        {
            Debug.Log("[ci-sdk] forced Adjust attribution: network=" + CiSdkGet("network") + " campaign=" + CiSdkGet("campaign"));
            return new AdjustAttribution
            {
                TrackerToken = real?.TrackerToken ?? "",
                TrackerName = CiSdkGet("trackerName"),
                Network = CiSdkGet("network"),
                Campaign = CiSdkGet("campaign"),
                Adgroup = CiSdkGet("adgroup"),
                Creative = CiSdkGet("creative"),
                ClickLabel = ""
            };
        }

${segmentReaderMembers()}    }
}
`
}

/**
 * Source of a country reader for an IP country source outside the Adjust folder (maybe another
 * assembly, where the internal facade class is not visible). It only reads the variable the facade
 * class sets at startup: no UnityEngine reference, so an assembly without engine references builds.
 */
export function runtimeCountrySource(className: string): string {
  return `// ${GENERATED_HEADER}. CI build only, never commit.
internal static class ${className}
{
    // The forced IP country, or null (no segment file, or a segment without country).
    public static string Country()
    {
        var country = System.Environment.GetEnvironmentVariable("${COUNTRY_VARIABLE}");
        return string.IsNullOrEmpty(country) ? null : country;
    }
}
`
}

/** Make `GetIpCountryCodeAsync` answer the segment file's country when there is one. */
export function patchCountrySourceRuntime(
  text: string,
  file: string,
  reader: string,
  /** The text already carries this run's facade patch (same file). */
  facadePatched = false
): string {
  if (!facadePatched && text.includes(MARKER)) {
    throw new CiError('E_PATCH', `${file} is already patched; run mode: restore first`)
  }
  const match = COUNTRY_SOURCE.exec(maskComments(text))
  if (!match) throw new CiError('E_PATCH', `${file}: GetIpCountryCodeAsync not found`)
  const value = match[1] ? 'ciSdkCountry' : 'System.Threading.Tasks.Task.FromResult(ciSdkCountry)'
  return insertFirstStatement(
    text,
    match,
    `{ var ciSdkCountry = ${reader}.Country(); if (ciSdkCountry != null) { return ${value}; } }`
  )
}

export interface RuntimeApplyOptions {
  projectRoot: string
  /** Also patch the IP country source (a segment sets a country): it must then exist. */
  country: boolean
  stateFile: string
}

/**
 * The dormant patch of the normal debug build (see SEGMENT_ENTRY). Same state file and restore as
 * `applyPatch`; every new content is computed before anything is written.
 * @returns project-relative paths of the files changed or added.
 */
export async function applyRuntimePatch(options: RuntimeApplyOptions): Promise<string[]> {
  const { stateFile } = options
  const root = path.resolve(options.projectRoot)
  const assets = path.join(root, 'Assets')
  if (!(await isDir(assets))) throw new CiError('E_PATCH', `No Assets folder in ${root}`)
  // A state left by a job that never restored must not become the "original" of this run.
  if (await exists(stateFile)) await restorePatch(stateFile)

  const sources = await readSources(assets)
  const masked = new Map(sources.map(s => [s.file, maskComments(s.text)]))
  const code = (s: Source): string => masked.get(s.file) ?? ''
  const facades = sources.filter(s => FACADE.test(code(s)) && FACADE_CLASS.test(code(s)))
  if (facades.length === 0) {
    throw new CiError(
      'E_PATCH',
      'Adjust SDK not found: no .cs file under Assets declares InitSdk(AdjustConfig)'
    )
  }
  if (facades.length > 1) {
    const list = facades.map(s => rel(root, s.file)).join(', ')
    throw new CiError('E_PATCH', `Several Adjust facades found (${list}); cannot choose one`)
  }
  const facade = facades[0]!
  const facadeDir = path.dirname(facade.file)

  const changes = new Map<string, { source: Source; text: string }>()
  changes.set(facade.file, {
    source: facade,
    text: patchFacade(facade.text, rel(root, facade.file))
  })
  // Generated files: absolute path -> content.
  const generated = new Map<string, string>([
    [path.join(facadeDir, FORCED_CLASS_FILE), runtimeSegmentSource()]
  ])

  if (options.country) {
    const owners = sources.filter(s => COUNTRY_SOURCE.test(code(s)))
    if (owners.length === 0) {
      throw new CiError(
        'E_PATCH',
        'a segment sets country but no known IP country source (GetIpCountryCodeAsync) was found'
      )
    }
    for (const owner of owners) {
      const dir = path.dirname(owner.file)
      let reader = 'global::AdjustSdk.AdjustCiForcedSegment'
      // Another folder may be another assembly, where the internal facade class is not visible:
      // its own reader, named after the folder so two readers never clash in one assembly.
      if (dir !== facadeDir) {
        const hash = createHash('sha256').update(rel(root, dir)).digest('hex').slice(0, 8)
        const className = `${COUNTRY_CLASS_PREFIX}${hash}`
        generated.set(path.join(dir, `${className}.cs`), runtimeCountrySource(className))
        reader = `global::${className}`
      }
      const earlier = changes.get(owner.file)
      changes.set(owner.file, {
        source: owner,
        text: patchCountrySourceRuntime(
          earlier?.text ?? owner.text,
          rel(root, owner.file),
          reader,
          !!earlier
        )
      })
    }
  }

  const files: SavedFile[] = [...changes.values()].map(({ source }) => ({
    path: rel(root, source.file),
    original: source.buffer.toString('base64')
  }))
  const added: string[] = []
  for (const file of generated.keys()) {
    const stale = sources.find(s => s.file === file)
    // A leftover of ours is just deleted on restore; anything else is restored byte-exact.
    if (!stale || stale.text.includes(GENERATED_HEADER)) added.push(rel(root, file))
    else files.push({ path: rel(root, file), original: stale.buffer.toString('base64') })
  }

  const state: State = { version: 1, root, files, added }
  await mkdir(path.dirname(stateFile), { recursive: true })
  // Write then rename: a job killed mid-write never leaves a truncated state behind.
  await writeFile(`${stateFile}.tmp`, JSON.stringify(state, null, 2))
  await rename(`${stateFile}.tmp`, stateFile)

  for (const { source, text } of changes.values()) await writeFile(source.file, text, 'utf8')
  for (const [file, text] of generated) await writeFile(file, text, 'utf8')

  return [...changes.values()]
    .map(c => rel(root, c.source.file))
    .concat([...generated.keys()].map(f => rel(root, f)))
}
