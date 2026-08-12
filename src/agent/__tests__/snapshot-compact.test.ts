import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import {
  add as gitAdd,
  checkout as gitCheckout,
  commit as gitCommit,
  init as gitInit,
  readCommit as gitReadCommit,
  remove as gitRemove,
  resolveRef as gitResolveRef,
  statusMatrix as gitStatusMatrix,
} from 'isomorphic-git';
import {
  compactSnapshotDir,
  dirSizeBytes,
  migrateCapMarkers,
  recoverInterruptedCompaction,
  selectSavesToKeep,
  type SnapshotIndexFile,
} from '../snapshot-compact.js';
import type { SaveRecord } from '../snapshots.js';

const AUTHOR = { name: 'Modmixer', email: 'modmixer@local' };

function save(partial: Partial<SaveRecord> & { sha: string }): SaveRecord {
  return {
    timestamp: 1_700_000_000_000,
    label: null,
    kind: 'auto',
    ...partial,
  };
}

describe('selectSavesToKeep', () => {
  // Manifest order is newest-first throughout.
  const saves: SaveRecord[] = [
    save({ sha: 'a1' }),
    save({ sha: 'a2' }),
    save({ sha: 'm1', kind: 'manual' }),
    save({ sha: 'a3' }),
    save({ sha: 'p1', preCap: true }),
    save({ sha: 'p2', kind: 'manual', preCap: true }),
    save({ sha: 'a4' }),
  ];

  it('caps autosaves, keeps manual + grandfathered, preserves order', () => {
    const { kept, droppedCount } = selectSavesToKeep(saves, {
      keepAutos: 2,
      includePreCap: false,
    });
    // a1, a2 fill the cap; a3 + a4 drop; m1/p1/p2 untouchable.
    assert.deepEqual(
      kept.map((s) => s.sha),
      ['a1', 'a2', 'm1', 'p1', 'p2'],
    );
    assert.equal(droppedCount, 2);
  });

  it('includePreCap makes grandfathered autosaves cappable, never manual', () => {
    const { kept, droppedCount } = selectSavesToKeep(saves, {
      keepAutos: 2,
      includePreCap: true,
    });
    // p1 now counts as a cappable autosave (and is beyond the newest 2);
    // p2 survives on kind alone.
    assert.deepEqual(
      kept.map((s) => s.sha),
      ['a1', 'a2', 'm1', 'p2'],
    );
    assert.equal(droppedCount, 3);
  });

  it('keeps everything when under the cap', () => {
    const { kept, droppedCount } = selectSavesToKeep(saves, {
      keepAutos: 10,
      includePreCap: true,
    });
    assert.equal(kept.length, saves.length);
    assert.equal(droppedCount, 0);
  });
});

describe('migrateCapMarkers', () => {
  it('stamps capEpoch + preCap once, then never again', () => {
    const idx: SnapshotIndexFile = {
      version: 2,
      saves: [save({ sha: 'x' }), save({ sha: 'y', kind: 'manual' })],
    };
    assert.equal(migrateCapMarkers(idx, 123), true);
    assert.equal(idx.capEpoch, 123);
    assert.ok(idx.saves.every((s) => s.preCap === true));

    const later = save({ sha: 'z' });
    idx.saves.unshift(later);
    assert.equal(migrateCapMarkers(idx, 456), false);
    assert.equal(idx.capEpoch, 123);
    assert.equal(later.preCap, undefined);
  });
});

// ---------------------------------------------------------------------------
// compactSnapshotDir — full snapshot-dir lifecycle against scratch repos
// ---------------------------------------------------------------------------

async function makeSnapshotDir(): Promise<{
  dir: string;
  gitdir: string;
  state: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'modmixer-compact-'));
  const gitdir = path.join(dir, 'repo.git');
  const state = path.join(dir, 'state');
  await fsp.mkdir(state, { recursive: true });
  await gitInit({ fs, dir: state, gitdir, defaultBranch: 'main' });
  return {
    dir,
    gitdir,
    state,
    cleanup: () => fsp.rm(dir, { recursive: true, force: true }),
  };
}

async function commitState(
  state: string,
  gitdir: string,
  files: Record<string, string | null>,
  message: string,
): Promise<string> {
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(state, rel);
    if (contents === null) {
      await fsp.rm(full, { force: true });
    } else {
      await fsp.mkdir(path.dirname(full), { recursive: true });
      await fsp.writeFile(full, contents);
    }
  }
  const args = { fs, dir: state, gitdir };
  const matrix = await gitStatusMatrix(args);
  for (const [filepath, , workdir, stage] of matrix) {
    if (workdir === 0) {
      if (stage !== 0) await gitRemove({ ...args, filepath });
    } else {
      await gitAdd({ ...args, filepath });
    }
  }
  return gitCommit({ ...args, message, author: AUTHOR });
}

async function writeManifest(dir: string, idx: SnapshotIndexFile) {
  await fsp.writeFile(
    path.join(dir, 'index.json'),
    JSON.stringify(idx, null, 2),
    'utf8',
  );
}

async function readManifest(dir: string): Promise<SnapshotIndexFile> {
  return JSON.parse(
    await fsp.readFile(path.join(dir, 'index.json'), 'utf8'),
  ) as SnapshotIndexFile;
}

function looseObjectCount(gitdir: string): number {
  const objects = path.join(gitdir, 'objects');
  let count = 0;
  for (const shard of fs.readdirSync(objects)) {
    if (shard === 'info' || shard === 'pack') continue;
    count += fs.readdirSync(path.join(objects, shard)).length;
  }
  return count;
}

describe('compactSnapshotDir', () => {
  it('rewrites the repo to only manifest saves and remaps shas', async () => {
    const { dir, gitdir, state, cleanup } = await makeSnapshotDir();
    try {
      // Five saves; the middle ones carry unique incompressible blobs
      // (loose objects are zlib'd, so repeated chars would reclaim ~nothing)
      // that only a real rewrite can free. c3 also deletes a file from c2.
      const bigOld = crypto.randomBytes(50_000).toString('base64');
      const bigNew = crypto.randomBytes(50_000).toString('base64');
      await commitState(state, gitdir, { 'mod/a.txt': 'one' }, 's1');
      await commitState(
        state,
        gitdir,
        { 'mod/big.bin': bigOld, 'mod/drop.txt': 'bye' },
        's2',
      );
      await commitState(
        state,
        gitdir,
        { 'mod/big.bin': bigNew, 'mod/drop.txt': null },
        's3',
      );
      const c4 = await commitState(
        state,
        gitdir,
        { 'chats/1.jsonl': 'chat'.repeat(10_000) },
        's4',
      );
      const c5 = await commitState(state, gitdir, { 'mod/a.txt': 'five' }, 's5');

      // Keep newest two (c5, c4) + drop c1..c3.
      const ts = 1_700_000_123_000;
      await writeManifest(dir, {
        version: 2,
        saves: [
          save({ sha: c5, timestamp: ts, label: 'newest' }),
          save({ sha: c4, timestamp: ts - 60_000 }),
        ],
        prunedSinceCompact: 21,
      });

      const objectsBefore = looseObjectCount(gitdir);
      const sizeBefore = await dirSizeBytes(dir);
      const origHead = await gitReadCommit({ fs, gitdir, oid: c5 });
      const result = await compactSnapshotDir(dir);
      assert.ok(result, 'compaction should run against a v2 manifest');

      // Bytes actually freed and object store genuinely smaller.
      // The only unique dropped payload is bigOld (~50KB compressed);
      // threshold sits safely below that but far above metadata noise.
      assert.ok(result.freedBytes > 30_000, 'dropped blobs must be reclaimed');
      assert.ok((await dirSizeBytes(dir)) < sizeBefore);
      assert.ok(looseObjectCount(gitdir) < objectsBefore);
      assert.equal(
        fs.existsSync(path.join(dir, 'compact.tmp')),
        false,
        'staging dir must be gone after the swap',
      );
      assert.equal(fs.existsSync(path.join(dir, 'repo.old.git')), false);

      // Manifest rewritten: same rows, new shas, counter reset.
      const idx = await readManifest(dir);
      assert.equal(idx.saves.length, 2);
      assert.equal(idx.prunedSinceCompact, 0);
      assert.equal(idx.saves[0].label, 'newest');
      assert.notEqual(idx.saves[0].sha, c5);
      assert.notEqual(idx.saves[1].sha, c4);

      // New HEAD = newest kept save; parent chain is the older kept save.
      const head = await gitResolveRef({ fs, gitdir, ref: 'HEAD' });
      assert.equal(head, idx.saves[0].sha);
      const headCommit = await gitReadCommit({ fs, gitdir, oid: head });
      assert.deepEqual(headCommit.commit.parent, [idx.saves[1].sha]);
      // Object-level rebuild: message, author, and tree carry over
      // verbatim from the original commit — only the parent is rewritten.
      assert.equal(headCommit.commit.message, origHead.commit.message);
      assert.deepEqual(headCommit.commit.author, origHead.commit.author);
      assert.equal(headCommit.commit.tree, origHead.commit.tree);

      // Content round-trip: the newest save restores byte-identically,
      // including the file c3 deleted staying deleted.
      const work = path.join(dir, 'verify');
      await fsp.mkdir(work);
      await gitCheckout({
        fs,
        dir: work,
        gitdir,
        ref: idx.saves[0].sha,
        force: true,
      });
      assert.equal(await fsp.readFile(path.join(work, 'mod/a.txt'), 'utf8'), 'five');
      assert.equal(
        await fsp.readFile(path.join(work, 'mod/big.bin'), 'utf8'),
        bigNew,
      );
      assert.equal(
        await fsp.readFile(path.join(work, 'chats/1.jsonl'), 'utf8'),
        'chat'.repeat(10_000),
      );
      assert.equal(fs.existsSync(path.join(work, 'mod/drop.txt')), false);
    } finally {
      await cleanup();
    }
  });

  it('empty manifest drops the object store wholesale', async () => {
    const { dir, gitdir, state, cleanup } = await makeSnapshotDir();
    try {
      await commitState(state, gitdir, { 'mod/a.txt': 'gone' }, 's1');
      await writeManifest(dir, { version: 2, saves: [] });
      const result = await compactSnapshotDir(dir);
      assert.ok(result);
      assert.equal(result.saves.length, 0);
      assert.equal(fs.existsSync(gitdir), false);
      assert.equal((await readManifest(dir)).prunedSinceCompact, 0);
    } finally {
      await cleanup();
    }
  });

  it('returns null without touching anything when no v2 manifest exists', async () => {
    const { dir, gitdir, state, cleanup } = await makeSnapshotDir();
    try {
      await commitState(state, gitdir, { 'mod/a.txt': 'kept' }, 's1');
      assert.equal(await compactSnapshotDir(dir), null);
      assert.ok(fs.existsSync(gitdir));
    } finally {
      await cleanup();
    }
  });
});

describe('recoverInterruptedCompaction', () => {
  it('rolls back a swap that died before the new repo landed', async () => {
    const { dir, gitdir, state, cleanup } = await makeSnapshotDir();
    try {
      const sha = await commitState(state, gitdir, { 'mod/a.txt': 'v' }, 's1');
      // Crash state: step 1 done (repo parked), step 2 never happened.
      await fsp.rename(gitdir, path.join(dir, 'repo.old.git'));
      await fsp.mkdir(path.join(dir, 'compact.tmp'), { recursive: true });
      await fsp.writeFile(path.join(dir, 'compact.tmp', 'junk'), 'x');

      await recoverInterruptedCompaction(dir);

      assert.ok(fs.existsSync(gitdir), 'old repo must be restored');
      assert.equal(await gitResolveRef({ fs, gitdir, ref: 'HEAD' }), sha);
      assert.equal(fs.existsSync(path.join(dir, 'repo.old.git')), false);
      assert.equal(fs.existsSync(path.join(dir, 'compact.tmp')), false);
    } finally {
      await cleanup();
    }
  });

  it('rolls forward a swap that died before the manifest swap', async () => {
    const { dir, gitdir, state, cleanup } = await makeSnapshotDir();
    try {
      await commitState(state, gitdir, { 'mod/a.txt': 'v' }, 's1');
      await writeManifest(dir, { version: 2, saves: [save({ sha: 'old' })] });
      // Crash state: new repo already at repo.git (here: the real one),
      // old repo parked, rewritten manifest still in compact.tmp.
      await fsp.mkdir(path.join(dir, 'repo.old.git'), { recursive: true });
      await fsp.writeFile(path.join(dir, 'repo.old.git', 'HEAD'), 'stale');
      await fsp.mkdir(path.join(dir, 'compact.tmp'), { recursive: true });
      await writeManifest(path.join(dir, 'compact.tmp'), {
        version: 2,
        saves: [save({ sha: 'new' })],
      });

      await recoverInterruptedCompaction(dir);

      const idx = await readManifest(dir);
      assert.equal(idx.saves[0].sha, 'new', 'manifest swap must be completed');
      assert.equal(fs.existsSync(path.join(dir, 'repo.old.git')), false);
      assert.equal(fs.existsSync(path.join(dir, 'compact.tmp')), false);
      assert.ok(fs.existsSync(gitdir));
    } finally {
      await cleanup();
    }
  });

  it('discards a staging dir from a compaction that never reached the swap', async () => {
    const { dir, gitdir, state, cleanup } = await makeSnapshotDir();
    try {
      await commitState(state, gitdir, { 'mod/a.txt': 'v' }, 's1');
      await writeManifest(dir, { version: 2, saves: [save({ sha: 'keep' })] });
      await fsp.mkdir(path.join(dir, 'compact.tmp', 'repo.git'), {
        recursive: true,
      });

      await recoverInterruptedCompaction(dir);

      assert.equal(fs.existsSync(path.join(dir, 'compact.tmp')), false);
      assert.ok(fs.existsSync(gitdir));
      assert.equal((await readManifest(dir)).saves[0].sha, 'keep');
    } finally {
      await cleanup();
    }
  });
});
