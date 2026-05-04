import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { detectRimWorldPaths, detectGameVersionMajorMinorSync } from './paths.js';
import { readSchematic, type SchematicData } from './schematic.js';
import { scanAssets } from './assets/scanner.js';
import { parseAboutXml, type ModDependency } from './registry/about-xml.js';

export interface WorkspacePaths {
  /** ModMixer's owned mods directory. The user's WIP mods live here. */
  workspaceDir: string;
  /** RimWorld's Mods/ directory. Symlinks live here when a mod is active in game. */
  rimworldModsDir: string;
}

export interface AboutMetadata {
  name: string;
  packageId: string;
  description: string;
  author: string;
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
}

const SKIP = new Set(['.git', '.DS_Store', '.vs', 'bin', 'obj', 'node_modules']);

export function getWorkspacePaths(): WorkspacePaths {
  const workspaceDir = path.join(app.getPath('userData'), 'workspace', 'Mods');
  fs.mkdirSync(workspaceDir, { recursive: true });
  const { modsDir } = detectRimWorldPaths();
  // Only create modsDir if its parent already exists — i.e. RimWorld is
  // actually installed. Otherwise we'd materialize a fake empty .app bundle
  // or a stray ~/Library directory.
  if (fs.existsSync(path.dirname(modsDir))) {
    fs.mkdirSync(modsDir, { recursive: true });
  }
  return { workspaceDir, rimworldModsDir: modsDir };
}

export async function listWorkspaceMods(): Promise<WorkspaceMod[]> {
  const { workspaceDir, rimworldModsDir } = getWorkspacePaths();
  const entries = await fsp.readdir(workspaceDir, { withFileTypes: true });
  const mods: WorkspaceMod[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP.has(entry.name)) continue;
    const workspacePath = path.join(workspaceDir, entry.name);
    const aboutPath = path.join(workspacePath, 'About', 'About.xml');
    const about = fs.existsSync(aboutPath)
      ? parseAbout(await fsp.readFile(aboutPath, 'utf8'))
      : emptyAbout(entry.name);
    const hasCSharp = await containsCsproj(path.join(workspacePath, 'Source'));
    const hasDlls = await containsDll(path.join(workspacePath, 'Assemblies'));
    const active = await isModActive(entry.name, workspacePath, rimworldModsDir);
    const schematic = await readSchematic(entry.name);
    const publishedFileId = await readPublishedFileIdFile(workspacePath);
    mods.push({
      folder: entry.name,
      workspacePath,
      active,
      about,
      schematic,
      hasCSharp,
      hasDlls,
      publishedFileId,
    });
  }
  mods.sort((a, b) => a.about.name.localeCompare(b.about.name));
  return mods;
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

export async function syncModToGame(folder: string): Promise<void> {
  const t0 = Date.now();
  console.log(`${SYNC_LOG_PREFIX} start folder=${folder}`);
  const { workspaceDir, rimworldModsDir } = getWorkspacePaths();
  const target = path.join(workspaceDir, folder);
  const link = path.join(rimworldModsDir, folder);
  if (!fs.existsSync(target)) {
    throw new Error(`Workspace mod not found: ${target}`);
  }
  // Materialize asset placeholders before the link goes live so RimWorld
  // doesn't log "Could not load texture/AudioClip" for assets the user
  // hasn't dropped in yet. scanAssets runs the stub pipeline as a side
  // effect; the result is unused here. Bounded by a timeout so a runaway
  // scanner can't hang sync indefinitely.
  try {
    await withTimeout('scanAssets', SCAN_ASSETS_TIMEOUT_MS, () => scanAssets(target));
  } catch (err) {
    // non-fatal: bad XML / scanner failure / timeout shouldn't block sync.
    console.warn(`${SYNC_LOG_PREFIX} scanAssets failed (continuing):`, err);
  }
  if (await withTimeout('isModActive', 5_000, () => isModActive(folder, target, rimworldModsDir))) {
    console.log(`${SYNC_LOG_PREFIX} done (already active) total=${Date.now() - t0}ms`);
    return;
  }
  if (fs.existsSync(link)) {
    throw new Error(
      `${link} already exists and is not a symlink to the workspace. Remove it manually before syncing.`,
    );
  }
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  await withTimeout('symlink', 5_000, () => fsp.symlink(target, link, type));
  console.log(`${SYNC_LOG_PREFIX} done total=${Date.now() - t0}ms`);
}

export async function unsyncModFromGame(folder: string): Promise<void> {
  const { workspaceDir, rimworldModsDir } = getWorkspacePaths();
  const target = path.join(workspaceDir, folder);
  const link = path.join(rimworldModsDir, folder);
  if (!(await isModActive(folder, target, rimworldModsDir))) {
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
  const { rimworldModsDir } = getWorkspacePaths();
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

  const aboutSrc = path.join(resolvedSrc, 'About', 'About.xml');
  let aboutName = '';
  try {
    const xml = await fsp.readFile(aboutSrc, 'utf8');
    aboutName = parseAbout(xml).name;
  } catch {
    // missing or unreadable; fall back to source basename
  }

  const baseName =
    sanitizeFolderName(aboutName) ||
    sanitizeFolderName(path.basename(resolvedSrc)) ||
    'ImportedMod';
  const folder = uniqueWorkspaceFolder(workspaceDir, baseName);
  const dest = path.join(workspaceDir, folder);

  await fsp.cp(resolvedSrc, dest, {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: (source) => !SKIP.has(path.basename(source)),
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
    await fsp.writeFile(
      aboutDest,
      renderFreshAboutXml(emptyAbout(folder)),
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

function sanitizeFolderName(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_ -]/g, '').trim();
}

function uniqueWorkspaceFolder(workspaceDir: string, base: string): string {
  let candidate = base;
  let n = 2;
  while (fs.existsSync(path.join(workspaceDir, candidate))) {
    candidate = `${base} (${n})`;
    n += 1;
  }
  return candidate;
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

async function isModActive(
  folder: string,
  workspacePath: string,
  rimworldModsDir: string,
): Promise<boolean> {
  const link = path.join(rimworldModsDir, folder);
  try {
    const st = await fsp.lstat(link);
    if (!st.isSymbolicLink() && process.platform !== 'win32') return false;
    const resolved = await fsp.realpath(link);
    return resolved === (await fsp.realpath(workspacePath));
  } catch {
    return false;
  }
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

async function readPublishedFileIdFile(workspacePath: string): Promise<string | null> {
  const file = path.join(workspacePath, 'About', 'PublishedFileId.txt');
  try {
    const raw = (await fsp.readFile(file, 'utf8')).trim();
    return raw || null;
  } catch {
    return null;
  }
}

async function containsDll(dir: string): Promise<boolean> {
  if (!fs.existsSync(dir)) return false;
  try {
    const files = await fsp.readdir(dir);
    return files.some((f) => f.toLowerCase().endsWith('.dll'));
  } catch {
    return false;
  }
}

function emptyAbout(name: string): AboutMetadata {
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
