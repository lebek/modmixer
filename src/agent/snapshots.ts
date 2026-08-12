import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import {
  add as gitAdd,
  checkout as gitCheckout,
  commit as gitCommit,
  init as gitInit,
  isDescendent as gitIsDescendent,
  remove as gitRemove,
  resolveRef as gitResolveRef,
  statusMatrix as gitStatusMatrix,
  walk as gitWalk,
  TREE,
  type WalkerEntry,
} from 'isomorphic-git';
import {
  getModConversationsSlice,
  reloadConversations,
  replaceModConversationsSlice,
  type Conversation,
  type ModConversationsSlice,
} from './conversations.js';
import {
  compactSnapshotDir,
  dirSizeBytes,
  migrateCapMarkers,
  recoverInterruptedCompaction,
  selectSavesToKeep,
  type SnapshotIndexFile,
} from './snapshot-compact.js';

export type SaveKind = 'auto' | 'manual';

/**
 * Retention: how many un-labeled autosaves a mod keeps. Manual and labeled
 * saves are never auto-pruned, and neither are saves that predate the cap
 * (preCap) — those only go through the user-consented Storage cleanup.
 */
export const KEEP_AUTOSAVES = 15;
/**
 * Auto-compaction trigger: once the forward cap has dropped this many rows
 * since the last compaction, the repo is rewritten in the background to
 * actually free the bytes (dropping a manifest row alone frees nothing —
 * isomorphic-git has no gc).
 */
const AUTO_COMPACT_MIN_PRUNED = 20;
/**
 * Skip auto-compaction for mods still carrying a large grandfathered
 * backlog — rewriting hundreds of kept saves to reclaim a handful of capped
 * ones isn't worth the churn. Those mods get compacted when the user runs
 * the Storage cleanup (which also trims the backlog first).
 */
const AUTO_COMPACT_MAX_SAVES = 60;

/**
 * One save in a mod's history. Pinned by sha — every save commits BOTH the
 * mod folder and the mod's chat slice (conversations + which one was
 * active) into the bare repo's worktree, so a restore brings back the
 * complete world: files, chat list, and the active chat. Saves are not
 * anchored to a single conversation; they are the entire mod state.
 */
export interface ChangeStats {
  added: number;
  modified: number;
  deleted: number;
}

export interface SaveRecord {
  sha: string;
  /** ms-since-epoch when the save was committed. */
  timestamp: number;
  /** User-supplied label; null for unnamed auto-saves. */
  label: string | null;
  kind: SaveKind;
  /**
   * Snippet of the assistant's last text reply for this turn. Lets the
   * saves list show what an unnamed auto-save was *about* without making
   * the user click in. Empty for tool-only turns and for manual saves
   * (which already have a user-supplied label).
   */
  preview?: string;
  /**
   * File-level changes inside the mod folder since the previous save.
   * Undefined for the first save (no parent) and for relabel-only manual
   * saves where no new commit was made.
   */
  changes?: ChangeStats;
  /**
   * Save predates the autosave cap (stamped by migrateCapMarkers on the
   * first write after updating). Grandfathered: exempt from the forward
   * cap, only prunable via the explicit Storage cleanup.
   */
  preCap?: boolean;
}

type IndexFile = SnapshotIndexFile;

/**
 * Bumped from 1 → 2 when SaveRecord lost conversationId/entryId and the
 * worktree moved from the mod folder to a state/ subdir. v1 indices are
 * unreadable; we wipe the whole snapshots/&lt;mod&gt;/ dir on first
 * ensureRepo and start fresh.
 */
const FILE_VERSION = 2;

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

// =========================================================================
// Paths
// =========================================================================

function snapshotsRoot(): string {
  return path.join(app.getPath('userData'), 'snapshots');
}

function modSnapshotDir(folder: string): string {
  return path.join(snapshotsRoot(), folder);
}

function bareRepoPath(folder: string): string {
  return path.join(modSnapshotDir(folder), 'repo.git');
}

function statePath(folder: string): string {
  return path.join(modSnapshotDir(folder), 'state');
}

function stateModPath(folder: string): string {
  return path.join(statePath(folder), 'mod');
}

function stateChatsPath(folder: string): string {
  return path.join(statePath(folder), 'chats');
}

function stateChatsIndexPath(folder: string): string {
  return path.join(stateChatsPath(folder), 'conversations.json');
}

function indexPath(folder: string): string {
  return path.join(modSnapshotDir(folder), 'index.json');
}

/**
 * Mirrors getWorkspacePaths().workspaceDir without importing workspace.ts —
 * keeps this module dependency-free of the asset/about machinery.
 */
function modWorkspacePath(folder: string): string {
  return path.join(app.getPath('userData'), 'workspace', 'Mods', folder);
}

/**
 * Build cruft + OS noise excluded from the snapshot. .modmixer is NOT in
 * this list — the schematic sidecar is part of "the world" the user
 * expects to roll back. The Steam-publish exclude list (in workshop.ts) is
 * a separate concern.
 *
 * Filtering happens during syncModIntoState (we just don't copy these into
 * state/), so isomorphic-git never sees them — no .gitignore needed.
 */
const EXCLUDE_BASENAMES = new Set<string>([
  '.git',
  '.DS_Store',
  '.vs',
  'bin',
  'obj',
  'node_modules',
  // Live-session build products (hot assemblies + one-shot scratch builds).
  // Versioned per-iteration DLLs, useless to roll back and big.
  '.live',
  // Gradle/IDE cruft in Minecraft mods. The MDK's shipped .gitignore kept
  // these out of the repo, but they were still copied into state/ every
  // turn — build/ + run/ alone were ~95% of a Minecraft mod's snapshot dir.
  '.gradle',
  'build',
  'run',
  '.idea',
  'out',
]);

// =========================================================================
// Per-mod serialization
// =========================================================================

/**
 * Commits, restores, manifest edits, and compaction for one mod must never
 * interleave — compaction swaps repo.git out from under the others. Chained
 * promises per folder; errors don't poison the queue.
 */
const folderLocks = new Map<string, Promise<unknown>>();

async function withFolderLock<T>(
  folder: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = folderLocks.get(folder) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  const gate = next.catch(() => undefined);
  folderLocks.set(folder, gate);
  try {
    return await next;
  } finally {
    // Only clear if no later op chained on after us.
    if (folderLocks.get(folder) === gate) folderLocks.delete(folder);
  }
}

// =========================================================================
// Git (pure-JS via isomorphic-git)
// =========================================================================

const AUTHOR = { name: 'Modmixer', email: 'modmixer@local' };

function repoArgs(folder: string) {
  return { fs, dir: statePath(folder), gitdir: bareRepoPath(folder) };
}

async function currentHeadSha(folder: string): Promise<string | null> {
  try {
    const sha = await gitResolveRef({
      fs,
      gitdir: bareRepoPath(folder),
      ref: 'HEAD',
    });
    return sha || null;
  } catch {
    // Fresh repo with no commits yet — HEAD points at an unborn branch.
    return null;
  }
}

/**
 * `git status --porcelain` equivalent: are there any changes between the
 * HEAD tree, the index, and the worktree? statusMatrix returns
 * [filepath, head, workdir, stage] with 1 meaning "matches HEAD" / present.
 * Anything not all-1s means dirty.
 */
async function workingTreeIsClean(folder: string): Promise<boolean> {
  try {
    const matrix = await gitStatusMatrix(repoArgs(folder));
    for (const [, head, workdir, stage] of matrix) {
      if (head !== 1 || workdir !== 1 || stage !== 1) return false;
    }
    return true;
  } catch {
    return true;
  }
}

/**
 * Is `candidate` reachable from `head` (or the same commit)?
 * isomorphic-git's isDescendent is strict — same-sha returns false — so
 * handle equality up front.
 */
async function isAncestor(
  folder: string,
  candidate: string,
  head: string,
): Promise<boolean> {
  if (candidate === head) return true;
  try {
    return await gitIsDescendent({
      fs,
      gitdir: bareRepoPath(folder),
      oid: head,
      ancestor: candidate,
    });
  } catch {
    return false;
  }
}

/**
 * Lazy-init the repo + state/ worktree. The repo lives at repo.git/ and
 * the worktree at state/ — same split as the original `git --git-dir / --work-tree`
 * setup, just expressed via isomorphic-git's `dir` + `gitdir` args on every
 * call.
 *
 * A missing state/ used to be read as "v1 layout → wipe everything", which
 * made deleting the (fully derived) state/ dir silently destroy a mod's
 * history. v1 is now detected by its manifest instead: a v2 index.json next
 * to the repo means the layout is current and state/ is simply recreated.
 * Only a repo with no v2 manifest gets the legacy wipe.
 */
async function ensureRepo(folder: string): Promise<void> {
  const dir = modSnapshotDir(folder);
  const repo = bareRepoPath(folder);
  const state = statePath(folder);
  // Finish or undo any compaction swap that died mid-flight before anything
  // reads repo.git.
  await recoverInterruptedCompaction(dir);
  const repoExists = fs.existsSync(repo);
  const stateExists = fs.existsSync(state);
  if (repoExists && !stateExists && !(await indexFileIsV2(folder))) {
    // v1 layout — wipe and re-init on the new schema.
    await fsp.rm(dir, { recursive: true, force: true });
  }
  if (!fs.existsSync(repo)) {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.mkdir(state, { recursive: true });
    await gitInit({ fs, dir: state, gitdir: repo, defaultBranch: 'main' });
  } else if (!fs.existsSync(state)) {
    await fsp.mkdir(state, { recursive: true });
  }
}

/** Raw v2-manifest sniff — readIndex() can't be used here because it maps
 * every failure to an empty v2 shell, which is exactly the wrong answer for
 * layout detection. */
async function indexFileIsV2(folder: string): Promise<boolean> {
  try {
    const raw = await fsp.readFile(indexPath(folder), 'utf8');
    return (JSON.parse(raw) as { version?: unknown }).version === FILE_VERSION;
  } catch {
    return false;
  }
}

// =========================================================================
// Index (saves manifest)
// =========================================================================

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

// =========================================================================
// Worktree sync (workspace + chats → state/)
// =========================================================================

/**
 * Make state/mod/ match the current workspace mod folder, dropping build
 * cruft. Wipe-and-copy semantics — extras left in state/mod/ from an
 * earlier commit are removed.
 */
async function syncModIntoState(folder: string): Promise<void> {
  const stateMod = stateModPath(folder);
  const workspaceMod = modWorkspacePath(folder);
  await fsp.rm(stateMod, { recursive: true, force: true });
  await fsp.mkdir(stateMod, { recursive: true });
  if (!fs.existsSync(workspaceMod)) return;
  await fsp.cp(workspaceMod, stateMod, {
    recursive: true,
    filter: (source) => !EXCLUDE_BASENAMES.has(path.basename(source)),
  });
}

/**
 * Snapshot the mod's chat slice into state/chats/. Each conversation's
 * session JSONL is copied to state/chats/&lt;convoId&gt;.jsonl; the slice
 * itself (Conversation entries + activeId) lands in
 * state/chats/conversations.json.
 *
 * We rename to &lt;id&gt;.jsonl rather than preserving pi's
 * &lt;timestamp&gt;_&lt;uuid&gt;.jsonl name so the snapshot key is stable
 * (same content → same path under git, deduping across saves).
 */
async function syncChatsIntoState(folder: string): Promise<void> {
  const chatsDir = stateChatsPath(folder);
  await fsp.rm(chatsDir, { recursive: true, force: true });
  await fsp.mkdir(chatsDir, { recursive: true });
  const slice = getModConversationsSlice(folder);
  for (const c of slice.conversations) {
    if (!c.sessionFile || !fs.existsSync(c.sessionFile)) continue;
    const dest = path.join(chatsDir, `${c.id}.jsonl`);
    await fsp.copyFile(c.sessionFile, dest);
  }
  await fsp.writeFile(
    stateChatsIndexPath(folder),
    JSON.stringify(slice, null, 2),
    'utf8',
  );
}

/**
 * Stage every change in state/ into the index: add new/modified files,
 * remove deleted ones. isomorphic-git has no `add -A`, so we drive it off
 * statusMatrix. Rows where workdir!=0 → file is present, add it; rows
 * where workdir==0 → file gone, remove it.
 */
async function stageAllChanges(folder: string): Promise<void> {
  const args = repoArgs(folder);
  const matrix = await gitStatusMatrix(args);
  for (const [filepath, , workdir, stage] of matrix) {
    if (workdir === 0) {
      if (stage !== 0) {
        await gitRemove({ ...args, filepath });
      }
    } else {
      await gitAdd({ ...args, filepath });
    }
  }
}

// =========================================================================
// Worktree restore (state/ → workspace + chats + global index)
// =========================================================================

/**
 * Replace the workspace mod folder with state/mod/. The current folder is
 * wiped first so files added after the snapshot vanish — restore is a
 * winding-back, not a merge.
 */
async function restoreModFromState(folder: string): Promise<void> {
  const stateMod = stateModPath(folder);
  const workspaceMod = modWorkspacePath(folder);
  await fsp.rm(workspaceMod, { recursive: true, force: true });
  await fsp.mkdir(workspaceMod, { recursive: true });
  if (!fs.existsSync(stateMod)) return;
  await fsp.cp(stateMod, workspaceMod, { recursive: true });
}

/**
 * Apply state/chats/ back to pi's sessions dir + the global
 * conversations.json. Mod-scoped chats present in the live index but not
 * in the snapshot are deleted (their session files are unlinked); chats in
 * the snapshot are written to the absolute path stored in their entry's
 * `sessionFile` field. activeByMod[folder] is set from the snapshot.
 *
 * Caller is responsible for disposing any active session for this mod
 * before invoking this — pi may be holding session files open.
 */
async function restoreChatsFromState(folder: string): Promise<void> {
  const chatsDir = stateChatsPath(folder);
  let slice: ModConversationsSlice;
  try {
    const raw = await fsp.readFile(stateChatsIndexPath(folder), 'utf8');
    slice = JSON.parse(raw) as ModConversationsSlice;
  } catch {
    // No chat slice in this snapshot — treat as "no chats for this mod."
    slice = { conversations: [], activeId: null };
  }
  const snapshotIds = new Set(slice.conversations.map((c) => c.id));

  // Delete session files for chats that won't survive the restore.
  const currentSlice = getModConversationsSlice(folder);
  for (const c of currentSlice.conversations) {
    if (snapshotIds.has(c.id)) continue;
    if (c.sessionFile && fs.existsSync(c.sessionFile)) {
      try {
        await fsp.unlink(c.sessionFile);
      } catch (err) {
        console.warn('[snapshots] failed to unlink stale session file:', err);
      }
    }
  }

  // Write snapshot session files back to their canonical absolute paths.
  for (const c of slice.conversations) {
    const src = path.join(chatsDir, `${c.id}.jsonl`);
    if (!fs.existsSync(src)) continue;
    if (!c.sessionFile) continue;
    await fsp.mkdir(path.dirname(c.sessionFile), { recursive: true });
    await fsp.copyFile(src, c.sessionFile);
  }

  replaceModConversationsSlice(folder, slice);
}

// =========================================================================
// Public API
// =========================================================================

export interface CommitOpts {
  /** Manual saves get this; auto-saves leave it null. */
  label?: string;
  kind?: SaveKind;
  /**
   * Optional snippet of the agent's last reply, surfaced in the saves list
   * for unnamed auto-saves. Caller is responsible for trimming + length-
   * capping; we just store it.
   */
  preview?: string;
  /**
   * Force a new commit + manifest entry even when the working tree is
   * clean. Used to mark meaningful events (e.g. a successful Steam
   * publish) so they appear as their own row in History rather than
   * silently relabeling the previous save's row.
   */
  force?: boolean;
}

/**
 * Tally added/modified/deleted file counts inside the mod folder between
 * two shas. Renames are bucketed as "modified" — they're really one file
 * moving, not a delete + add. Returns null if the walk fails (e.g. shas
 * are bogus); the caller treats that as "no stats available."
 *
 * `fromSha` of null means "first commit, diff against the empty tree" —
 * everything in `toSha` is added. We special-case that path because
 * isomorphic-git's TREE walker can't bind to git's empty-tree sentinel.
 */
async function computeChangeStats(
  folder: string,
  fromSha: string | null,
  toSha: string,
): Promise<ChangeStats | null> {
  try {
    const args = { fs, gitdir: bareRepoPath(folder) };
    const trees = fromSha
      ? [TREE({ ref: fromSha }), TREE({ ref: toSha })]
      : [TREE({ ref: toSha })];

    let added = 0;
    let modified = 0;
    let deleted = 0;

    await gitWalk({
      ...args,
      trees,
      map: async (filepath, entries): Promise<undefined> => {
        if (filepath === '.') return;
        // Restrict to mod/ subtree (skip chats/, conversations.json, etc.).
        if (!filepath.startsWith('mod/') && filepath !== 'mod') return;
        if (filepath === 'mod') return;

        const list = (entries ?? []) as (WalkerEntry | null)[];

        if (fromSha) {
          const [a, b] = list;
          const aType = a ? await a.type() : null;
          const bType = b ? await b.type() : null;
          // Skip directory entries; we count blobs only.
          if (aType === 'tree' || bType === 'tree') return;
          if (!a && b) added++;
          else if (a && !b) deleted++;
          else if (a && b) {
            const aOid = await a.oid();
            const bOid = await b.oid();
            if (aOid !== bOid) modified++;
          }
        } else {
          const [b] = list;
          if (!b) return;
          const bType = await b.type();
          if (bType === 'tree') return;
          added++;
        }
      },
    });
    return { added, modified, deleted };
  } catch {
    return null;
  }
}

/**
 * Snapshot the mod's full state (folder + chats + active chat). Returns null
 * when nothing has changed since the last commit AND the caller didn't
 * supply a label to apply — keeps the saves list tidy.
 *
 * For manual saves on a clean tree, the existing HEAD record is relabeled
 * (or a fresh record minted if HEAD has none) instead of producing an
 * empty commit.
 */
export async function commitTurn(
  folder: string,
  opts: CommitOpts = {},
): Promise<SaveRecord | null> {
  return withFolderLock(folder, () => commitTurnLocked(folder, opts));
}

async function commitTurnLocked(
  folder: string,
  opts: CommitOpts,
): Promise<SaveRecord | null> {
  if (!fs.existsSync(modWorkspacePath(folder))) return null;
  await ensureRepo(folder);
  try {
    await syncModIntoState(folder);
    await syncChatsIntoState(folder);
    await stageAllChanges(folder);

    const headBefore = await currentHeadSha(folder);
    const clean = headBefore !== null && (await workingTreeIsClean(folder));

    if (clean && !opts.force) {
      if (opts.kind !== 'manual') return null;
      const idx = await readIndex(folder);
      migrateCapMarkers(idx, Date.now());
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
      };
      idx.saves.unshift(record);
      await writeIndex(folder, idx);
      events.emit('changed', { folder, saves: idx.saves });
      return record;
    }

    const message =
      opts.label?.trim() || (opts.kind === 'manual' ? 'manual save' : 'auto save');
    const sha = await gitCommit({
      ...repoArgs(folder),
      message,
      author: AUTHOR,
    });
    if (!sha) return null;
    // Diff against the parent commit (headBefore) to surface "what changed
    // in the mod folder since last save" in the UI. The first commit has no
    // parent, so we pass null and the walk reports every blob as added.
    const changes =
      (await computeChangeStats(folder, headBefore, sha)) ?? undefined;
    const record: SaveRecord = {
      sha,
      timestamp: Date.now(),
      label: opts.label?.trim() || null,
      kind: opts.kind ?? 'auto',
      preview: opts.preview?.trim() || undefined,
      changes,
    };
    const idx = await readIndex(folder);
    // First write since the cap shipped stamps every pre-existing save as
    // grandfathered — the forward cap below only ever prunes saves created
    // after this boundary. Existing history is never trimmed without the
    // user running the Storage cleanup.
    migrateCapMarkers(idx, Date.now());
    idx.saves.unshift(record);
    const { kept, droppedCount } = selectSavesToKeep(idx.saves, {
      keepAutos: KEEP_AUTOSAVES,
      includePreCap: false,
    });
    if (droppedCount > 0) {
      idx.saves = kept;
      idx.prunedSinceCompact =
        (idx.prunedSinceCompact ?? 0) + droppedCount;
    }
    await writeIndex(folder, idx);
    events.emit('changed', { folder, saves: idx.saves });
    maybeScheduleAutoCompact(folder, idx);
    return record;
  } finally {
    await pruneStateWorktree(folder);
  }
}

/**
 * Drop state/'s contents after a commit or restore. state/ is fully derived
 * — wiped and rebuilt from the workspace + chat sessions at the start of
 * every commit — so keeping it populated between turns costs a full copy of
 * the mod plus every chat JSONL per mod for nothing. The dir itself stays
 * (ensureRepo uses its presence in layout checks).
 */
async function pruneStateWorktree(folder: string): Promise<void> {
  try {
    await fsp.rm(stateModPath(folder), { recursive: true, force: true });
    await fsp.rm(stateChatsPath(folder), { recursive: true, force: true });
  } catch (err) {
    console.warn('[snapshots] failed to prune state worktree:', err);
  }
}

/** Folders with an auto-compaction already queued behind the current op. */
const autoCompactQueued = new Set<string>();

function maybeScheduleAutoCompact(folder: string, idx: IndexFile): void {
  if ((idx.prunedSinceCompact ?? 0) < AUTO_COMPACT_MIN_PRUNED) return;
  if (idx.saves.length > AUTO_COMPACT_MAX_SAVES) return;
  if (autoCompactQueued.has(folder)) return;
  autoCompactQueued.add(folder);
  // Chains onto the folder lock, so it runs after the commit that
  // scheduled it releases — never concurrently with a commit or restore.
  void withFolderLock(folder, () => compactLocked(folder))
    .catch((err) =>
      console.error('[snapshots] auto-compaction failed:', err),
    )
    .finally(() => autoCompactQueued.delete(folder));
}

/** Rewrite the repo to only the manifest's saves. Caller holds the lock. */
async function compactLocked(folder: string): Promise<number> {
  await ensureRepo(folder);
  const result = await compactSnapshotDir(modSnapshotDir(folder));
  await pruneStateWorktree(folder);
  if (result) events.emit('changed', { folder, saves: result.saves });
  return result?.freedBytes ?? 0;
}

/**
 * The user-consented Storage cleanup: trim the manifest down to manual +
 * labeled saves plus the KEEP_AUTOSAVES newest autosaves (grandfathered
 * ones included this time — that's the consent), then compact the repo to
 * actually free the bytes.
 */
export async function cleanupModHistory(
  folder: string,
): Promise<{ freedBytes: number }> {
  return withFolderLock(folder, async () => {
    await ensureRepo(folder);
    const idx = await readIndex(folder);
    migrateCapMarkers(idx, Date.now());
    const { kept } = selectSavesToKeep(idx.saves, {
      keepAutos: KEEP_AUTOSAVES,
      includePreCap: true,
    });
    idx.saves = kept;
    await writeIndex(folder, idx);
    const freedBytes = await compactLocked(folder);
    return { freedBytes };
  });
}

export interface RestoreResult {
  /** Snapshot's active chat after restore, or null if the snapshot had nothing active. */
  activeConversation: Conversation | null;
}

/**
 * Wind the mod back to a saved sha: restore the mod folder AND replay the
 * snapshotted chat list back into pi's sessions dir + the global index.
 * Returns the conversation that should be active after restore (caller's
 * job to reconstruct the AgentSession around it).
 *
 * Caller MUST dispose any active session for this mod before calling — we
 * touch session JSONL files that pi may otherwise be writing to.
 */
export async function restoreSnapshot(
  folder: string,
  sha: string,
): Promise<RestoreResult> {
  return withFolderLock(folder, () => restoreSnapshotLocked(folder, sha));
}

async function restoreSnapshotLocked(
  folder: string,
  sha: string,
): Promise<RestoreResult> {
  await ensureRepo(folder);
  // Wipe the worktree before checkout. isomorphic-git's checkout overwrites
  // tracked files but doesn't always remove untracked ones, and it can
  // refuse to overwrite paths whose type changed (e.g. file → directory).
  // Starting from an empty worktree sidesteps both — the bare repo objects
  // contain everything we need, and the next commit will repopulate state/
  // wholesale anyway.
  const state = statePath(folder);
  await fsp.rm(state, { recursive: true, force: true });
  await fsp.mkdir(state, { recursive: true });
  await gitCheckout({
    ...repoArgs(folder),
    ref: sha,
    force: true,
  });
  // Sync canonical locations from the freshly-checked-out state/.
  await restoreModFromState(folder);
  await restoreChatsFromState(folder);
  // conversations.json was rewritten on disk via replaceModConversationsSlice;
  // drop the in-memory cache so the next read picks up the new state.
  reloadConversations();
  // Prune manifest entries whose commits are no longer reachable from HEAD.
  // After restoring to an earlier sha, any saves that came after live on
  // an abandoned branch — keeping them in the list would be misleading
  // (their git objects survive only until the next gc). Their entries get
  // dropped here so the History panel reflects the live timeline.
  await pruneUnreachableSaves(folder, sha);
  await pruneStateWorktree(folder);
  const slice = getModConversationsSlice(folder);
  const active =
    (slice.activeId &&
      slice.conversations.find((c) => c.id === slice.activeId)) ||
    null;
  return { activeConversation: active };
}

/**
 * Drop manifest entries whose sha isn't an ancestor of (or equal to) the
 * given head. Called from restoreSnapshot after the checkout. Emits a
 * 'changed' event when anything was actually removed so the renderer's
 * History panel updates without a refresh round-trip.
 */
async function pruneUnreachableSaves(
  folder: string,
  head: string,
): Promise<void> {
  const idx = await readIndex(folder);
  const kept: SaveRecord[] = [];
  for (const save of idx.saves) {
    if (await isAncestor(folder, save.sha, head)) {
      kept.push(save);
    }
  }
  if (kept.length === idx.saves.length) return;
  idx.saves = kept;
  await writeIndex(folder, idx);
  events.emit('changed', { folder, saves: idx.saves });
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
  return withFolderLock(folder, async () => {
    const idx = await readIndex(folder);
    const save = idx.saves.find((s) => s.sha === sha);
    if (!save) return null;
    const trimmed = label?.trim() || null;
    save.label = trimmed;
    if (trimmed) save.kind = 'manual';
    await writeIndex(folder, idx);
    events.emit('changed', { folder, saves: idx.saves });
    return save;
  });
}

export async function deleteSave(folder: string, sha: string): Promise<void> {
  return withFolderLock(folder, async () => {
    const idx = await readIndex(folder);
    const before = idx.saves.length;
    idx.saves = idx.saves.filter((s) => s.sha !== sha);
    if (idx.saves.length === before) return;
    await writeIndex(folder, idx);
    events.emit('changed', { folder, saves: idx.saves });
    // Git objects stay in the bare repo until the next compaction
    // (auto-triggered by the forward cap, or the Storage cleanup) rewrites
    // it. Cheap; not worth compacting eagerly for one row.
  });
}

/**
 * Nuke the entire snapshots directory for a mod. Called from delete-mod and
 * from the Storage cleanup for orphaned snapshot dirs. Returns the bytes
 * that were on disk so cleanup can report what it freed.
 */
export async function deleteAllSaves(folder: string): Promise<number> {
  return withFolderLock(folder, async () => {
    const dir = modSnapshotDir(folder);
    const bytes = await dirSizeBytes(dir);
    await fsp.rm(dir, { recursive: true, force: true });
    return bytes;
  });
}

// =========================================================================
// Storage usage
// =========================================================================

export interface SnapshotUsageRow {
  folder: string;
  /** Total on-disk bytes of snapshots/<folder>/ (repo + state + manifest). */
  bytes: number;
  saveCount: number;
  manualCount: number;
  /** Rows the Storage cleanup would drop (autosaves beyond the cap). */
  trimmableCount: number;
}

/** Usage row joined with workspace identity (done in the route layer). */
export interface SnapshotUsageModRow extends SnapshotUsageRow {
  /** Mod display name; falls back to the folder for orphans. */
  name: string;
  /** True when no workspace mod exists for this snapshot dir anymore. */
  orphaned: boolean;
}

export interface SnapshotUsageReport {
  rows: SnapshotUsageModRow[];
  totalBytes: number;
  /** Retention constant, surfaced so UI copy can quote the real number. */
  keepAutosaves: number;
}

export interface SnapshotCleanupProgressEvent {
  folder: string;
  status: 'working' | 'done' | 'error';
  freedBytes?: number;
  error?: string;
}

export interface SnapshotCleanupSummary {
  freedBytes: number;
  failures: number;
}

/**
 * Walk every per-mod snapshot dir and measure it. Read-only; sizes are a
 * point-in-time estimate (an agent turn mid-walk skews a row, harmlessly).
 */
export async function snapshotUsage(): Promise<{
  rows: SnapshotUsageRow[];
  totalBytes: number;
}> {
  let entries: fs.Dirent[] = [];
  try {
    entries = await fsp.readdir(snapshotsRoot(), { withFileTypes: true });
  } catch {
    return { rows: [], totalBytes: 0 };
  }
  const rows: SnapshotUsageRow[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const folder = entry.name;
    const bytes = await dirSizeBytes(modSnapshotDir(folder));
    const idx = await readIndex(folder);
    const { droppedCount } = selectSavesToKeep(idx.saves, {
      keepAutos: KEEP_AUTOSAVES,
      includePreCap: true,
    });
    rows.push({
      folder,
      bytes,
      saveCount: idx.saves.length,
      manualCount: idx.saves.filter((s) => s.kind === 'manual').length,
      trimmableCount: droppedCount,
    });
  }
  rows.sort((a, b) => b.bytes - a.bytes);
  return { rows, totalBytes: rows.reduce((sum, r) => sum + r.bytes, 0) };
}
