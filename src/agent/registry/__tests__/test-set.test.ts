import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeTestSet, diffActiveLists } from '../test-set.js';
import type { RegistryMod, RegistrySnapshot } from '../types.js';

function mkMod(packageId: string, opts: Partial<RegistryMod['about']> = {}): RegistryMod {
  return {
    folder: packageId,
    path: '/' + packageId,
    source: 'local',
    hasDlls: false,
    publishedFileId: null,
    workspaceSynced: false,
    about: {
      name: packageId,
      packageId,
      packageIdLc: packageId.toLowerCase(),
      author: '',
      description: '',
      supportedVersions: [],
      modDependencies: [],
      loadAfter: [],
      loadBefore: [],
      incompatibleWith: [],
      ...opts,
    },
  };
}

function makeSnapshot(args: {
  mods: RegistryMod[];
  active: string[];
}): RegistrySnapshot {
  return {
    mods: args.mods,
    active: [],
    activeOrder: args.active,
    missingActive: [],
    gameVersion: '',
    gameVersionMajorMinor: null,
  };
}

describe('computeTestSet', () => {
  it('always pulls Core', () => {
    const mods = [mkMod('Ludeon.RimWorld'), mkMod('Author.MyMod')];
    const out = computeTestSet({
      snapshot: makeSnapshot({
        mods,
        active: [],
      }),
      targetPackageId: 'author.mymod',
    });
    assert.ok(out.reducedActive.includes('ludeon.rimworld'));
    assert.ok(out.reducedActive.includes('author.mymod'));
  });

  it('includes only DLCs that were already active', () => {
    const mods = [
      mkMod('Ludeon.RimWorld'),
      mkMod('Ludeon.RimWorld.Royalty'),
      mkMod('Ludeon.RimWorld.Anomaly'),
      mkMod('Author.MyMod'),
    ];
    const out = computeTestSet({
      snapshot: makeSnapshot({
        mods,
        active: ['ludeon.rimworld', 'ludeon.rimworld.royalty', 'author.mymod'],
      }),
      targetPackageId: 'author.mymod',
    });
    assert.ok(out.reducedActive.includes('ludeon.rimworld.royalty'));
    assert.ok(!out.reducedActive.includes('ludeon.rimworld.anomaly'));
  });

  it('pulls in transitive deps', () => {
    const mods = [
      mkMod('Ludeon.RimWorld'),
      mkMod('Author.A'),
      mkMod('Author.B', {
        modDependencies: [
          {
            packageId: 'Author.A',
            packageIdLc: 'author.a',
            displayName: '',
            steamWorkshopUrl: '',
            downloadUrl: '',
          },
        ],
      }),
      mkMod('Author.Top', {
        modDependencies: [
          {
            packageId: 'Author.B',
            packageIdLc: 'author.b',
            displayName: '',
            steamWorkshopUrl: '',
            downloadUrl: '',
          },
        ],
      }),
    ];
    const out = computeTestSet({
      snapshot: makeSnapshot({ mods, active: [] }),
      targetPackageId: 'author.top',
    });
    for (const id of ['author.a', 'author.b', 'author.top']) {
      assert.ok(out.reducedActive.includes(id), `${id} should be in reduced set`);
    }
  });

  it('reports missing deps not on disk', () => {
    const mods = [
      mkMod('Ludeon.RimWorld'),
      mkMod('Author.Top', {
        modDependencies: [
          {
            packageId: 'NotInstalled.Thing',
            packageIdLc: 'notinstalled.thing',
            displayName: '',
            steamWorkshopUrl: '',
            downloadUrl: '',
          },
        ],
      }),
    ];
    const out = computeTestSet({
      snapshot: makeSnapshot({ mods, active: [] }),
      targetPackageId: 'author.top',
    });
    assert.deepEqual(out.missing, ['notinstalled.thing']);
  });

  it('co-loads companion mods and their transitive deps', () => {
    const mods = [
      mkMod('Ludeon.RimWorld'),
      mkMod('Author.MyMod'),
      mkMod('Other.Dep'),
      mkMod('Other.Mod', {
        modDependencies: [
          {
            packageId: 'Other.Dep',
            packageIdLc: 'other.dep',
            displayName: '',
            steamWorkshopUrl: '',
            downloadUrl: '',
          },
        ],
      }),
    ];
    const out = computeTestSet({
      snapshot: makeSnapshot({ mods, active: [] }),
      targetPackageId: 'author.mymod',
      companionPackageIds: ['Other.Mod'],
    });
    for (const id of ['author.mymod', 'other.mod', 'other.dep']) {
      assert.ok(out.reducedActive.includes(id), `${id} should be in reduced set`);
    }
    assert.deepEqual(out.missingCompanions, []);
  });

  it('reports companion mods not on disk separately from deps', () => {
    const mods = [mkMod('Ludeon.RimWorld'), mkMod('Author.MyMod')];
    const out = computeTestSet({
      snapshot: makeSnapshot({ mods, active: [] }),
      targetPackageId: 'author.mymod',
      companionPackageIds: ['NotInstalled.Companion'],
    });
    assert.deepEqual(out.missing, []);
    assert.deepEqual(out.missingCompanions, ['notinstalled.companion']);
    assert.ok(!out.reducedActive.includes('notinstalled.companion'));
  });
});

describe('diffActiveLists', () => {
  it('detects added/removed', () => {
    const d = diffActiveLists(['a', 'b'], ['a', 'c']);
    assert.deepEqual(d.added, ['c']);
    assert.deepEqual(d.removed, ['b']);
    assert.equal(d.reordered, false);
  });

  it('detects reorder of intersection', () => {
    const d = diffActiveLists(['a', 'b', 'c'], ['c', 'a', 'b']);
    assert.equal(d.reordered, true);
  });

  it('reports no reorder when intersection order is preserved', () => {
    const d = diffActiveLists(['a', 'b'], ['a', 'b', 'c']);
    assert.equal(d.reordered, false);
    assert.deepEqual(d.added, ['c']);
  });
});
