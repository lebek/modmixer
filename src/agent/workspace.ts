import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { detectRimWorldPaths, detectGameVersionMajorMinorSync } from './paths.js';
import { readSchematic, type SchematicData } from './schematic.js';
import { readModPrefs, writeModPrefs, type ModPrefs } from './mod-prefs.js';
import type { GameId } from './games/types.js';
import { DEFAULT_GAME_ID } from './games/registry.js';
import { getAdapter } from './adapters/index.js';
import { scanAssets } from './assets/scanner.js';
import { parseAboutXml, type ModDependency } from './registry/about-xml.js';
import { loadSettings } from './settings.js';
import { track } from './telemetry.js';
import {
  SKIP_DIRS,
  containsDll,
  isSymlinkedInto,
  latestMtimeMs,
  readPublishedFileId,
} from './fs-helpers.js';

export interface WorkspacePaths {
  /** ModMixer's owned mods directory. The user's WIP mods live here. */
  workspaceDir: string;
}

export interface AboutMetadata {
  name: string;
  packageId: string;
  description: string;
  author: string;
  /**
   * The mod's own version. Minecraft: gradle.properties mod_version (baked
   * into the jar name and neoforge.mods.toml at build time). RimWorld doesn't
   * surface one here yet, so it's optional.
   */
  version?: string;
  /**
   * SPDX license id (e.g. "MIT", "CC0-1.0", "All-Rights-Reserved"), or a custom
   * id the user typed. A mod-level property surfaced uniformly to the UI, but
   * stored per game: RimWorld keeps it in the .modmixer prefs sidecar (About.xml
   * has no license field), Minecraft in gradle.properties mod_license. Undefined
   * when never set — the picker defaults to MIT.
   */
  license?: string;
  supportedVersions: string[];
  /** Hard deps from <modDependencies>. Empty when none declared. */
  modDependencies: ModDependency[];
  /** Soft "load after these" hints, lowercased packageIds. */
  loadAfter: string[];
  /** Soft "load before these" hints, lowercased packageIds. */
  loadBefore: string[];
  /** Declared incompatible mods, lowercased packageIds. */
  incompatibleWith: string[];
}

export interface WorkspaceMod {
  folder: string;
  workspacePath: string;
  active: boolean;
  about: AboutMetadata;
  /**
   * Agent-owned spec sidecar — null only if the mod folder is missing
   * altogether. New mods that have never been touched by the agent get an
   * empty SchematicData so the renderer can branch on its presence.
   */
  schematic: SchematicData | null;
  hasCSharp: boolean;
  hasDlls: boolean;
  /**
   * Steam Workshop item id from About/PublishedFileId.txt if the mod has
   * been published before. Stored as a string because Workshop ids are
   * 64-bit and can exceed JS safe-int range.
   */
  publishedFileId: string | null;
  /**
   * Per-mod user preferences (.modmixer/prefs.json). Always present — defaults
   * are filled in when the sidecar is missing, so callers never branch on null.
   */
  prefs: ModPrefs;
  /** Workspace folder birthtime, epoch ms. */
  createdAt: number;
  /** Most-recent mtime under the workspace folder, epoch ms. */
  updatedAt: number;
}

export function getWorkspacePaths(): WorkspacePaths {
  const workspaceDir = path.join(app.getPath('userData'), 'workspace', 'Mods');
  fs.mkdirSync(workspaceDir, { recursive: true });
  return { workspaceDir };
}

/**
 * RimWorld's Mods/ directory, where syncModToGame drops symlinks. RimWorld-only,
 * so it's kept out of getWorkspacePaths() — the ~25 game-neutral callers that
 * only want the workspace dir shouldn't probe (or materialize) RimWorld paths.
 * Creates the dir only when RimWorld is actually installed (its parent exists);
 * otherwise we'd leave a stray empty .app bundle or ~/Library directory.
 */
export function getRimWorldModsDir(): string {
  const { modsDir } = detectRimWorldPaths();
  if (fs.existsSync(path.dirname(modsDir))) {
    fs.mkdirSync(modsDir, { recursive: true });
  }
  return modsDir;
}

export async function listWorkspaceMods(): Promise<WorkspaceMod[]> {
  const { workspaceDir } = getWorkspacePaths();
  const rimworldModsDir = getRimWorldModsDir();
  const entries = await fsp.readdir(workspaceDir, { withFileTypes: true });
  // Build each mod's record in parallel — the per-mod sub-reads are I/O-bound
  // and independent. Sequential made this scale linearly with mod count and
  // it's hit on every refresh.
  const mods = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !SKIP_DIRS.has(entry.name))
      .map((entry) => buildWorkspaceMod(entry.name, workspaceDir, rimworldModsDir)),
  );
  mods.sort((a, b) => a.about.name.localeCompare(b.about.name));
  return mods;
}

async function buildWorkspaceMod(
  folder: string,
  workspaceDir: string,
  rimworldModsDir: string,
): Promise<WorkspaceMod> {
  const workspacePath = path.join(workspaceDir, folder);
  const [
    hasCSharp,
    hasDlls,
    active,
    schematic,
    publishedFileId,
    prefs,
    folderStat,
    updatedAt,
  ] = await Promise.all([
    containsCsproj(path.join(workspacePath, 'Source')),
    containsDll(path.join(workspacePath, 'Assemblies')),
    isSymlinkedInto(folder, workspacePath, rimworldModsDir),
    readSchematic(folder),
    readPublishedFileId(workspacePath),
    readModPrefs(folder),
    fsp.stat(workspacePath).catch(() => null),
    latestMtimeMs(workspacePath),
  ]);
  // Identity comes from the game's adapter — RimWorld reads About.xml, Minecraft
  // maps gradle.properties onto the same AboutMetadata shape — so the UI shows
  // the real name instead of the folder id, with no game branch here.
  const about =
    (await getAdapter(prefs.game).readModMetadata(workspacePath, folder)) ??
    emptyAbout(folder);
  const createdAt = folderStat?.birthtimeMs ?? folderStat?.ctimeMs ?? 0;
  return {
    folder,
    workspacePath,
    active,
    about,
    schematic,
    hasCSharp,
    hasDlls,
    publishedFileId,
    prefs,
    createdAt,
    updatedAt,
  };
}

export async function getWorkspaceMod(folder: string): Promise<WorkspaceMod | null> {
  const all = await listWorkspaceMods();
  return all.find((m) => m.folder === folder) ?? null;
}

/**
 * Read About.xml for a workspace mod, or null if the folder doesn't exist.
 * Returns a zeroed-out metadata object (with `name` defaulted to the folder)
 * if the folder exists but About.xml does not.
 */
export async function readModAbout(folder: string): Promise<AboutMetadata | null> {
  const { workspaceDir } = getWorkspacePaths();
  const modDir = path.join(workspaceDir, folder);
  if (!fs.existsSync(modDir)) return null;
  const aboutPath = path.join(modDir, 'About', 'About.xml');
  if (!fs.existsSync(aboutPath)) return emptyAbout(folder);
  return parseAbout(await fsp.readFile(aboutPath, 'utf8'));
}

/**
 * Patch About.xml in-place, preserving any tags we don't know about
 * (e.g. <modDependencies>, <modVersion>, <descriptionsByVersion>).
 *
 * If About.xml doesn't exist yet, render a fresh file from scratch.
 */
export async function writeAbout(
  folder: string,
  patch: Partial<AboutMetadata>,
): Promise<WorkspaceMod | null> {
  const { workspaceDir } = getWorkspacePaths();
  const modDir = path.join(workspaceDir, folder);
  if (!fs.existsSync(modDir)) return null;
  // About.xml is RimWorld's identity format; this is the RimWorld writer,
  // reached only via the RimWorld adapter and the RimWorld-only write-deps IPC
  // route (the read/write-about routes dispatch through the game adapter).
  // Minecraft identity is written through its own adapter (gradle.properties),
  // so no game check is needed here.
  const aboutDir = path.join(modDir, 'About');
  await fsp.mkdir(aboutDir, { recursive: true });
  const aboutPath = path.join(aboutDir, 'About.xml');

  const existing = fs.existsSync(aboutPath)
    ? await fsp.readFile(aboutPath, 'utf8')
    : null;

  const next = existing
    ? patchAboutXml(existing, patch)
    : renderFreshAboutXml({ ...emptyAbout(folder), ...patch });

  await fsp.writeFile(aboutPath, next, 'utf8');
  return getWorkspaceMod(folder);
}

const SYNC_LOG_PREFIX = '[syncModToGame]';
const SCAN_ASSETS_TIMEOUT_MS = 30_000;

async function withTimeout<T>(label: string, ms: number, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    console.log(`${SYNC_LOG_PREFIX} ${label} took ${Date.now() - start}ms`);
  }
}

export interface SyncModResult {
  /**
   * Workspace folder names whose stale RimWorld symlinks we removed because
   * they shared the target's packageId. Empty in the typical case; non-empty
   * when the user has multiple workspace variants of the same mod and a
   * prior test cycle had synced one of the siblings.
   */
  removedStaleSiblings: string[];
  /**
   * Drift warnings from the asset scan that ran during sync — typically
   * complaints that a `ContentFinder<T>.Get("X")` literal is missing from
   * `.modmixer/cs-assets.json` or vice versa. Surfaced so callers (sync's
   * tool result, run_test_cycle) can show them to the agent before the
   * mod actually loads in-game.
   */
  assetWarnings: string[];
}

export async function syncModToGame(folder: string): Promise<SyncModResult> {
  const t0 = Date.now();
  console.log(`${SYNC_LOG_PREFIX} start folder=${folder}`);
  const { workspaceDir } = getWorkspacePaths();
  const rimworldModsDir = getRimWorldModsDir();
  const target = path.join(workspaceDir, folder);
  const link = path.join(rimworldModsDir, folder);
  if (!fs.existsSync(target)) {
    throw new Error(`Workspace mod not found: ${target}`);
  }
  // Materialize asset placeholders before the link goes live so RimWorld
  // doesn't log "Could not load texture/AudioClip" for assets the user
  // hasn't dropped in yet. We also capture the scan's drift warnings to
  // bubble back to the agent — sync is the natural place to report them
  // because the stub system runs here. Bounded by a timeout so a runaway
  // scanner can't hang sync indefinitely.
  let assetWarnings: string[] = [];
  try {
    const scan = await withTimeout('scanAssets', SCAN_ASSETS_TIMEOUT_MS, () =>
      scanAssets(target),
    );
    assetWarnings = scan.warnings;
  } catch (err) {
    // non-fatal: bad XML / scanner failure / timeout shouldn't block sync.
    console.warn(`${SYNC_LOG_PREFIX} scanAssets failed (continuing):`, err);
  }
  // Strip any stale sibling syncs that share this mod's packageId. RimWorld
  // scans every folder under Mods/ regardless of <activeMods>; if the user
  // has six workspace variants of the same mod (six chats exploring "zombie
  // horde"), every prior test cycle left a junction behind and RimWorld
  // warns about duplicate packageIds on every launch. Run before the early
  // "already symlinked" return so the cleanup still happens when the target
  // itself is unchanged.
  const removedStaleSiblings = await pruneSiblingSyncs(
    folder,
    target,
    workspaceDir,
    rimworldModsDir,
  );
  if (removedStaleSiblings.length > 0) {
    console.log(
      `${SYNC_LOG_PREFIX} pruned ${removedStaleSiblings.length} stale sibling sync(s) sharing packageId: ${removedStaleSiblings.join(', ')}`,
    );
  }
  if (await withTimeout('isSymlinkedInto', 5_000, () => isSymlinkedInto(folder, target, rimworldModsDir))) {
    console.log(`${SYNC_LOG_PREFIX} done (already active) total=${Date.now() - t0}ms`);
    return { removedStaleSiblings, assetWarnings };
  }
  if (fs.existsSync(link)) {
    throw new Error(
      `${link} already exists and is not a symlink to the workspace. Remove it manually before syncing.`,
    );
  }
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  await withTimeout('symlink', 5_000, () => fsp.symlink(target, link, type));
  console.log(`${SYNC_LOG_PREFIX} done total=${Date.now() - t0}ms`);
  return { removedStaleSiblings, assetWarnings };
}

/**
 * Enumerate RimWorld's Mods/ and remove any modmixer-owned symlinks (realpath
 * resolves back into the workspace) whose backing folder declares the same
 * packageId as the target. Only workspace-owned entries are touched, so the
 * user's Steam Workshop and hand-installed mods stay put even if they happen
 * to share an id.
 *
 * Returns the workspace folder names of removed siblings (not their on-disk
 * link paths). Empty array on no-op or when the target's packageId is
 * unreadable (we err on the side of leaving things alone).
 */
async function pruneSiblingSyncs(
  targetFolder: string,
  targetPath: string,
  workspaceDir: string,
  rimworldModsDir: string,
): Promise<string[]> {
  if (!fs.existsSync(rimworldModsDir)) return [];
  const targetPidLc = await readPackageIdLc(targetPath);
  if (!targetPidLc) return [];

  let resolvedWorkspace: string;
  try {
    resolvedWorkspace = await fsp.realpath(workspaceDir);
  } catch {
    return [];
  }

  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(rimworldModsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const removed: string[] = [];
  for (const entry of entries) {
    if (entry.name === targetFolder) continue;
    const link = path.join(rimworldModsDir, entry.name);

    // Only entries that resolve back into our workspace are modmixer-owned;
    // anything else (Steam Workshop subscribe, hand-installed mod, the user's
    // own symlink) we never touch.
    let resolved: string;
    try {
      const lst = await fsp.lstat(link);
      if (!lst.isSymbolicLink() && process.platform !== 'win32') continue;
      resolved = await fsp.realpath(link);
    } catch {
      continue;
    }
    const rel = path.relative(resolvedWorkspace, resolved);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;

    const pidLc = await readPackageIdLc(resolved);
    if (!pidLc || pidLc !== targetPidLc) continue;

    try {
      await fsp.rm(link, { recursive: true, force: true });
      removed.push(entry.name);
    } catch (err) {
      console.warn(
        `${SYNC_LOG_PREFIX} failed to prune stale sibling sync ${link}:`,
        err,
      );
    }
  }
  return removed;
}

async function readPackageIdLc(modPath: string): Promise<string> {
  try {
    const xml = await fsp.readFile(
      path.join(modPath, 'About', 'About.xml'),
      'utf8',
    );
    return parseAbout(xml).packageId.trim().toLowerCase();
  } catch {
    return '';
  }
}

export async function unsyncModFromGame(folder: string): Promise<void> {
  const { workspaceDir } = getWorkspacePaths();
  const rimworldModsDir = getRimWorldModsDir();
  const target = path.join(workspaceDir, folder);
  const link = path.join(rimworldModsDir, folder);
  if (!(await isSymlinkedInto(folder, target, rimworldModsDir))) {
    return; // not active or not ours, leave alone
  }
  await fsp.unlink(link);
}

/**
 * Permanently remove the symlink in RimWorld's Mods/ directory if it points
 * at our workspace folder. Unlike `unsyncModFromGame` this also runs after
 * the workspace folder has been deleted (when realpath comparison fails) —
 * it just refuses to delete a non-symlink, since that would be the user's
 * own data.
 */
async function removeRimWorldLink(folder: string): Promise<void> {
  const rimworldModsDir = getRimWorldModsDir();
  const link = path.join(rimworldModsDir, folder);
  let st: fs.Stats;
  try {
    st = await fsp.lstat(link);
  } catch {
    return; // nothing there
  }
  // Refuse to nuke a real directory — that's not ours to delete. On Windows
  // junctions report as directories from lstat but `isSymbolicLink` returns
  // true for them; only real dirs reach the throw.
  if (!st.isSymbolicLink() && st.isDirectory() && process.platform !== 'win32') {
    throw new Error(
      `${link} is a real directory, not a symlink — refusing to delete.`,
    );
  }
  await fsp.rm(link, { recursive: true, force: true });
}

export interface ImportModResult {
  folder: string;
  workspacePath: string;
  /** True if About.xml was missing/unparseable and we synthesized a fresh one. */
  synthesizedAbout: boolean;
}

/**
 * Copy an external mod folder into the workspace so it shows up alongside
 * scaffolded mods. Source stays untouched. If About.xml is missing or
 * unparseable, a fresh one is synthesized so the rest of the app (which
 * keys off About) doesn't blow up. About/PublishedFileId.txt is preserved
 * so users re-importing their own mods can keep pushing updates to the
 * existing Workshop item; the publish panel exposes a "disconnect" button
 * for the rarer case of forking someone else's mod.
 */
export async function importModFromFolder(
  srcPath: string,
): Promise<ImportModResult> {
  const { workspaceDir } = getWorkspacePaths();

  let resolvedSrc: string;
  try {
    resolvedSrc = await fsp.realpath(srcPath);
  } catch {
    throw new Error(`Source folder does not exist: ${srcPath}`);
  }
  const stat = await fsp.stat(resolvedSrc);
  if (!stat.isDirectory()) {
    throw new Error(`Source is not a folder: ${resolvedSrc}`);
  }

  const resolvedWorkspace = await fsp.realpath(workspaceDir);
  const rel = path.relative(resolvedWorkspace, resolvedSrc);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    throw new Error(
      'That folder is already inside the Modmixer workspace — nothing to import.',
    );
  }

  // Source's About.xml name is preserved inside the copied About.xml, so
  // the mod's user-facing identity is intact — we just use a random folder
  // id on disk so we never have to worry about renames or name collisions.
  const folder = mintWorkspaceFolderId(workspaceDir);
  const dest = path.join(workspaceDir, folder);

  await fsp.cp(resolvedSrc, dest, {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: (source) => !SKIP_DIRS.has(path.basename(source)),
  });

  let synthesizedAbout = false;
  const aboutDest = path.join(dest, 'About', 'About.xml');
  let needsFreshAbout = false;
  try {
    const xml = await fsp.readFile(aboutDest, 'utf8');
    parseAbout(xml);
  } catch {
    needsFreshAbout = true;
  }
  if (needsFreshAbout) {
    await fsp.mkdir(path.join(dest, 'About'), { recursive: true });
    // Folder is now a random hex id, so use the source dir's basename as a
    // sensible default for the synthesized display name. User can rename via
    // the agent / About panel later; folder stays the same.
    const fallbackName =
      displayNameFromBasename(path.basename(resolvedSrc)) || 'Imported Mod';
    await fsp.writeFile(
      aboutDest,
      renderFreshAboutXml(emptyAbout(fallbackName)),
      'utf8',
    );
    synthesizedAbout = true;
  }

  return {
    folder,
    workspacePath: dest,
    synthesizedAbout,
  };
}

/**
 * Create a fresh "Untitled Mod" workspace folder via the game's
 * createPlaceholder — RimWorld: About.xml + the standard subdirs (XML-only;
 * C# is added on demand via the add_csharp tool). Minecraft: a buildable
 * NeoForge gradle project. Used by the renderer's "+ new mod" button (and any
 * 'new'-scope chat) so the chat is bound to a real on-disk mod from message
 * zero — the agent fills in the real metadata via set_mod_metadata and writes
 * files once it understands what the user wants to build.
 *
 * The folder name is a random hex id, not "Untitled Mod" — we never want
 * to rename folders, so the on-disk identifier stays stable for the mod's
 * entire life and the user-facing name lives in About.xml's <name>.
 */
export async function createUntitledMod(
  game: GameId = DEFAULT_GAME_ID,
): Promise<{
  folder: string;
  workspacePath: string;
  game: GameId;
}> {
  const { workspaceDir } = getWorkspacePaths();
  const folder = mintWorkspaceFolderId(workspaceDir);
  const modPath = path.join(workspaceDir, folder);
  await fsp.mkdir(modPath, { recursive: true });
  const author = loadSettings().defaultAuthor || 'Modmixer User';
  // The game's adapter owns its placeholder shape (RimWorld: About.xml + subdirs;
  // Minecraft: a buildable NeoForge project from the vendored MDK).
  await getAdapter(game).createPlaceholder(modPath, { author });
  // Record the target game immediately so the agent session bound to this mod
  // targets the right toolchain from message zero. Minecraft mods get their
  // Gradle/NeoForge project scaffolded by the agent's game-specific tool; the
  // untitled shell is just the folder + prefs until then.
  await writeModPrefs(folder, { game });
  track({ name: 'mod_created' });
  return { folder, workspacePath: modPath, game };
}

/**
 * Mint a fresh random folder id for a workspace mod. 12 hex chars — short
 * enough to type, long enough that collisions are vanishingly rare (~10^14
 * possibilities). We retry on collision anyway so the contract is "always
 * returns a free id."
 */
export function mintWorkspaceFolderId(workspaceDir: string): string {
  for (let i = 0; i < 8; i += 1) {
    const id = randomBytes(6).toString('hex');
    if (!fs.existsSync(path.join(workspaceDir, id))) return id;
  }
  // Fall through to a longer id if we somehow hit 8 collisions in a row —
  // the universe is broken but we still need to return something.
  return randomBytes(12).toString('hex');
}

function displayNameFromBasename(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_ -]/g, '').trim();
}

/**
 * Delete a workspace mod completely: remove the RimWorld symlink (if any),
 * then delete the workspace folder on disk. Caller is responsible for
 * removing the packageId from ModsConfig.xml *before* calling this — once
 * the folder is gone, About.xml is no longer readable.
 */
export async function deleteWorkspaceMod(folder: string): Promise<void> {
  const { workspaceDir } = getWorkspacePaths();
  const target = path.join(workspaceDir, folder);
  if (!fs.existsSync(target)) return;
  await removeRimWorldLink(folder);
  await fsp.rm(target, { recursive: true, force: true });
}

async function containsCsproj(dir: string): Promise<boolean> {
  if (!fs.existsSync(dir)) return false;
  try {
    const files = await fsp.readdir(dir);
    return files.some((f) => f.toLowerCase().endsWith('.csproj'));
  } catch {
    return false;
  }
}

export function emptyAbout(name: string): AboutMetadata {
  return {
    name,
    packageId: '',
    description: '',
    author: '',
    supportedVersions: [],
    modDependencies: [],
    loadAfter: [],
    loadBefore: [],
    incompatibleWith: [],
  };
}

export function parseAbout(xml: string): AboutMetadata {
  const parsed = parseAboutXml(xml);
  return {
    name: parsed.name,
    packageId: parsed.packageId,
    description: parsed.description,
    author: parsed.author,
    supportedVersions: parsed.supportedVersions,
    modDependencies: parsed.modDependencies,
    loadAfter: parsed.loadAfter,
    loadBefore: parsed.loadBefore,
    incompatibleWith: parsed.incompatibleWith,
  };
}

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Render a brand-new About.xml from scratch. */
export function renderFreshAboutXml(meta: AboutMetadata): string {
  const versions = meta.supportedVersions.length > 0
    ? meta.supportedVersions
    : [detectGameVersionMajorMinorSync() ?? '1.5'];
  const versionList = versions
    .map((v) => `    <li>${escapeXml(v)}</li>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<ModMetaData>
  <name>${escapeXml(meta.name)}</name>
  <packageId>${escapeXml(meta.packageId)}</packageId>
  <author>${escapeXml(meta.author)}</author>
  <description>${escapeXml(meta.description)}</description>
  <supportedVersions>
${versionList}
  </supportedVersions>
</ModMetaData>
`;
}

/**
 * Apply scalar patches to an existing About.xml string. We only touch the
 * scalar tags the patch mentions; everything else (existing structure,
 * unknown tags, comments, whitespace) is preserved. If a target tag is
 * missing, we insert it just before </ModMetaData>.
 *
 * Supports scalar fields and the list-shaped dep/load fields. supportedVersions
 * is still left to manual editing — we don't yet have UI to change it and
 * rewriting it without flattening custom formatting isn't worth the risk.
 */
function patchAboutXml(xml: string, patch: Partial<AboutMetadata>): string {
  let out = xml;
  const scalarFields: Array<keyof AboutMetadata> = [
    'name',
    'packageId',
    'author',
    'description',
  ];
  for (const field of scalarFields) {
    const value = patch[field];
    if (value === undefined || typeof value !== 'string') continue;
    out = upsertScalarTag(out, field, value);
  }
  if (patch.modDependencies !== undefined) {
    out = upsertModDependencies(out, patch.modDependencies);
  }
  if (patch.loadAfter !== undefined) {
    out = upsertSimpleListTag(out, 'loadAfter', patch.loadAfter);
  }
  if (patch.loadBefore !== undefined) {
    out = upsertSimpleListTag(out, 'loadBefore', patch.loadBefore);
  }
  if (patch.incompatibleWith !== undefined) {
    out = upsertSimpleListTag(out, 'incompatibleWith', patch.incompatibleWith);
  }
  return out;
}

function upsertScalarTag(xml: string, tag: string, value: string): string {
  const escaped = escapeXml(value);
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`);
  if (re.test(xml)) {
    return xml.replace(re, `<${tag}>${escaped}</${tag}>`);
  }
  // Insert before </ModMetaData>, indented to match the file's style.
  const close = '</ModMetaData>';
  const idx = xml.lastIndexOf(close);
  if (idx === -1) return xml; // malformed; leave alone
  const insertion = `  <${tag}>${escaped}</${tag}>\n`;
  return xml.slice(0, idx) + insertion + xml.slice(idx);
}

function upsertSimpleListTag(xml: string, tag: string, items: string[]): string {
  const close = '</ModMetaData>';
  if (items.length === 0) {
    // Empty list — drop the tag entirely if present.
    return xml.replace(
      new RegExp(`\\s*<${tag}>[\\s\\S]*?</${tag}>`, 'g'),
      '',
    );
  }
  const lis = items.map((v) => `    <li>${escapeXml(v)}</li>`).join('\n');
  const block = `  <${tag}>\n${lis}\n  </${tag}>`;
  const re = new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`);
  if (re.test(xml)) {
    return xml.replace(re, block.trimStart());
  }
  const idx = xml.lastIndexOf(close);
  if (idx === -1) return xml;
  return xml.slice(0, idx) + block + '\n' + xml.slice(idx);
}

function upsertModDependencies(
  xml: string,
  deps: ModDependency[],
): string {
  const close = '</ModMetaData>';
  if (deps.length === 0) {
    return xml.replace(
      /\s*<modDependencies>[\s\S]*?<\/modDependencies>/g,
      '',
    );
  }
  const lis = deps
    .map((d) => {
      const lines = [
        `    <li>`,
        `      <packageId>${escapeXml(d.packageId)}</packageId>`,
      ];
      if (d.displayName) {
        lines.push(`      <displayName>${escapeXml(d.displayName)}</displayName>`);
      }
      if (d.steamWorkshopUrl) {
        lines.push(`      <steamWorkshopUrl>${escapeXml(d.steamWorkshopUrl)}</steamWorkshopUrl>`);
      }
      if (d.downloadUrl) {
        lines.push(`      <downloadUrl>${escapeXml(d.downloadUrl)}</downloadUrl>`);
      }
      lines.push(`    </li>`);
      return lines.join('\n');
    })
    .join('\n');
  const block = `  <modDependencies>\n${lis}\n  </modDependencies>`;
  const re = /<modDependencies>[\s\S]*?<\/modDependencies>/;
  if (re.test(xml)) {
    return xml.replace(re, block.trimStart());
  }
  const idx = xml.lastIndexOf(close);
  if (idx === -1) return xml;
  return xml.slice(0, idx) + block + '\n' + xml.slice(idx);
}
