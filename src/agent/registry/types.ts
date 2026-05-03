// Public types for the mod registry. The registry is the single source of
// truth for "what mods exist on this machine, what's their metadata, what's
// their relationship graph, what's currently active in RimWorld."

import type { AboutXml } from './about-xml.js';

/**
 * Where a mod physically lives on disk.
 * - "official": shipped with the game install (Core + DLCs)
 * - "local": user's Mods/ folder (manual installs, modmixer workspace links)
 * - "workshop": Steam Workshop subscription
 * - "workspace": modmixer-managed workspace mod (a subset of "local",
 *   distinguished because we own these and the editor cares)
 */
export type ModSource = 'official' | 'local' | 'workshop' | 'workspace';

export interface RegistryMod {
  /** Folder name on disk (display key when packageId is missing). */
  folder: string;
  /** Absolute path to the mod folder. */
  path: string;
  source: ModSource;
  about: AboutXml;
  hasDlls: boolean;
  /**
   * Steam Workshop file id (PublishedFileId.txt) when present. Workshop
   * subscriptions store this implicitly via the folder name, which IS the
   * workshop id.
   */
  publishedFileId: string | null;
  /** True when symlinked into RimWorld's Mods/. Only meaningful for "workspace". */
  workspaceSynced: boolean;
}

export interface ActiveMod {
  /** Lowercase packageId. */
  packageId: string;
  /** 1-based load order. */
  loadOrder: number;
  /** Backing RegistryMod if found on disk, null when packageId is in
   * ModsConfig.xml but no folder matches (e.g. an uninstalled mod). */
  mod: RegistryMod | null;
}

export interface RegistrySnapshot {
  mods: RegistryMod[];
  active: ActiveMod[];
  /** Raw active list from ModsConfig.xml, lowercased. Authoritative ordering. */
  activeOrder: string[];
  /** packageIds in ModsConfig.xml that don't resolve to any mod on disk. */
  missingActive: string[];
  /** Game version recorded in ModsConfig.xml (e.g. "1.6.123 rev123"). */
  gameVersion: string;
  /** Game major.minor (e.g. "1.6"), derived from gameVersion or null. */
  gameVersionMajorMinor: string | null;
}
