// Make the Modmixer Live mod available to RimWorld for a live session.
//
// Distribution is split by build flavor:
//
//   - Packaged builds: the mod is distributed ONLY via Steam Workshop (the
//     official item, LIVE_WORKSHOP_ID). We never install anything — this
//     module just detects the subscription and gates on its version; ship.ts
//     enables it by packageId from the registry snapshot, and RimWorld loads
//     Workshop content natively. Non-Steam installs can't use Live at all.
//   - Dev (repo checkout): vendor/modmixer-live is junctioned into
//     `<rimworld>/Mods/` exactly like the monitor bridge (bridge-install.ts),
//     so mod iteration doesn't require publishing. The junction refuses when
//     the vendor tree has no built assembly (Assemblies/ is produced by
//     `dotnet build`) — a source-only copy would load as a dead mod.
//
// Either way Live stays opt-in: it's only wired up when the user launches a
// live session, and the dev junction is removed when that session's game
// closes — it never rides along with ordinary test cycles the way the
// bridge does.

import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { detectRimWorldPaths } from '../paths.js';
import type { RegistrySnapshot } from '../registry/types.js';
import { compareDottedVersions } from './version.js';

export const LIVE_PACKAGE_ID = 'modmixer.live';

/**
 * publishedfileid of the official Modmixer Live Workshop item. The Workshop
 * folder name IS this id, which makes it the spoof-resistant identity check
 * (anyone can upload a mod with our packageId; nobody else gets this id).
 *
 * Minted by the one-time first publish (scripts/publish-live-mod.mjs), which
 * cross-checks this constant against About/PublishedFileId.txt on every run.
 */
export const LIVE_WORKSHOP_ID = '3742578324';

/**
 * Minimum About.xml <modVersion> of the installed Workshop copy this app can
 * drive. This is the pre-launch gate; the LiveHello protocol handshake
 * (protocol.ts / server.ts) stays as the runtime backstop. Steam updates the
 * mod automatically, so only bump this when the app genuinely depends on
 * newer mod behavior — and prefer keeping the mod backward-compatible over
 * bumping LIVE_PROTOCOL_VERSION.
 */
export const LIVE_REQUIRED_VERSION = '0.2.0';

export const LIVE_WORKSHOP_URL_STEAM = `steam://url/CommunityFilePage/${LIVE_WORKSHOP_ID}`;
export const LIVE_WORKSHOP_URL_WEB = `https://steamcommunity.com/sharedfiles/filedetails/?id=${LIVE_WORKSHOP_ID}`;

/** Folder name we use under `<rimworld>/Mods/` for the dev junction. */
const LIVE_MODS_FOLDER = 'ModmixerLive';

/**
 * Monotonic count of junction (re)establishments. A live session's teardown
 * captures this at bind time and passes it back to removeLiveInstall, so a
 * PREVIOUS game's late disconnect (its socket dropping after quitRimWorld
 * during a relaunch) can never delete the junction the NEW session just
 * created — that race shipped the stale Workshop copy into fresh sessions.
 */
let installEpoch = 0;

export function currentLiveInstallEpoch(): number {
  return installEpoch;
}
/** Assembly the build must have produced for the mod to be loadable. */
const LIVE_ASSEMBLY = path.join('Assemblies', 'ModMixerLive.dll');

export interface LiveInstallResult {
  /** True when the Live mod is now available to RimWorld via SOME path. */
  available: boolean;
  /**
   * Why we didn't install our copy (only set when we deliberately skipped):
   * - "workshop" — the official Workshop item is subscribed and current
   *   (packaged happy path).
   * - "local" — user has a real (non-junction) ModmixerLive folder (dev).
   * - "rimworld-missing" — RimWorld install not found.
   * - "not-built" — vendor tree exists but has no compiled assembly (dev).
   * - "steam-required" — packaged build, but RimWorld isn't a Steam install,
   *   so the user can't subscribe to the Workshop item.
   * - "not-subscribed" — Steam install, but the official Workshop item isn't
   *   on disk (not subscribed, or Steam hasn't downloaded it yet).
   * - "stale-version" — Workshop copy is older than LIVE_REQUIRED_VERSION
   *   (Steam hasn't delivered the update yet).
   */
  skipReason?:
    | 'workshop'
    | 'local'
    | 'rimworld-missing'
    | 'not-built'
    | 'steam-required'
    | 'not-subscribed'
    | 'stale-version';
  /** Installed Workshop copy's <modVersion>, set with "stale-version". */
  installedVersion?: string;
  /** True when we created or refreshed the dev junction. */
  installed: boolean;
}

/**
 * Resolve the development copy of the Live mod (`<repo>/vendor/modmixer-live`).
 * Packaged builds intentionally have no bundled copy — users get the mod from
 * Steam Workshop — so this returns null there (the Vite plugin ships only
 * .vite/build in the asar) and ensureLiveInstalled takes the Workshop path.
 */
export function resolveLiveSourceDir(): string | null {
  // Dev-only escape hatch: pretend there's no vendor copy so the Workshop
  // path (subscribe prompt, version gate) can be exercised from a dev
  // checkout without packaging the app.
  if (process.env.MODMIXER_FORCE_LIVE_WORKSHOP) {
    console.warn(
      '[live] MODMIXER_FORCE_LIVE_WORKSHOP is set — ignoring vendor/modmixer-live, using the Workshop copy.',
    );
    return null;
  }
  let candidate: string;
  try {
    candidate = path.join(app.getAppPath(), 'vendor', 'modmixer-live');
  } catch {
    // app.getAppPath() throws when Electron isn't initialized (unit tests).
    return null;
  }
  return fs.existsSync(path.join(candidate, 'About', 'About.xml'))
    ? candidate
    : null;
}

/**
 * Ensure the Live mod is loadable by RimWorld. Never throws — returns a
 * result describing what happened. Branches on whether the vendor dev copy
 * exists rather than app.isPackaged, which is unreliable under
 * `electron-forge start` (same rationale as resolvePackagedResource in
 * index/paths.ts).
 */
export async function ensureLiveInstalled(
  snapshot: RegistrySnapshot,
): Promise<LiveInstallResult> {
  const source = resolveLiveSourceDir();
  return source
    ? ensureDevJunction(snapshot, source)
    : checkWorkshopInstall(snapshot);
}

/**
 * Packaged path: detect the official Workshop item and gate on its version.
 * No filesystem writes except clearing a junction left by an old dev build.
 */
async function checkWorkshopInstall(
  snapshot: RegistrySnapshot,
): Promise<LiveInstallResult> {
  const { modsDir } = detectRimWorldPaths();
  const installRoot = path.dirname(modsDir);
  if (!fs.existsSync(installRoot)) {
    return { available: false, installed: false, skipReason: 'rimworld-missing' };
  }

  // Steam installs always live under .../steamapps/common/... (including
  // custom libraries and the install-path override). GOG / DRM-free copies
  // don't, and their users can't subscribe to Workshop items — a manually
  // copied install inside a folder named "steamapps" would fool this, but
  // that's an acceptable edge.
  if (!/[\\/]steamapps[\\/]/i.test(installRoot)) {
    return { available: false, installed: false, skipReason: 'steam-required' };
  }

  // The registry snapshot is the same lens ship.ts uses to enable mods by
  // packageId, so "official item in the snapshot" is the real availability
  // signal — not just a directory existing while Steam is mid-download.
  const item = snapshot.mods.find(
    (m) => m.source === 'workshop' && m.folder === LIVE_WORKSHOP_ID,
  );
  if (!item || item.about.packageIdLc !== LIVE_PACKAGE_ID) {
    return { available: false, installed: false, skipReason: 'not-subscribed' };
  }

  const installedVersion = item.about.modVersion;
  if (compareDottedVersions(installedVersion, LIVE_REQUIRED_VERSION) < 0) {
    return {
      available: false,
      installed: false,
      skipReason: 'stale-version',
      installedVersion,
    };
  }

  // A junction left at Mods/ModmixerLive by a pre-Workshop dev build would
  // make RimWorld see two copies of modmixer.live — clear it. (Real
  // directories are left alone, same as removeLiveInstall always did.)
  await removeLiveInstall().catch(() => {});

  return { available: true, installed: false, skipReason: 'workshop' };
}

/**
 * Dev path: junction vendor/modmixer-live into Mods/. Same shape and same
 * safety rules as ensureBridgeInstalled: respect Workshop/local installs,
 * refresh stale junctions.
 */
async function ensureDevJunction(
  snapshot: RegistrySnapshot,
  source: string,
): Promise<LiveInstallResult> {
  // A Workshop subscription may coexist with the junction. RimWorld
  // resolves the clash itself: when a local copy and a Workshop copy share
  // a packageId, the Workshop copy gets a "_steam" postfix appended
  // (ModLister.TryAddMod), so the bare packageId ship.ts enables always
  // loads the junction. Dev iteration on the vendor tree must beat the
  // published item — a subscription only covers for an unbuilt vendor tree.
  const existing = snapshot.mods.find(
    (m) => m.about.packageIdLc === LIVE_PACKAGE_ID,
  );

  const { modsDir } = detectRimWorldPaths();
  if (!fs.existsSync(path.dirname(modsDir))) {
    return { available: false, installed: false, skipReason: 'rimworld-missing' };
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
        installEpoch++;
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
 * real directories alone. No-op in packaged builds (nothing was installed).
 */
export async function removeLiveInstall(onlyIfEpoch?: number): Promise<boolean> {
  // A stale caller (a previous session's disconnect landing mid-relaunch)
  // passes the epoch it captured at bind time; if a newer session has
  // (re)installed since, the junction is theirs — leave it alone.
  if (onlyIfEpoch !== undefined && onlyIfEpoch !== installEpoch) return false;
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
  installEpoch++;
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
