import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  chooseAssemblyName,
  collectSiblingAssemblyNames,
  deriveAssemblyName,
  findAssemblyCollisions,
  reconcileFallbackAssemblyName,
} from '../assembly-names.js';

describe('chooseAssemblyName (pure)', () => {
  const empty = new Set<string>();

  it('PascalCases the display name', () => {
    assert.equal(
      chooseAssemblyName({
        displayName: 'Pillage and Plunder',
        folderId: 'abc123',
        taken: empty,
      }),
      'PillageAndPlunder',
    );
  });

  it('falls back to the folder id when the name is the placeholder', () => {
    const name = chooseAssemblyName({
      displayName: 'Untitled Mod',
      folderId: '3f9a2bc1d4e5',
      taken: empty,
    });
    // pascalCase's leading-digit guard prefixes "Mod" onto a hex id.
    assert.equal(name, 'Mod3f9a2bc1d4e5');
    assert.notEqual(name, 'UntitledMod');
  });

  it('uses a real name even with no packageId (the regression)', () => {
    // The bug: keying "placeholder" off the packageId meant a well-named mod
    // whose packageId hadn't landed yet got the folder-id fallback. The name
    // alone must be enough.
    assert.equal(
      chooseAssemblyName({
        displayName: 'Opening Thunderstorm',
        folderId: '4edb95787e3e',
        taken: empty,
      }),
      'OpeningThunderstorm',
    );
  });

  it('falls back to the folder id when the name has no usable characters', () => {
    assert.equal(
      chooseAssemblyName({
        displayName: '???',
        folderId: 'deadbeef',
        taken: empty,
      }),
      'Deadbeef',
    );
  });

  it('appends a counter to avoid a taken name (case-insensitive)', () => {
    assert.equal(
      chooseAssemblyName({
        displayName: 'Hat Hair Control',
        folderId: 'x',
        taken: new Set(['hathaircontrol']),
      }),
      'HatHairControl2',
    );
  });

  it('keeps incrementing past multiple collisions', () => {
    assert.equal(
      chooseAssemblyName({
        displayName: 'My Mod',
        folderId: 'x',
        taken: new Set(['mymod', 'mymod2', 'mymod3']),
      }),
      'MyMod4',
    );
  });
});

describe('workspace-backed derivation', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mm-asm-'));
  });
  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  async function mod(
    folder: string,
    opts: {
      name?: string;
      packageId?: string;
      csproj?: string;
      csprojAssembly?: string;
      dll?: string;
      modCs?: boolean;
    } = {},
  ): Promise<string> {
    const dir = path.join(workspace, folder);
    await fs.mkdir(path.join(dir, 'About'), { recursive: true });
    if (opts.name !== undefined || opts.packageId !== undefined) {
      await fs.writeFile(
        path.join(dir, 'About', 'About.xml'),
        `<?xml version="1.0"?><ModMetaData><name>${
          opts.name ?? ''
        }</name><packageId>${opts.packageId ?? ''}</packageId></ModMetaData>`,
        'utf8',
      );
    }
    if (opts.csproj) {
      await fs.mkdir(path.join(dir, 'Source'), { recursive: true });
      const assembly = opts.csprojAssembly ?? opts.csproj;
      await fs.writeFile(
        path.join(dir, 'Source', `${opts.csproj}.csproj`),
        `<Project><PropertyGroup><AssemblyName>${assembly}</AssemblyName><RootNamespace>${assembly}</RootNamespace></PropertyGroup></Project>`,
        'utf8',
      );
    }
    if (opts.dll) {
      await fs.mkdir(path.join(dir, 'Assemblies'), { recursive: true });
      await fs.writeFile(
        path.join(dir, 'Assemblies', `${opts.dll}.dll`),
        'MZ',
        'utf8',
      );
    }
    return dir;
  }

  it('collects sibling names from csproj + dll basenames, excluding self', async () => {
    await mod('self', { csproj: 'Self' });
    await mod('a', { csproj: 'Alpha' });
    await mod('b', { dll: 'Beta' });
    const taken = await collectSiblingAssemblyNames(workspace, 'self');
    assert.deepEqual([...taken].sort(), ['alpha', 'beta']);
    assert.ok(!taken.has('self'));
  });

  it('derives from the name even when the packageId is still empty', async () => {
    // Mirrors the real failure: name set, packageId not yet written.
    const self = await mod('4edb95787e3e', {
      name: 'Opening Thunderstorm',
      packageId: '',
    });
    assert.equal(await deriveAssemblyName(self), 'OpeningThunderstorm');
  });

  it('derives a name that dodges an existing sibling assembly', async () => {
    // The classic collision: a sibling already owns "ModSource".
    await mod('other', { name: 'Hat Hair Control', csproj: 'ModSource' });
    const self = await mod('self', {
      name: 'Mod Source',
      packageId: 'me.modsource',
    });
    assert.equal(await deriveAssemblyName(self), 'ModSource2');
  });

  it('flags a build-time collision on a shared built DLL, naming the sibling', async () => {
    await mod('other', { name: 'Hat Hair Control', dll: 'ModSource' });
    const self = await mod('self', { name: 'My Mod', dll: 'ModSource' });
    const collisions = await findAssemblyCollisions(self);
    assert.equal(collisions.length, 1);
    assert.equal(collisions[0].assembly, 'ModSource');
    assert.deepEqual(collisions[0].others, ['Hat Hair Control']);
  });

  it('reports no collision when built DLLs are uniquely named', async () => {
    await mod('other', { name: 'Hat Hair Control', dll: 'HatHairControl' });
    const self = await mod('self', { name: 'My Mod', dll: 'MyMod' });
    assert.deepEqual(await findAssemblyCollisions(self), []);
  });

  describe('reconcileFallbackAssemblyName', () => {
    it('renames a folder-id assembly to the real name and drops the stale DLL', async () => {
      const folder = '4edb95787e3e';
      const dir = await mod(folder, {
        name: 'Opening Thunderstorm',
        packageId: 'lebek.OpeningThunderstorm',
        csproj: 'Mod4edb95787e3e',
        dll: 'Mod4edb95787e3e',
      });
      const rename = await reconcileFallbackAssemblyName(dir);
      assert.deepEqual(rename, {
        from: 'Mod4edb95787e3e',
        to: 'OpeningThunderstorm',
      });
      // csproj renamed + rewritten
      const source = await fs.readdir(path.join(dir, 'Source'));
      assert.ok(source.includes('OpeningThunderstorm.csproj'));
      assert.ok(!source.includes('Mod4edb95787e3e.csproj'));
      const csproj = await fs.readFile(
        path.join(dir, 'Source', 'OpeningThunderstorm.csproj'),
        'utf8',
      );
      assert.match(csproj, /<AssemblyName>OpeningThunderstorm<\/AssemblyName>/);
      assert.match(csproj, /<RootNamespace>OpeningThunderstorm<\/RootNamespace>/);
      // stale DLL removed
      const asm = await fs.readdir(path.join(dir, 'Assemblies'));
      assert.ok(!asm.includes('Mod4edb95787e3e.dll'));
    });

    it('is a no-op for an already-real assembly name', async () => {
      const dir = await mod('abc123', {
        name: 'Pillage and Plunder',
        packageId: 'me.pnp',
        csproj: 'PillageAndPlunder',
      });
      assert.equal(await reconcileFallbackAssemblyName(dir), null);
    });

    it('is a no-op while the mod is still unnamed', async () => {
      const dir = await mod('abc123', {
        name: 'Untitled Mod',
        csproj: 'Modabc123',
      });
      assert.equal(await reconcileFallbackAssemblyName(dir), null);
    });

    it('leaves a sibling LiveSession.csproj untouched', async () => {
      const folder = '4edb95787e3e';
      const dir = await mod(folder, {
        name: 'Opening Thunderstorm',
        packageId: 'lebek.OpeningThunderstorm',
        csproj: 'Mod4edb95787e3e',
      });
      await fs.writeFile(
        path.join(dir, 'Source', 'LiveSession.csproj'),
        '<Project><PropertyGroup><AssemblyName>LiveSession</AssemblyName></PropertyGroup></Project>',
        'utf8',
      );
      const rename = await reconcileFallbackAssemblyName(dir);
      assert.equal(rename?.to, 'OpeningThunderstorm');
      const source = await fs.readdir(path.join(dir, 'Source'));
      assert.ok(source.includes('LiveSession.csproj'));
    });
  });
});
