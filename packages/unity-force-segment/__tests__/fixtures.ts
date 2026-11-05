import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** Excerpt of the vendored Adjust v5 facade (Assets/Adjust/Scripts/Adjust.cs). */
export const ADJUST_CS = `using System;
using UnityEngine;

namespace AdjustSdk
{
    public class Adjust : MonoBehaviour
    {
        public static void InitSdk(AdjustConfig adjustConfig)
        {
            if (IsEditor()) { return; }

            AdjustUtils.Init(adjustConfig);
        }

        public static void GetAttribution(Action<AdjustAttribution> attributionCallback)
        {
            if (IsEditor()) { return; }

            instance.GetAttribution(attributionCallback);
        }

        public static void GetAttributionWithTimeout(int timeoutInMilliseconds, Action<AdjustAttribution> callbackWithTimeout)
        {
            if (IsEditor()) { return; }

            instance.GetAttributionWithTimeout(timeoutInMilliseconds, callbackWithTimeout);
        }

        private static bool IsEditor()
        {
            return false;
        }
    }
}
`

/** Same file with a different layout: braces on their own line, split parameters, tabs. */
export const ADJUST_ODD_CS = `namespace AdjustSdk
{
\tpublic class Adjust
\t{
\t\tpublic static void InitSdk(
\t\t\tAdjustConfig  cfg
\t\t)
\t\t{
\t\t\tAdjustUtils.Init(cfg);
\t\t}

\t\tpublic static void GetAttribution( Action<AdjustAttribution>  cb )
\t\t{
\t\t\tinstance.GetAttribution(cb);
\t\t}
\t}
}
`

export const ADJUST_NO_GET_CS = `namespace AdjustSdk
{
    public class Adjust
    {
        public static void InitSdk(AdjustConfig adjustConfig)
        {
        }
    }
}
`

export const TRACKER_SYNC_CS = `using System.Threading.Tasks;

namespace Databuckets
{
    public static class DatabucketsTracker
    {
        public static Task<string> GetIpCountryCodeAsync()
        {
            return IpLookup.QueryAsync();
        }
    }
}
`

export const TRACKER_ASYNC_CS = `using System.Threading.Tasks;

namespace Databuckets
{
    public static class DatabucketsTracker
    {
        public static async Task<string> GetIpCountryCodeAsync()
        {
            return await IpLookup.QueryAsync();
        }
    }
}
`

export const crlf = (text: string): string => text.replaceAll('\n', '\r\n')

export const BOM = '\uFEFF'

export const ADJUST_PATH = 'Assets/Adjust/Scripts/Adjust.cs'
export const TRACKER_PATH =
  'Assets/BGPZ-Library-Module/Assets/SDK_ADS/Runtime/Databuckets/DatabucketsTracker.cs'

export async function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'ci-sdk-force-segment-'))
}

/** Create files (relative path -> content) under `root`. */
export async function writeTree(
  root: string,
  files: Record<string, string | Buffer>
): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, content)
  }
}
