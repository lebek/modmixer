import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import { assertWriteTargetIsNew } from '../write-overwrite-guard.js';

/**
 * The guarded write tool refuses to overwrite an existing file — the agent
 * should reach for `edit` instead, which only streams the diff. Tests here
 * exercise the resolution rule (cwd-relative + ~ expansion) and the
 * exists/no-exists branch.
 */
describe('assertWriteTargetIsNew', () => {
  it('returns silently for a fresh absolute path', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mm-write-'));
    try {
      assert.doesNotThrow(() =>
        assertWriteTargetIsNew(path.join(dir, 'new.txt'), dir),
      );
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('throws when the absolute path already exists', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mm-write-'));
    const existing = path.join(dir, 'kept.txt');
    try {
      await fsp.writeFile(existing, 'hello');
      assert.throws(
        () => assertWriteTargetIsNew(existing, dir),
        /already exists/,
      );
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('mentions the edit tool in the error so the agent knows the next step', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mm-write-'));
    const existing = path.join(dir, 'kept.txt');
    try {
      await fsp.writeFile(existing, 'hello');
      assert.throws(
        () => assertWriteTargetIsNew(existing, dir),
        /edit/i,
      );
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('resolves a relative path against the cwd argument', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mm-write-'));
    try {
      await fsp.writeFile(path.join(dir, 'rel.txt'), 'hi');
      // Relative path is resolved against `cwd`, not process.cwd().
      assert.throws(
        () => assertWriteTargetIsNew('rel.txt', dir),
        /already exists/,
      );
      assert.doesNotThrow(() =>
        assertWriteTargetIsNew('does-not-exist.txt', dir),
      );
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
