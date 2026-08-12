import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import {
  init as gitInit,
  readCommit as gitReadCommit,
  readObject as gitReadObject,
  readTree as gitReadTree,
  writeCommit as gitWriteCommit,
  writeObject as gitWriteObject,
  writeRef as gitWriteRef,
} from 'isomorphic-git';
import type { SaveRecord } from './snapshots.js';

/**
 * Snapshot history compaction — the mechanism that actually frees disk.
 *
 * isomorphic-git only ever writes loose objects and has no gc, so dropping
 * a row from index.json frees nothing. Compaction rewrites the repo from
 * scratch: every save still in the manifest is materialized and re-committed
 * into a fresh repo.git, then the new repo is swapped in and the old one
 * (holding every unreachable blob — for RimWorld mods that's dominated by
 * per-turn chat-JSONL copies) is deleted.
 *
 * This module is deliberately free of electron imports so the node:test
 * suite can exercise it directly against scratch directories. snapshots.ts
 * owns folder→directory resolution, locking, and event emission.
 */

/** Old repo parked here during the swap; its presence marks an in-flight swap. */
const OLD_REPO_NAME = 'repo.old.git';
/** Staging area for the rewritten repo + manifest. Discardable at any point. */
const TMP_NAME = 'compact.tmp';

/** Mirror of snapshots.ts's IndexFile — shared shape, structurally typed. */
export interface SnapshotIndexFile {
  version: 2;
  saves: SaveRecord[];
  /**
   * ms-since-epoch when the autosave cap first saw this mod. Saves that
   * predate the cap feature carry preCap and are exempt from automatic
   * pruning — see selectSavesToKeep.
   */
  capEpoch?: number;
  /**
   * Manifest rows dropped by the forward cap since the last compaction.
   * When it crosses a threshold the repo is worth rewriting.
   */
  prunedSinceCompact?: number;
}

export interface CompactResult {
  freedBytes: number;
  saves: SaveRecord[];
}

export interface RetentionResult {
  kept: SaveRecord[];
  droppedCount: number;
}

/**
 * Retention policy in one place. Keeps, unconditionally:
 *   - every manual save (a label marks intent — never auto-pruned)
 *   - every pre-cap save unless includePreCap (the user-consented cleanup
 *     path) says grandfathered history is on the table this run
 * and of the remaining autosaves, the `keepAutos` newest. `saves` is
 * newest-first (manifest order) and order is preserved.
 */
export function selectSavesToKeep(
  saves: SaveRecord[],
  opts: { keepAutos: number; includePreCap: boolean },
): RetentionResult {
  let cappableSeen = 0;
  const kept = saves.filter((s) => {
    if (s.kind === 'manual') return true;
    if (s.preCap && !opts.includePreCap) return true;
    cappableSeen++;
    return cappableSeen <= opts.keepAutos;
  });
  return { kept, droppedCount: saves.length - kept.length };
}

/**
 * Stamp the grandfather markers on a manifest that predates the cap: every
 * existing save becomes preCap and capEpoch records when the boundary was
 * drawn. Idempotent — a manifest with capEpoch set is returned untouched.
 * Returns true when the manifest was modified (caller should persist).
 */
export function migrateCapMarkers(
  idx: SnapshotIndexFile,
  now: number,
): boolean {
  if (idx.capEpoch !== undefined) return false;
  idx.capEpoch = now;
  for (const save of idx.saves) save.preCap = true;
  return true;
}

/** Recursive on-disk size. Missing paths and racing deletes count as zero. */
export async function dirSizeBytes(dir: string): Promise<number> {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await dirSizeBytes(full);
    } else if (entry.isFile()) {
      try {
        total += (await fsp.stat(full)).size;
      } catch {
        // Deleted between readdir and stat — skip.
      }
    }
  }
  return total;
}

/**
 * Clean up after a compaction that died mid-flight. Safe to call any time —
 * it's a no-op when there's nothing to recover. The swap sequence is:
 *
 *   1. rename repo.git      → repo.old.git
 *   2. rename tmp/repo.git  → repo.git
 *   3. rename tmp/index.json → index.json
 *   4. rm repo.old.git + tmp
 *
 * Each rename is atomic, so a crash leaves exactly one of these states:
 *   - tmp only, no repo.old.git  → compaction never reached the swap;
 *     the old repo is untouched. Discard tmp.
 *   - repo.old.git, no repo.git  → died between 1 and 2. Roll back: the
 *     old repo is complete, put it back and discard tmp.
 *   - repo.old.git + repo.git    → repo.git is the new repo (the old one
 *     was parked in step 1). If tmp/index.json still exists we died before
 *     step 3 — finish the swap (roll forward); either way drop the leftovers.
 */
export async function recoverInterruptedCompaction(dir: string): Promise<void> {
  const oldRepo = path.join(dir, OLD_REPO_NAME);
  const repo = path.join(dir, 'repo.git');
  const tmp = path.join(dir, TMP_NAME);
  if (fs.existsSync(oldRepo)) {
    if (!fs.existsSync(repo)) {
      await fsp.rename(oldRepo, repo);
    } else {
      const tmpIndex = path.join(tmp, 'index.json');
      if (fs.existsSync(tmpIndex)) {
        await fsp.rename(tmpIndex, path.join(dir, 'index.json'));
      }
      await fsp.rm(oldRepo, { recursive: true, force: true });
    }
  }
  await fsp.rm(tmp, { recursive: true, force: true });
}

async function readIndexFile(dir: string): Promise<SnapshotIndexFile | null> {
  try {
    const raw = await fsp.readFile(path.join(dir, 'index.json'), 'utf8');
    const parsed = JSON.parse(raw) as SnapshotIndexFile;
    return parsed.version === 2 ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Copy one object from the old repo's store to the new one. Objects are
 * content-addressed, so the loose-object file can be copied byte-for-byte
 * — no inflate/re-hash/deflate. The API-level fallback (for objects that
 * somehow live in a packfile — modmixer never writes packs) re-hashes
 * through readObject/writeObject, which lands on the same oid.
 */
async function copyObject(
  oldRepo: string,
  newRepo: string,
  oid: string,
  seen: Set<string>,
): Promise<void> {
  if (seen.has(oid)) return;
  seen.add(oid);
  const rel = path.join('objects', oid.slice(0, 2), oid.slice(2));
  const src = path.join(oldRepo, rel);
  const dest = path.join(newRepo, rel);
  if (fs.existsSync(src)) {
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    if (!fs.existsSync(dest)) await fsp.copyFile(src, dest);
    return;
  }
  const { object, type } = await gitReadObject({
    fs,
    gitdir: oldRepo,
    oid,
    format: 'content',
  });
  await gitWriteObject({
    fs,
    gitdir: newRepo,
    // format:'content' always yields a real object type, but readObject's
    // union also carries its wire formats — narrow it for writeObject.
    type: type as 'blob' | 'commit' | 'tree' | 'tag',
    object: object as Uint8Array,
    format: 'content',
  });
}

/** Copy a tree and everything reachable from it (subtrees + blobs). */
async function copyTreeObjects(
  oldRepo: string,
  newRepo: string,
  treeOid: string,
  seen: Set<string>,
): Promise<void> {
  if (seen.has(treeOid)) return;
  await copyObject(oldRepo, newRepo, treeOid, seen);
  const { tree } = await gitReadTree({ fs, gitdir: oldRepo, oid: treeOid });
  for (const entry of tree) {
    if (entry.type === 'tree') {
      await copyTreeObjects(oldRepo, newRepo, entry.oid, seen);
    } else if (entry.type === 'blob') {
      await copyObject(oldRepo, newRepo, entry.oid, seen);
    }
    // 'commit' entries are submodule gitlinks — no object to copy.
  }
}

/**
 * Rewrite `dir`'s repo.git so it contains exactly the saves listed in
 * index.json, freeing every unreachable object. Crash-safe: the new repo is
 * fully built under compact.tmp/ before an atomic-rename swap, and
 * recoverInterruptedCompaction can finish or undo a swap that died halfway.
 *
 * Kept saves are rebuilt oldest→newest into a fresh linear history at the
 * object level: trees and blobs are content-addressed, so they're copied
 * into the new store byte-for-byte (no worktree, no re-hashing — this is
 * what keeps compaction fast on slow filesystems), and only the commit
 * objects are rewritten to splice the parent chain. Messages, authors, and
 * timestamps carry over verbatim; index.json is rewritten with the
 * remapped shas. If the pre-compaction HEAD's save row was deleted from
 * the manifest, the new HEAD becomes the newest kept save — the workspace
 * is canonical, so the next auto-save simply diffs against that.
 *
 * Returns null when there's no readable v2 manifest to compact against.
 * The caller is responsible for serializing this with commits/restores.
 */
export async function compactSnapshotDir(
  dir: string,
): Promise<CompactResult | null> {
  await recoverInterruptedCompaction(dir);
  const idx = await readIndexFile(dir);
  if (!idx) return null;
  const repo = path.join(dir, 'repo.git');
  const sizeBefore = await dirSizeBytes(dir);

  if (idx.saves.length === 0) {
    // Nothing to keep — drop the object store wholesale. ensureRepo
    // re-inits a fresh repo on the next commit.
    await fsp.rm(repo, { recursive: true, force: true });
    idx.prunedSinceCompact = 0;
    await fsp.writeFile(
      path.join(dir, 'index.json'),
      JSON.stringify(idx, null, 2),
      'utf8',
    );
    return {
      freedBytes: Math.max(0, sizeBefore - (await dirSizeBytes(dir))),
      saves: [],
    };
  }

  const tmp = path.join(dir, TMP_NAME);
  const tmpRepo = path.join(tmp, 'repo.git');
  await fsp.rm(tmp, { recursive: true, force: true });
  // init wants a worktree dir; tmp/ itself serves — nothing is ever
  // checked out into it. (Not a bare init: the swapped-in repo must carry
  // the same non-bare config the original had, since restores run
  // checkout against it.)
  await fsp.mkdir(tmp, { recursive: true });
  await gitInit({ fs, dir: tmp, gitdir: tmpRepo, defaultBranch: 'main' });

  // Manifest is newest-first; rebuild oldest-first so parents chain
  // forward. `seen` spans saves, so shared objects copy exactly once.
  const ordered = [...idx.saves].reverse();
  const shaMap = new Map<string, string>();
  const seen = new Set<string>();
  let parent: string | null = null;
  for (const rec of ordered) {
    const { commit } = await gitReadCommit({ fs, gitdir: repo, oid: rec.sha });
    await copyTreeObjects(repo, tmpRepo, commit.tree, seen);
    // Drop any signature: it covered the original parent pointer, which is
    // being rewritten. (Modmixer never signs; belt-and-braces.)
    const unsigned = { ...commit };
    delete unsigned.gpgsig;
    const newSha = await gitWriteCommit({
      fs,
      gitdir: tmpRepo,
      commit: { ...unsigned, parent: parent ? [parent] : [] },
    });
    shaMap.set(rec.sha, newSha);
    parent = newSha;
  }
  await gitWriteRef({
    fs,
    gitdir: tmpRepo,
    ref: 'refs/heads/main',
    value: parent as string,
    force: true,
  });

  const newIdx: SnapshotIndexFile = {
    ...idx,
    saves: idx.saves.map((rec) => ({
      ...rec,
      sha: shaMap.get(rec.sha) ?? rec.sha,
    })),
    prunedSinceCompact: 0,
  };
  await fsp.writeFile(
    path.join(tmp, 'index.json'),
    JSON.stringify(newIdx, null, 2),
    'utf8',
  );
  // The swap. See recoverInterruptedCompaction for the crash matrix.
  const oldRepo = path.join(dir, OLD_REPO_NAME);
  await fsp.rename(repo, oldRepo);
  await fsp.rename(tmpRepo, repo);
  await fsp.rename(path.join(tmp, 'index.json'), path.join(dir, 'index.json'));
  await fsp.rm(oldRepo, { recursive: true, force: true });
  await fsp.rm(tmp, { recursive: true, force: true });

  return {
    freedBytes: Math.max(0, sizeBefore - (await dirSizeBytes(dir))),
    saves: newIdx.saves,
  };
}
