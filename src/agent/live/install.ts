// Wire the Modmixer Live mod into the RimWorld install for a live session.
//
// Same junction/symlink mechanism as the monitor bridge (see
// bridge-install.ts, which this deliberately mirrors), with two
// differences that keep the powerful half of the live feature opt-in:
//
//   1. Live is installed ONLY when the user launches a live session, and
//      removed when that session's game closes — it never rides along with
//      ordinary test cycles the way the bridge does.
//   2. The install refuses when the bundled mod has no built assembly
//      (vendor/modmixer-live ships C# source; Assemblies/ is produced by
//      `dotnet build` at package time). A source-only copy would load as a
//      dead mod and the in-game window would simply never exist — failing
//      here gives the launch flow a real error to surface instead.

import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { detectRimWorldPaths } from '../paths.js';
import type { RegistrySnapshot } from '../registry/types.js';

export const LIVE_PACKAGE_ID = 'modmixer.live';
/** Folder name we use under `<rimworld>/Mods/`. Stable across versions. */
const LIVE_MODS_FOLDER = 'ModmixerLive';
/** Assembly the build must have produced for the mod to be loadable. */
const LIVE_ASSEMBLY = path.join('Assemblies', 'ModMixerLive.dll');

export interface LiveInstallResult {
  /** True when the Live mod is now available to RimWorld via SOME path. */
  available: boolean;
  /**
   * Why we didn't install our copy (only set when we deliberately skipped):
   * - "workshop" — user has a Workshop subscription (future-proofing; no
   *   Workshop release exists yet).
   * - "local" — user has a real (non-junction) ModmixerLive folder.
   * - "rimworld-missing" — RimWorld install not found.
   * - "source-missing" — bundled live dir wasn't found (broken package).
   * - "not-built" — bundled live dir exists but has no compiled assembly.
   */
  skipReason?: 'workshop' | 'local' | 'rimworld-missing' | 'source-missing' | 'not-built';
  /** True when we created or refreshed the junction. */
  installed: boolean;
}

/**
 * Resolve the on-disk bundled Live mod. Probes dev first
 * (`<repo>/vendor/modmixer-live`), then the packaged extraResource path
 * (`<resourcesPath>/modmixer-live`). Returns null if neither exists.
 */
export function resolveLiveSourceDir(): string | null {
  const candidates: string[] = [];
  try {
    candidates.push(path.join(app.getAppPath(), 'vendor', 'modmixer-live'));
  } catch {
    // app.getAppPath() throws when Electron isn't initialized (unit tests).
  }
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'modmixer-live'));
  }
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'About', 'About.xml'))) return c;
  }
  return null;
}

/**
 * Ensure the Live mod is loadable by RimWorld. Same shape and same safety
 * rules as ensureBridgeInstalled: respect Workshop/local installs, refresh
 * stale junctions, never throw — return a result describing what happened.
 */
export async function ensureLiveInstalled(
  snapshot: RegistrySnapshot,
): Promise<LiveInstallResult> {
  const existing = snapshot.mods.find(
    (m) => m.about.packageIdLc === LIVE_PACKAGE_ID,
  );
  if (existing && existing.source === 'workshop') {
    return { available: true, installed: false, skipReason: 'workshop' };
  }

  const { modsDir } = detectRimWorldPaths();
  if (!fs.existsSync(path.dirname(modsDir))) {
    return { available: false, installed: false, skipReason: 'rimworld-missing' };
  }

  const source = resolveLiveSourceDir();
  if (!source) {
    return {
      available: existing != null,
      installed: false,
      skipReason: 'source-missing',
    };
  }
  if (!fs.existsSync(path.join(source, LIVE_ASSEMBLY))) {
    // Source tree without a build — see the header comment. A user-owned
    // copy (existing) may still be fine; ours is not installable.
    return {
      available: existing != null,
      installed: false,
      skipReason: 'not-built',
    };
  }

  const target = path.join(modsDir, LIVE_MODS_FOLDER);

  try {
    const lst = await fsp.lstat(target);
    if (lst.isSymbolicLink()) {
      let resolved: string;
      try {
        resolved = await fsp.realpath(target);
      } catch {
        // Dangling junction — remove it and recreate below.
        await fsp.rm(target, { recursive: true, force: true });
        await createLiveLink(source, target);
        return { available: true, installed: true };
      }
      if (pathsEqual(resolved, source)) {
        return { available: true, installed: false };
      }
      // Junction pointing somewhere else — stale from a previous install
      // location. Refresh.
      await fsp.rm(target, { recursive: true, force: true });
      await createLiveLink(source, target);
      return { available: true, installed: true };
    }
    if (lst.isDirectory()) {
      // Real directory at the same folder name. Not ours; respect it.
      return { available: true, installed: false, skipReason: 'local' };
    }
    // File (?) sitting at our target path — remove and link over it.
    await fsp.rm(target, { force: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  await createLiveLink(source, target);
  return { available: true, installed: true };
}

/**
 * Remove the junction we created. Called when the live session's game
 * disconnects, so Live never lingers into ordinary test cycles. Leaves
 * real directories alone.
 */
export async function removeLiveInstall(): Promise<boolean> {
  const { modsDir } = detectRimWorldPaths();
  if (!fs.existsSync(modsDir)) return false;
  const target = path.join(modsDir, LIVE_MODS_FOLDER);
  try {
    const lst = await fsp.lstat(target);
    if (!lst.isSymbolicLink()) return false;
    await fsp.rm(target, { recursive: true, force: true });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

async function createLiveLink(source: string, target: string): Promise<void> {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  await fsp.symlink(source, target, type);
}

/** Case-insensitive on Windows — same rationale as bridge-install. */
function pathsEqual(a: string, b: string): boolean {
  const na = path.resolve(a);
  const nb = path.resolve(b);
  if (process.platform === 'win32') {
    return na.toLowerCase() === nb.toLowerCase();
  }
  return na === nb;
}
