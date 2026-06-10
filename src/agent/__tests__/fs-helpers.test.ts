import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { direntIsDirectoryLike } from '../fs-helpers.js';

describe('direntIsDirectoryLike', () => {
  let root: string;

  before(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mm-fsh-'));
    await fsp.mkdir(path.join(root, 'real-dir'));
    await fsp.writeFile(path.join(root, 'plain-file.txt'), 'x', 'utf8');
    // Same link type the bridge/live installers use (junction on Windows —
    // creatable without privileges; plain dir symlink elsewhere).
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    await fsp.symlink(
      path.join(root, 'real-dir'),
      path.join(root, 'dir-link'),
      linkType,
    );
    await fsp.symlink(
      path.join(root, 'real-dir'),
      path.join(root, 'dangling-link'),
      linkType,
    );
    await fsp.rename(path.join(root, 'real-dir'), path.join(root, 'moved-dir'));
    // dir-link now dangles too; re-point a fresh one at the moved dir.
    await fsp.rm(path.join(root, 'dir-link'), { recursive: true, force: true });
    await fsp.symlink(
      path.join(root, 'moved-dir'),
      path.join(root, 'dir-link'),
      linkType,
    );
  });

  after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  async function entry(name: string): Promise<fs.Dirent> {
    const entries = await fsp.readdir(root, { withFileTypes: true });
    const e = entries.find((d) => d.name === name);
    assert.ok(e, `dirent ${name} not found`);
    return e;
  }

  it('accepts a real directory', async () => {
    assert.equal(await direntIsDirectoryLike(await entry('moved-dir'), root), true);
  });

  it('accepts a junction/symlink resolving to a directory', async () => {
    const e = await entry('dir-link');
    // Precondition for the regression this guards: Dirent must report the
    // link as a symlink, not a directory (the old isDirectory() check
    // skipped it — hiding junction-installed mods from the registry).
    assert.equal(e.isDirectory(), false);
    assert.equal(e.isSymbolicLink(), true);
    assert.equal(await direntIsDirectoryLike(e, root), true);
  });

  it('rejects a dangling link', async () => {
    assert.equal(
      await direntIsDirectoryLike(await entry('dangling-link'), root),
      false,
    );
  });

  it('rejects a plain file', async () => {
    assert.equal(
      await direntIsDirectoryLike(await entry('plain-file.txt'), root),
      false,
    );
  });
});
