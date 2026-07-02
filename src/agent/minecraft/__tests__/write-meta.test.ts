import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { writeMinecraftMeta } from '../scaffold.js';

const PROPS = `# Sets default memory used for gradle commands.
org.gradle.jvmargs=-Xmx1G

mod_id=timberfell
mod_name=Timber Fell
mod_authors=Peter
mod_description=Fells whole trees.
mod_version=0.1.0
mod_group_id=com.modmixer.timberfell
`;

describe('writeMinecraftMeta version patch', () => {
  let modDir: string;
  const propsPath = () => path.join(modDir, 'gradle.properties');

  before(async () => {
    modDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mm-meta-'));
    await fsp.writeFile(propsPath(), PROPS, 'utf8');
  });

  after(async () => {
    await fsp.rm(modDir, { recursive: true, force: true });
  });

  it('writes mod_version and reports the change', async () => {
    const changed = await writeMinecraftMeta(modDir, { version: '1.0.1' });
    assert.deepEqual(changed, ['version']);
    const props = await fsp.readFile(propsPath(), 'utf8');
    assert.match(props, /^mod_version=1\.0\.1$/m);
    // Untouched keys and comments survive the patch.
    assert.match(props, /^mod_id=timberfell$/m);
    assert.match(props, /^# Sets default memory/m);
  });

  it('trims whitespace around the version', async () => {
    const changed = await writeMinecraftMeta(modDir, { version: ' 1.0.2 ' });
    assert.deepEqual(changed, ['version']);
    assert.match(await fsp.readFile(propsPath(), 'utf8'), /^mod_version=1\.0\.2$/m);
  });

  it('is a no-op when the version already matches', async () => {
    const changed = await writeMinecraftMeta(modDir, { version: '1.0.2' });
    assert.deepEqual(changed, []);
  });
});
