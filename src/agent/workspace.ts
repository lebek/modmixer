import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { detectRimWorldPaths } from './paths.js';
import { readSchematic, type SchematicData } from './schematic.js';
import { scanAssets } from './assets/scanner.js';

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
  };
}

export function parseAbout(xml: string): AboutMetadata {
  return {
    name: extractTag(xml, 'name'),
    packageId: extractTag(xml, 'packageId'),
    description: extractTag(xml, 'description'),
    author: extractTag(xml, 'author'),
    supportedVersions: extractList(xml, 'supportedVersions'),
  };
}

function extractTag(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return (m?.[1] ?? '').trim();
}

function extractList(xml: string, parentTag: string): string[] {
  const wrap = xml.match(
    new RegExp(`<${parentTag}>([\\s\\S]*?)</${parentTag}>`),
  );
  if (!wrap) return [];
  const items: string[] = [];
  const re = /<li>([\s\S]*?)<\/li>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(wrap[1])) !== null) {
    items.push(match[1].trim());
  }
  return items;
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
    : ['1.5'];
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
 * supportedVersions in the patch is currently unsupported here — it's a
 * list, and rewriting it safely while preserving formatting isn't worth
 * the complexity until we expose it in the UI.
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
