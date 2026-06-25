// Aggregate environment detection for the onboarding flow. One IPC, one
// renderer call — covers RimWorld install + DLCs + config files + .NET +
// ilspycmd + Mods folder writability.
//
// Each field reports both a status and (when relevant) the path or hint we
// detected, so the renderer can render checkmarks plus a small "found at X"
// caption without a second round trip.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { detectRimWorldPaths } from './paths.js';
import { resolveDotnet } from './dotnet.js';
import { resolveIlspycmd } from './index/ilspycmd.js';
import { getRegistry } from './registry/index.js';

/** Display order matches the in-game expansion order. */
const KNOWN_DLCS: { folder: string; assembly: string; label: string }[] = [
  { folder: 'Royalty', assembly: 'Royalty.dll', label: 'Royalty' },
  { folder: 'Ideology', assembly: 'Ideology.dll', label: 'Ideology' },
  { folder: 'Biotech', assembly: 'Biotech.dll', label: 'Biotech' },
  { folder: 'Anomaly', assembly: 'Anomaly.dll', label: 'Anomaly' },
  { folder: 'Odyssey', assembly: 'Odyssey.dll', label: 'Odyssey' },
];

export interface EnvCheck {
  ok: boolean;
  /** Human-readable detail. Path on success, error hint on failure. */
  detail: string | null;
  /** Absolute path when the check resolved a file/folder. */
  path?: string | null;
}

export interface EnvSnapshot {
  rimworld: EnvCheck & {
    /** Major.minor version, derived from the install. Best-effort. */
    version: string | null;
    /** DLCs the user owns, in display order. */
    dlcs: string[];
  };
  modsConfig: EnvCheck;
  modsDirWritable: EnvCheck;
  dotnet: EnvCheck;
  ilspycmd: EnvCheck;
  /** Mods detected on disk, regardless of active state. */
  mods: {
    workshop: number;
    local: number;
    /** Total local + workshop count for the marquee number. */
    total: number;
  };
}

/**
 * Read a few bytes of Version.txt to infer the RimWorld major.minor version.
 * Falls back to null if the file is absent or unreadable. We intentionally
 * don't surface a parse error — the version is for display only.
 */
function readRimWorldVersion(installRoot: string): string | null {
  const candidates = [
    path.join(installRoot, 'Version.txt'),
    // macOS bundle layout
    path.join(installRoot, 'RimWorldMac.app/Version.txt'),
  ];
  for (const c of candidates) {
    try {
      const raw = fs.readFileSync(c, 'utf8').trim();
      const m = raw.match(/^\d+\.\d+(?:\.\d+)?/);
      if (m) return m[0];
    } catch {
      // try next
    }
  }
  return null;
}

function detectDlcs(dataDir: string | null, managedDir: string | null): string[] {
  if (!dataDir && !managedDir) return [];
  const found: string[] = [];
  for (const dlc of KNOWN_DLCS) {
    const folderPresent =
      dataDir && fs.existsSync(path.join(dataDir, dlc.folder, 'Defs'));
    const assemblyPresent =
      managedDir && fs.existsSync(path.join(managedDir, dlc.assembly));
    if (folderPresent || assemblyPresent) found.push(dlc.label);
  }
  return found;
}

/**
 * Probe whether we can create + delete a junction (Windows) or symlink
 * (macOS/Linux) inside the given directory. Junctions on Windows don't
 * require admin or developer mode — but the ACL on the parent might still
 * forbid writes, so we have to actually try. The probe leaves no residue.
 */
async function probeModsDirWritable(modsDir: string): Promise<EnvCheck> {
  if (!fs.existsSync(path.dirname(modsDir))) {
    return {
      ok: false,
      detail:
        'RimWorld install not detected — Mods folder will be created when an install is found.',
    };
  }
  try {
    await fsp.mkdir(modsDir, { recursive: true });
  } catch (err) {
    return {
      ok: false,
      detail: `Couldn't create ${modsDir}: ${(err as Error).message}`,
      path: modsDir,
    };
  }
  // We don't probe junctions here — that would require an actual target to
  // link to. fs.access is sufficient to prove the directory exists and the
  // user has write permission. Junction creation failures will surface as
  // clear errors during sync, not silently.
  try {
    await fsp.access(modsDir, fs.constants.W_OK);
  } catch (err) {
    return {
      ok: false,
      detail: `Mods folder not writable: ${(err as Error).message}`,
      path: modsDir,
    };
  }
  return { ok: true, detail: null, path: modsDir };
}

export async function detectEnv(): Promise<EnvSnapshot> {
  const rim = detectRimWorldPaths();

  const installRoot =
    rim.managedDir
      ? // <install>/RimWorldWin64_Data/Managed/ → <install>/
        path.dirname(path.dirname(rim.managedDir))
      : null;

  const rimworld: EnvSnapshot['rimworld'] = rim.managedDir
    ? {
        ok: true,
        detail: null,
        path: installRoot,
        version: installRoot ? readRimWorldVersion(installRoot) : null,
        dlcs: detectDlcs(rim.dataDir, rim.managedDir),
      }
    : {
        ok: false,
        detail:
          'RimWorld install not found in the standard Steam locations. Install RimWorld via Steam, or browse for the install folder.',
        path: null,
        version: null,
        dlcs: [],
      };

  const modsConfig: EnvCheck = rim.modsConfig
    ? { ok: true, detail: null, path: rim.modsConfig }
    : {
        ok: false,
        detail:
          'ModsConfig.xml not found. RimWorld creates it the first time you launch the game — click Launch RimWorld below, then come back and re-check.',
      };

  const modsDirWritable = await probeModsDirWritable(rim.modsDir);

  const dotnetPath = resolveDotnet();
  const dotnet: EnvCheck = dotnetPath
    ? { ok: true, detail: null, path: dotnetPath }
    : {
        ok: false,
        detail:
          'dotnet not found. The .NET SDK is required to compile C# mods. Install it from dotnet.microsoft.com, then quit and reopen Modmixer so it picks up the new PATH.',
      };

  const ilspycmdPath = resolveIlspycmd();
  const ilspycmd: EnvCheck = ilspycmdPath
    ? { ok: true, detail: null, path: ilspycmdPath }
    : {
        ok: false,
        detail:
          'ilspycmd not found. Modmixer ships a vendored copy in production builds — if you see this in a dev build, run `dotnet tool install -g ilspycmd`.',
      };

  // Tap the registry for installed mod counts. start() is idempotent and
  // already running by this point in the app lifecycle, so this is cheap.
  const registry = getRegistry();
  await registry.start();
  const snap = registry.getSnapshot();
  let workshop = 0;
  let local = 0;
  for (const m of snap.mods) {
    if (m.source === 'workshop') workshop += 1;
    else if (m.source === 'local') local += 1;
  }

  return {
    rimworld,
    modsConfig,
    modsDirWritable,
    dotnet,
    ilspycmd,
    mods: { workshop, local, total: workshop + local },
  };
}
