import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import {
  add as gitAdd,
  commit as gitCommit,
  init as gitInit,
  readBlob as gitReadBlob,
  remove as gitRemove,
  statusMatrix as gitStatusMatrix,
  walk as gitWalk,
  TREE,
  type WalkerEntry,
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

const AUTHOR = { name: 'Modmixer', email: 'modmixer@local' };

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
 * Write a save's tree into `work/` by reading blobs straight out of the
 * repo's object store. Deliberately NOT a checkout: isomorphic-git's
 * checkout rewrites the gitdir's HEAD and index, and this repo must stay
 * byte-identical in case the compaction is rolled back.
 */
async function materializeTree(
  gitdir: string,
  sha: string,
  work: string,
): Promise<void> {
  await gitWalk({
    fs,
    gitdir,
    trees: [TREE({ ref: sha })],
    map: async (filepath, entries): Promise<undefined> => {
      if (filepath === '.') return;
      const [entry] = (entries ?? []) as (WalkerEntry | null)[];
      if (!entry) return;
      const dest = path.join(work, filepath);
      if ((await entry.type()) === 'tree') {
        await fsp.mkdir(dest, { recursive: true });
        return;
      }
      const oid = await entry.oid();
      const { blob } = await gitReadBlob({ fs, gitdir, oid });
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, Buffer.from(blob));
      if ((await entry.mode()) === 0o100755) {
        await fsp.chmod(dest, 0o755);
      }
    },
  });
}

async function stageAll(work: string, gitdir: string): Promise<void> {
  const args = { fs, dir: work, gitdir };
  const matrix = await gitStatusMatrix(args);
  for (const [filepath, , workdir, stage] of matrix) {
    if (workdir === 0) {
      if (stage !== 0) await gitRemove({ ...args, filepath });
    } else {
      await gitAdd({ ...args, filepath });
    }
  }
}

/**
 * Rewrite `dir`'s repo.git so it contains exactly the saves listed in
 * index.json, freeing every unreachable object. Crash-safe: the new repo is
 * fully built under compact.tmp/ before an atomic-rename swap, and
 * recoverInterruptedCompaction can finish or undo a swap that died halfway.
 *
 * Kept saves are re-committed oldest→newest into a fresh linear history
 * (original commit timestamps preserved), and index.json is rewritten with
 * the remapped shas. If the pre-compaction HEAD's save row was deleted from
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
  const work = path.join(tmp, 'work');
  await fsp.rm(tmp, { recursive: true, force: true });
  await fsp.mkdir(work, { recursive: true });
  await gitInit({ fs, dir: work, gitdir: tmpRepo, defaultBranch: 'main' });

  // Manifest is newest-first; commit oldest-first so parents chain forward.
  const ordered = [...idx.saves].reverse();
  const shaMap = new Map<string, string>();
  for (const rec of ordered) {
    await fsp.rm(work, { recursive: true, force: true });
    await fsp.mkdir(work, { recursive: true });
    await materializeTree(repo, rec.sha, work);
    await stageAll(work, tmpRepo);
    const signature = {
      ...AUTHOR,
      timestamp: Math.floor(rec.timestamp / 1000),
      timezoneOffset: 0,
    };
    const newSha = await gitCommit({
      fs,
      dir: work,
      gitdir: tmpRepo,
      message:
        rec.label?.trim() ||
        (rec.kind === 'manual' ? 'manual save' : 'auto save'),
      author: signature,
      committer: signature,
    });
    shaMap.set(rec.sha, newSha);
  }

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
  // The staging worktree is dead weight from here on; drop it before the
  // swap so a roll-forward recovery never resurrects it.
  await fsp.rm(work, { recursive: true, force: true });

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
