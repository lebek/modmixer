// Mod registry — the unified view of all mods on the machine plus the active
// list/order from ModsConfig.xml. Watches the filesystem and re-scans when
// anything changes. Subscribers (renderer + agent tools) read snapshots and
// listen for change events.
//
// Threading model: the registry runs in the main process. There's exactly one
// instance (singleton via `getRegistry()`), and a single in-flight scan at a
// time — concurrent change events queue into a coalesced re-scan.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { detectRimWorldPaths } from '../paths.js';
import { getWorkspacePaths, syncModToGame } from '../workspace.js';
import { parseAboutXml, type AboutXml } from './about-xml.js';
import { readModsConfig, writeActiveMods } from './mods-config.js';
import {
  SKIP_DIRS,
  containsDll,
  isSymlinkedInto,
  readPublishedFileId,
} from '../fs-helpers.js';
import type {
  ActiveMod,
  ModSource,
  RegistryMod,
  RegistrySnapshot,
} from './types.js';

const RESCAN_DEBOUNCE_MS = 400;

type Listener = () => void;

class ModRegistry {
  private snapshot: RegistrySnapshot = {
    mods: [],
    active: [],
    activeOrder: [],
    missingActive: [],
    gameVersion: '',
    gameVersionMajorMinor: null,
  };
  private listeners = new Set<Listener>();
  private watchers: fs.FSWatcher[] = [];
  private modsConfigWatcher: { stop: () => void } | null = null;
  private rescanTimer: NodeJS.Timeout | null = null;
  private scanInFlight: Promise<void> | null = null;
  private rescanQueued = false;
  private started = false;

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.rescan();
    this.installWatchers();
  }

  stop(): void {
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {
        // ignore
      }
    }
    this.watchers = [];
    if (this.modsConfigWatcher) {
      this.modsConfigWatcher.stop();
      this.modsConfigWatcher = null;
    }
    if (this.rescanTimer) {
      clearTimeout(this.rescanTimer);
      this.rescanTimer = null;
    }
    this.started = false;
  }

  getSnapshot(): RegistrySnapshot {
    return this.snapshot;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Force a re-scan now and return the resulting snapshot. Most callers should
   * use `getSnapshot()` and rely on watchers — this is for IPC handlers that
   * want a freshness guarantee on demand.
   */
  async refresh(): Promise<RegistrySnapshot> {
    await this.rescan();
    return this.snapshot;
  }

  /**
   * Replace the active mod list and load order. The argument is an ordered
   * list of packageIds (case-insensitive). Validates that every entry is
   * either present on disk or recognized as Core/DLC; logs unmatched entries
   * as a warning rather than rejecting (matches RimWorld's tolerant behavior).
   */
  async setActiveMods(packageIds: string[]): Promise<RegistrySnapshot> {
    await writeActiveMods(packageIds);
    await this.rescan();
    return this.snapshot;
  }

  /**
   * Add a single packageId to the end of the active list if not already
   * present. Idempotent. Convenience wrapper used by enable_mod_in_game.
   */
  async addActiveMod(packageId: string): Promise<{ alreadyEnabled: boolean }> {
    const normalized = packageId.toLowerCase();
    const current = this.snapshot.activeOrder.slice();
    if (current.includes(normalized)) {
      return { alreadyEnabled: true };
    }
    current.push(normalized);
    await writeActiveMods(current);
    await this.rescan();
    return { alreadyEnabled: false };
  }

  async removeActiveMod(packageId: string): Promise<{ wasEnabled: boolean }> {
    const normalized = packageId.toLowerCase();
    const current = this.snapshot.activeOrder.slice();
    if (!current.includes(normalized)) {
      return { wasEnabled: false };
    }
    const next = current.filter((p) => p !== normalized);
    await writeActiveMods(next);
    await this.rescan();
    return { wasEnabled: true };
  }

  private installWatchers(): void {
    const paths = detectRimWorldPaths();
    const dirs = [
      paths.modsDir,
      paths.workshopDir,
      paths.dataDir,
      this.workspaceDir(),
    ].filter((d): d is string => !!d && fs.existsSync(d));
    for (const dir of dirs) {
      try {
        const w = fs.watch(dir, { persistent: false }, () => this.scheduleRescan());
        this.watchers.push(w);
      } catch {
        // Some platforms reject watching non-existent or special dirs.
      }
    }
    if (paths.modsConfig && fs.existsSync(paths.modsConfig)) {
      const handler = () => this.scheduleRescan();
      fs.watchFile(paths.modsConfig, { interval: 1000 }, handler);
      this.modsConfigWatcher = {
        stop: () => fs.unwatchFile(paths.modsConfig!, handler),
      };
    }
  }

  private workspaceDir(): string {
    // Route through getWorkspacePaths so the dir is materialized — the
    // registry runs early at boot, and a freshly-launched modmixer has no
    // workspace dir yet, which would silently exclude the user's mods from
    // the Library tab.
    return getWorkspacePaths().workspaceDir;
  }

  private scheduleRescan(): void {
    if (this.rescanTimer) clearTimeout(this.rescanTimer);
    this.rescanTimer = setTimeout(() => {
      this.rescanTimer = null;
      void this.rescan();
    }, RESCAN_DEBOUNCE_MS);
  }

  private async rescan(): Promise<void> {
    if (this.scanInFlight) {
      // Another scan is in progress; queue one more to run after.
      this.rescanQueued = true;
      return this.scanInFlight;
    }
    this.scanInFlight = this.doScan().finally(() => {
      this.scanInFlight = null;
      if (this.rescanQueued) {
        this.rescanQueued = false;
        void this.rescan();
      }
    });
    return this.scanInFlight;
  }

  private async doScan(): Promise<void> {
    const paths = detectRimWorldPaths();
    const workspaceRoot = this.workspaceDir();
    const rimworldModsDir = paths.modsDir;

    const mods: RegistryMod[] = [];

    // Official DLCs/Core (Data/ subdirs each containing About/About.xml or just
    // a Defs/ folder for Core). RimWorld's hard-coded packageIds:
    //   ludeon.rimworld         (Core)
    //   ludeon.rimworld.royalty
    //   ludeon.rimworld.ideology
    //   ludeon.rimworld.biotech
    //   ludeon.rimworld.anomaly
    if (paths.dataDir && fs.existsSync(paths.dataDir)) {
      mods.push(...(await scanRoot(paths.dataDir, 'official')));
    }

    if (rimworldModsDir && fs.existsSync(rimworldModsDir)) {
      mods.push(...(await scanRoot(rimworldModsDir, 'local')));
    }
    if (paths.workshopDir && fs.existsSync(paths.workshopDir)) {
      mods.push(...(await scanRoot(paths.workshopDir, 'workshop')));
    }
    if (fs.existsSync(workspaceRoot)) {
      const workspaceMods = await scanRoot(workspaceRoot, 'workspace');
      // Detect symlink presence in RimWorld's Mods/.
      for (const m of workspaceMods) {
        m.workspaceSynced = await isSymlinkedInto(
          m.folder,
          m.path,
          rimworldModsDir,
        );
      }
      // If a workspace mod has been symlinked, the symlink target also shows
      // up under "local". Drop the duplicate by packageId (workspace wins).
      const workspaceIds = new Set(
        workspaceMods.map((m) => m.about.packageIdLc).filter(Boolean),
      );
      for (let i = mods.length - 1; i >= 0; i--) {
        const m = mods[i];
        if (
          m.source === 'local' &&
          m.about.packageIdLc &&
          workspaceIds.has(m.about.packageIdLc)
        ) {
          mods.splice(i, 1);
        }
      }
      mods.push(...workspaceMods);
    }

    const config = await readModsConfig();
    const activeOrder = config.activeMods;
    const byPackageId = new Map<string, RegistryMod>();
    for (const m of mods) {
      if (m.about.packageIdLc) byPackageId.set(m.about.packageIdLc, m);
    }

    // Auto-heal: any workspace mod whose packageId is in <activeMods> but
    // that hasn't been symlinked into RimWorld's Mods/ won't actually load —
    // RimWorld can't find a folder for the packageId. This state can arise
    // from older modmixer builds or from manual ModsConfig edits. Sync the
    // symlink and let the next scan pick up the corrected state.
    const healed: string[] = [];
    for (const m of mods) {
      if (m.source !== 'workspace') continue;
      if (!m.about.packageIdLc) continue;
      if (!activeOrder.includes(m.about.packageIdLc)) continue;
      if (m.workspaceSynced) continue;
      try {
        await syncModToGame(m.folder);
        healed.push(m.folder);
      } catch (err) {
        console.warn(
          `[registry] auto-heal failed to sync workspace mod ${m.folder}:`,
          err,
        );
      }
    }
    if (healed.length > 0) {
      console.log(
        `[registry] auto-healed ${healed.length} workspace mod symlink(s):`,
        healed.join(', '),
      );
      // Re-stat the workspace mods so workspaceSynced reflects the new state
      // before we publish the snapshot.
      for (const m of mods) {
        if (m.source !== 'workspace') continue;
        m.workspaceSynced = await isSymlinkedInto(
          m.folder,
          m.path,
          rimworldModsDir,
        );
      }
    }

    const active: ActiveMod[] = activeOrder.map((id, i) => ({
      packageId: id,
      loadOrder: i + 1,
      mod: byPackageId.get(id) ?? null,
    }));
    const missingActive = active.filter((a) => !a.mod).map((a) => a.packageId);
    const gameVersionMajorMinor = parseMajorMinor(config.version);

    this.snapshot = {
      mods,
      active,
      activeOrder,
      missingActive,
      gameVersion: config.version,
      gameVersionMajorMinor,
    };
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        // ignore listener errors
      }
    }
  }
}

async function scanRoot(
  root: string,
  source: ModSource,
): Promise<RegistryMod[]> {
  const entries = await safeReaddir(root);
  const result: RegistryMod[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
    const modPath = path.join(root, entry.name);
    const aboutPath = path.join(modPath, 'About', 'About.xml');
    let about: AboutXml = parseAboutXml('');
    if (fs.existsSync(aboutPath)) {
      try {
        about = parseAboutXml(await fsp.readFile(aboutPath, 'utf8'));
      } catch {
        // ignore parse errors — leaves the empty AboutXml shape
      }
    }
    if (!about.name) about = { ...about, name: entry.name };

    // Core ships without an About.xml; synthesize one so it shows up.
    if (source === 'official' && !about.packageId) {
      const synth = officialSynthesis(entry.name);
      if (synth) {
        about = { ...about, ...synth };
      }
    }

    // Workshop mods: the folder name IS the published file id.
    let publishedFileId: string | null = null;
    if (source === 'workshop' && /^\d+$/.test(entry.name)) {
      publishedFileId = entry.name;
    } else {
      publishedFileId = await readPublishedFileId(modPath);
    }

    result.push({
      folder: entry.name,
      path: modPath,
      source,
      about,
      hasDlls: await containsDll(path.join(modPath, 'Assemblies')),
      publishedFileId,
      workspaceSynced: false,
    });
  }
  return result;
}

async function safeReaddir(dir: string): Promise<fs.Dirent[]> {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

const OFFICIAL_PACKAGE_IDS: Record<string, { name: string; packageId: string }> = {
  Core: { name: 'Core', packageId: 'ludeon.rimworld' },
  Royalty: { name: 'Royalty', packageId: 'ludeon.rimworld.royalty' },
  Ideology: { name: 'Ideology', packageId: 'ludeon.rimworld.ideology' },
  Biotech: { name: 'Biotech', packageId: 'ludeon.rimworld.biotech' },
  Anomaly: { name: 'Anomaly', packageId: 'ludeon.rimworld.anomaly' },
};

function officialSynthesis(folder: string): {
  name: string;
  packageId: string;
  packageIdLc: string;
} | null {
  const known = OFFICIAL_PACKAGE_IDS[folder];
  if (!known) return null;
  return {
    name: known.name,
    packageId: known.packageId,
    packageIdLc: known.packageId.toLowerCase(),
  };
}

function parseMajorMinor(version: string): string | null {
  const m = version.match(/^(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}` : null;
}

let registryInstance: ModRegistry | null = null;

export function getRegistry(): ModRegistry {
  if (!registryInstance) {
    registryInstance = new ModRegistry();
  }
  return registryInstance;
}
