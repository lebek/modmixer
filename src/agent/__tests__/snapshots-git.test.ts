import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
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

/**
 * Verifies the isomorphic-git plumbing pattern that snapshots.ts uses:
 * a bare-style gitdir at repo.git/ paired with a separate worktree at
 * state/. Tests the operations whose behavior we don't get for free from
 * the upstream test suite — staging via statusMatrix, force checkout
 * across commits, walk-based name-status diff, and isDescendent edges.
 */

const AUTHOR = { name: 'Modmixer', email: 'modmixer@local' };

async function makeRepo(): Promise<{
  root: string;
  gitdir: string;
  dir: string;
  cleanup: () => Promise<void>;
}> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'modmixer-snap-'));
  const gitdir = path.join(root, 'repo.git');
  const dir = path.join(root, 'state');
  await fsp.mkdir(dir, { recursive: true });
  await gitInit({ fs, dir, gitdir, defaultBranch: 'main' });
  return {
    root,
    gitdir,
    dir,
    cleanup: () => fsp.rm(root, { recursive: true, force: true }),
  };
}

async function stageAll(args: { fs: typeof fs; dir: string; gitdir: string }) {
  const matrix = await gitStatusMatrix(args);
  for (const [filepath, , workdir, stage] of matrix) {
    if (workdir === 0) {
      if (stage !== 0) await gitRemove({ ...args, filepath });
    } else {
      await gitAdd({ ...args, filepath });
    }
  }
}

async function commitWith(
  args: { fs: typeof fs; dir: string; gitdir: string },
  message: string,
): Promise<string> {
  await stageAll(args);
  return gitCommit({ ...args, message, author: AUTHOR });
}

async function nameStatus(
  args: { fs: typeof fs; gitdir: string },
  fromSha: string | null,
  toSha: string,
  pathPrefix: string,
): Promise<{ added: number; modified: number; deleted: number }> {
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
      if (
        !filepath.startsWith(`${pathPrefix}/`) &&
        filepath !== pathPrefix
      )
        return;
      if (filepath === pathPrefix) return;

      const list = (entries ?? []) as (WalkerEntry | null)[];

      if (fromSha) {
        const [a, b] = list;
        const aType = a ? await a.type() : null;
        const bType = b ? await b.type() : null;
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
}

describe('isomorphic-git plumbing for snapshots', () => {
  it('init creates a working bare-style gitdir + worktree split', async () => {
    const { gitdir, cleanup } = await makeRepo();
    try {
      assert.ok(fs.existsSync(path.join(gitdir, 'HEAD')));
      assert.ok(fs.existsSync(path.join(gitdir, 'objects')));
    } finally {
      await cleanup();
    }
  });

  it('first commit succeeds; resolveRef returns its sha', async () => {
    const { dir, gitdir, cleanup } = await makeRepo();
    try {
      await fsp.mkdir(path.join(dir, 'mod'), { recursive: true });
      await fsp.writeFile(path.join(dir, 'mod', 'a.txt'), 'one');
      const sha = await commitWith({ fs, dir, gitdir }, 'first');
      assert.match(sha, /^[0-9a-f]{40}$/);
      const head = await gitResolveRef({ fs, gitdir, ref: 'HEAD' });
      assert.equal(head, sha);
    } finally {
      await cleanup();
    }
  });

  it('statusMatrix detects clean and dirty states', async () => {
    const { dir, gitdir, cleanup } = await makeRepo();
    try {
      await fsp.mkdir(path.join(dir, 'mod'), { recursive: true });
      await fsp.writeFile(path.join(dir, 'mod', 'a.txt'), 'one');
      await commitWith({ fs, dir, gitdir }, 'first');

      let dirty = false;
      let m = await gitStatusMatrix({ fs, dir, gitdir });
      for (const [, h, w, s] of m) if (h !== 1 || w !== 1 || s !== 1) dirty = true;
      assert.equal(dirty, false, 'should be clean right after commit');

      // New file → unambiguously dirty regardless of stat-cache shortcuts.
      // (isomorphic-git's statusMatrix uses a size+mtime fast path; an
      // in-place edit at the same size within the same mtime tick can
      // read as clean. Production never hits that case because
      // syncModIntoState wipes and re-copies, refreshing every stat.)
      await fsp.writeFile(path.join(dir, 'mod', 'b.txt'), 'new file');
      m = await gitStatusMatrix({ fs, dir, gitdir });
      dirty = false;
      for (const [, h, w, s] of m) if (h !== 1 || w !== 1 || s !== 1) dirty = true;
      assert.equal(dirty, true, 'should be dirty after adding a new file');
    } finally {
      await cleanup();
    }
  });

  it('walk diff bins added/modified/deleted under a path prefix', async () => {
    const { dir, gitdir, cleanup } = await makeRepo();
    try {
      await fsp.mkdir(path.join(dir, 'mod'), { recursive: true });
      await fsp.mkdir(path.join(dir, 'chats'), { recursive: true });
      await fsp.writeFile(path.join(dir, 'mod', 'a.txt'), 'one');
      await fsp.writeFile(path.join(dir, 'mod', 'keep.txt'), 'keep');
      await fsp.writeFile(path.join(dir, 'chats', 'log.json'), '{}');
      const first = await commitWith({ fs, dir, gitdir }, 'first');

      // Modify a.txt, add b.txt, delete keep.txt; touch chats/ — chats
      // shouldn't show up under the mod/ prefix.
      await fsp.writeFile(path.join(dir, 'mod', 'a.txt'), 'two');
      await fsp.writeFile(path.join(dir, 'mod', 'b.txt'), 'new');
      await fsp.unlink(path.join(dir, 'mod', 'keep.txt'));
      await fsp.writeFile(path.join(dir, 'chats', 'log.json'), '{"x":1}');
      const second = await commitWith({ fs, dir, gitdir }, 'second');

      const stats = await nameStatus({ fs, gitdir }, first, second, 'mod');
      assert.deepEqual(stats, { added: 1, modified: 1, deleted: 1 });

      // First-commit case: every blob under mod/ counts as added.
      const firstStats = await nameStatus({ fs, gitdir }, null, first, 'mod');
      assert.deepEqual(firstStats, { added: 2, modified: 0, deleted: 0 });
    } finally {
      await cleanup();
    }
  });

  it('isDescendent: false for self, true for ancestor, false for forks', async () => {
    const { dir, gitdir, cleanup } = await makeRepo();
    try {
      await fsp.mkdir(path.join(dir, 'mod'), { recursive: true });
      await fsp.writeFile(path.join(dir, 'mod', 'a.txt'), '1');
      const c1 = await commitWith({ fs, dir, gitdir }, 'c1');
      await fsp.writeFile(path.join(dir, 'mod', 'a.txt'), '2');
      const c2 = await commitWith({ fs, dir, gitdir }, 'c2');

      assert.equal(
        await gitIsDescendent({ fs, gitdir, oid: c2, ancestor: c1 }),
        true,
        'c2 should be a descendent of c1',
      );
      // Same-sha case is the one our wrapper has to short-circuit.
      assert.equal(
        await gitIsDescendent({ fs, gitdir, oid: c1, ancestor: c1 }),
        false,
        'isDescendent is strict — same-sha returns false',
      );
      assert.equal(
        await gitIsDescendent({ fs, gitdir, oid: c1, ancestor: c2 }),
        false,
        'older sha is not a descendent of newer',
      );
    } finally {
      await cleanup();
    }
  });

  it('checkout --force after wiping worktree restores the snapshot tree exactly', async () => {
    const { dir, gitdir, cleanup } = await makeRepo();
    try {
      // c1: just a.txt
      await fsp.mkdir(path.join(dir, 'mod'), { recursive: true });
      await fsp.writeFile(path.join(dir, 'mod', 'a.txt'), 'one');
      const c1 = await commitWith({ fs, dir, gitdir }, 'c1');

      // c2: a.txt modified, b.txt added
      await fsp.writeFile(path.join(dir, 'mod', 'a.txt'), 'two');
      await fsp.writeFile(path.join(dir, 'mod', 'b.txt'), 'new');
      await commitWith({ fs, dir, gitdir }, 'c2');

      // Add an untracked file we expect the rewind to drop.
      await fsp.writeFile(path.join(dir, 'mod', 'untracked.txt'), 'cruft');

      // Wipe the worktree (mirroring what restoreSnapshot does) and
      // checkout c1.
      await fsp.rm(dir, { recursive: true, force: true });
      await fsp.mkdir(dir, { recursive: true });
      await gitCheckout({ fs, dir, gitdir, ref: c1, force: true });

      const aContents = await fsp.readFile(
        path.join(dir, 'mod', 'a.txt'),
        'utf8',
      );
      assert.equal(aContents, 'one');
      assert.equal(
        fs.existsSync(path.join(dir, 'mod', 'b.txt')),
        false,
        'b.txt was added in c2; rewinding past it must drop it',
      );
      assert.equal(
        fs.existsSync(path.join(dir, 'mod', 'untracked.txt')),
        false,
        'untracked file must not survive the wipe-and-checkout',
      );

      const head = await gitResolveRef({ fs, gitdir, ref: 'HEAD' });
      assert.equal(head, c1, 'HEAD should now point at c1');
    } finally {
      await cleanup();
    }
  });
});
