import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';

const execFileP = promisify(execFile);

export type SaveKind = 'auto' | 'manual';

/**
 * One save in a mod's history. Pinned by sha so the underlying git object is
 * the source of truth — the index.json record is metadata + pointers back to
 * the chat that produced it. conversationId/entryId are best-effort: the
 * conversation may be deleted later, in which case "restore" still restores
 * files but skips the chat-rewind.
 */
export interface SaveRecord {
  sha: string;
  /** ms-since-epoch when the save was committed. */
  timestamp: number;
  /** User-supplied label; null for unnamed auto-saves. */
  label: string | null;
  kind: SaveKind;
  conversationId: string | null;
  entryId: string | null;
}

interface IndexFile {
  version: 1;
  saves: SaveRecord[];
}

const FILE_VERSION = 1;

export interface SnapshotsChangedEvent {
  folder: string;
  saves: SaveRecord[];
}

const events = new EventEmitter();

export function onSnapshotsChanged(
  handler: (event: SnapshotsChangedEvent) => void,
): () => void {
  events.on('changed', handler);
  return () => events.off('changed', handler);
}

function snapshotsRoot(): string {
  return path.join(app.getPath('userData'), 'snapshots');
}

function modSnapshotDir(folder: string): string {
  return path.join(snapshotsRoot(), folder);
}

function bareRepoPath(folder: string): string {
  return path.join(modSnapshotDir(folder), 'repo.git');
}

function indexPath(folder: string): string {
  return path.join(modSnapshotDir(folder), 'index.json');
}

/**
 * Mirrors getWorkspacePaths().workspaceDir without importing workspace.ts —
 * keeps this module dependency-free so it can be loaded without pulling in
 * the asset/about machinery.
 */
function modWorkspacePath(folder: string): string {
  return path.join(app.getPath('userData'), 'workspace', 'Mods', folder);
}

/**
 * Patterns written to the bare repo's info/exclude. .modmixer is the agent
 * sidecar (never part of the mod's history); the rest is build cruft / OS
 * noise we don't want polluting saves. Matched as gitignore patterns, so
 * trailing-slash forms cover any depth.
 */
const EXCLUDE_PATTERNS = [
  '.modmixer/',
  '.git/',
  '.DS_Store',
  '.vs/',
  'bin/',
  'obj/',
  'node_modules/',
];

async function git(
  folder: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  const dir = bareRepoPath(folder);
  const tree = modWorkspacePath(folder);
  return execFileP('git', ['--git-dir', dir, '--work-tree', tree, ...args]);
}

async function ensureRepo(folder: string): Promise<void> {
  const repo = bareRepoPath(folder);
  if (fs.existsSync(repo)) return;
  await fsp.mkdir(modSnapshotDir(folder), { recursive: true });
  await execFileP('git', ['init', '--bare', repo]);
  // info/exclude is the per-repo, never-committed equivalent of .gitignore;
  // ideal for our case because we don't want to litter the user's mod
  // folder with a Modmixer-owned .gitignore.
  const excludeFile = path.join(repo, 'info', 'exclude');
  await fsp.mkdir(path.dirname(excludeFile), { recursive: true });
  await fsp.writeFile(excludeFile, EXCLUDE_PATTERNS.join('\n') + '\n', 'utf8');
  // Pin author so commits don't fail on machines without a global git
  // user.email — Modmixer is the only entity ever writing here.
  await git(folder, ['config', 'user.email', 'modmixer@local']);
  await git(folder, ['config', 'user.name', 'Modmixer']);
}

async function readIndex(folder: string): Promise<IndexFile> {
  try {
    const raw = await fsp.readFile(indexPath(folder), 'utf8');
    const parsed = JSON.parse(raw) as IndexFile;
    if (parsed.version !== FILE_VERSION) {
      return { version: FILE_VERSION, saves: [] };
    }
    return parsed;
  } catch {
    return { version: FILE_VERSION, saves: [] };
  }
}

async function writeIndex(folder: string, idx: IndexFile): Promise<void> {
  const file = indexPath(folder);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(idx, null, 2), 'utf8');
}

async function currentHeadSha(folder: string): Promise<string | null> {
  try {
    const { stdout } = await git(folder, ['rev-parse', 'HEAD']);
    return stdout.trim() || null;
  } catch {
    return null; // no commits yet
  }
}

async function workingTreeIsClean(folder: string): Promise<boolean> {
  try {
    const { stdout } = await git(folder, ['status', '--porcelain']);
    return stdout.trim().length === 0;
  } catch {
    return true;
  }
}

export interface CommitOpts {
  /** Manual saves get this; auto-saves leave it null. */
  label?: string;
  kind?: SaveKind;
  conversationId?: string | null;
  entryId?: string | null;
}

/**
 * Snapshot the mod folder. Returns null when there's nothing to save (clean
 * tree, no manual label to apply). For manual saves on a clean tree, the
 * latest sha gets relabeled instead of producing an empty commit — keeps
 * the saves list tidy.
 */
export async function commitTurn(
  folder: string,
  opts: CommitOpts = {},
): Promise<SaveRecord | null> {
  if (!fs.existsSync(modWorkspacePath(folder))) return null;
  await ensureRepo(folder);
  await git(folder, ['add', '-A']);
  const headBefore = await currentHeadSha(folder);
  const clean = headBefore !== null && (await workingTreeIsClean(folder));

  if (clean) {
    // No file changes since the last commit. For an auto-save that just
    // means "no-op." For a manual save, relabel the existing record (or
    // mint one for a previously-unlabeled HEAD).
    if (opts.kind !== 'manual') return null;
    const idx = await readIndex(folder);
    const existing = idx.saves.find((s) => s.sha === headBefore);
    if (existing) {
      existing.label = opts.label?.trim() || null;
      existing.kind = 'manual';
      existing.timestamp = Date.now();
      await writeIndex(folder, idx);
      events.emit('changed', { folder, saves: idx.saves });
      return existing;
    }
    const record: SaveRecord = {
      sha: headBefore,
      timestamp: Date.now(),
      label: opts.label?.trim() || null,
      kind: 'manual',
      conversationId: opts.conversationId ?? null,
      entryId: opts.entryId ?? null,
    };
    idx.saves.unshift(record);
    await writeIndex(folder, idx);
    events.emit('changed', { folder, saves: idx.saves });
    return record;
  }

  const message = opts.label?.trim() || (opts.kind === 'manual' ? 'manual save' : 'auto save');
  // --allow-empty covers the very-first-commit-on-empty-folder edge case;
  // for normal commits we already checked the tree isn't clean.
  await git(folder, ['commit', '--allow-empty', '-m', message]);
  const sha = await currentHeadSha(folder);
  if (!sha) return null;
  const record: SaveRecord = {
    sha,
    timestamp: Date.now(),
    label: opts.label?.trim() || null,
    kind: opts.kind ?? 'auto',
    conversationId: opts.conversationId ?? null,
    entryId: opts.entryId ?? null,
  };
  const idx = await readIndex(folder);
  idx.saves.unshift(record);
  await writeIndex(folder, idx);
  events.emit('changed', { folder, saves: idx.saves });
  return record;
}

/**
 * Restore the mod folder to a saved sha. Untracked files matching
 * EXCLUDE_PATTERNS (notably .modmixer) survive — `git clean -fd` skips
 * paths the bare repo's info/exclude already ignores.
 */
export async function restoreSnapshot(
  folder: string,
  sha: string,
): Promise<void> {
  await ensureRepo(folder);
  await git(folder, ['reset', '--hard', sha]);
  // -d removes empty dirs; we deliberately do NOT pass -x, so ignored files
  // (the .modmixer sidecar) are left alone.
  await git(folder, ['clean', '-fd']);
}

export async function listSaves(folder: string): Promise<SaveRecord[]> {
  const idx = await readIndex(folder);
  return idx.saves;
}

export async function renameSave(
  folder: string,
  sha: string,
  label: string | null,
): Promise<SaveRecord | null> {
  const idx = await readIndex(folder);
  const save = idx.saves.find((s) => s.sha === sha);
  if (!save) return null;
  const trimmed = label?.trim() || null;
  save.label = trimmed;
  // Naming an auto-save promotes it to manual so it isn't ambiguous in the
  // UI list. Clearing the label leaves kind alone.
  if (trimmed) save.kind = 'manual';
  await writeIndex(folder, idx);
  events.emit('changed', { folder, saves: idx.saves });
  return save;
}

export async function deleteSave(folder: string, sha: string): Promise<void> {
  const idx = await readIndex(folder);
  const before = idx.saves.length;
  idx.saves = idx.saves.filter((s) => s.sha !== sha);
  if (idx.saves.length === before) return;
  await writeIndex(folder, idx);
  events.emit('changed', { folder, saves: idx.saves });
  // Git object stays in the bare repo until `git gc` runs. Cheap; not worth
  // doing here. A future retention pass can prune.
}

/** Nuke the entire snapshots directory for a mod. Called from delete-mod. */
export async function deleteAllSaves(folder: string): Promise<void> {
  await fsp.rm(modSnapshotDir(folder), { recursive: true, force: true });
}
