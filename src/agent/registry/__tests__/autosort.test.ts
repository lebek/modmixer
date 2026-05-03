import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { autosort } from '../autosort.js';
import type { RegistryMod, RegistrySnapshot } from '../types.js';
import type { CommunityRule } from '../community-rules.js';

function makeMod(packageId: string, opts: Partial<RegistryMod['about']> = {}): RegistryMod {
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

function snapshot(mods: RegistryMod[]): RegistrySnapshot {
  return {
    mods,
    active: [],
    activeOrder: [],
    missingActive: [],
    gameVersion: '',
    gameVersionMajorMinor: null,
  };
}

describe('autosort', () => {
  it('places Core first', () => {
    const mods = [makeMod('Author.MyMod'), makeMod('Ludeon.RimWorld')];
    const out = autosort({
      activeOrder: ['author.mymod', 'ludeon.rimworld'],
      snapshot: snapshot(mods),
      rules: new Map(),
    });
    assert.equal(out.order[0], 'ludeon.rimworld');
  });

  it('places official DLCs after Core in canonical order', () => {
    const mods = [
      makeMod('Ludeon.RimWorld'),
      makeMod('Ludeon.RimWorld.Anomaly'),
      makeMod('Ludeon.RimWorld.Royalty'),
      makeMod('Ludeon.RimWorld.Biotech'),
    ];
    const out = autosort({
      activeOrder: [
        'ludeon.rimworld.anomaly',
        'ludeon.rimworld.royalty',
        'ludeon.rimworld.biotech',
        'ludeon.rimworld',
      ],
      snapshot: snapshot(mods),
      rules: new Map(),
    });
    assert.deepEqual(out.order, [
      'ludeon.rimworld',
      'ludeon.rimworld.royalty',
      'ludeon.rimworld.biotech',
      'ludeon.rimworld.anomaly',
    ]);
  });

  it('respects About.xml deps as hard constraints', () => {
    const mods = [
      makeMod('Author.A'),
      makeMod('Author.B', {
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
    ];
    const out = autosort({
      activeOrder: ['author.b', 'author.a'],
      snapshot: snapshot(mods),
      rules: new Map(),
    });
    assert.deepEqual(out.order, ['author.a', 'author.b']);
  });

  it('respects loadAfter/loadBefore declarations', () => {
    const mods = [
      makeMod('Author.A'),
      makeMod('Author.B', { loadAfter: ['author.a'] }),
      makeMod('Author.C', { loadBefore: ['author.a'] }),
    ];
    const out = autosort({
      activeOrder: ['author.a', 'author.b', 'author.c'],
      snapshot: snapshot(mods),
      rules: new Map(),
    });
    const aIdx = out.order.indexOf('author.a');
    const bIdx = out.order.indexOf('author.b');
    const cIdx = out.order.indexOf('author.c');
    assert.ok(aIdx < bIdx, 'a before b');
    assert.ok(cIdx < aIdx, 'c before a');
  });

  it('applies community rules as soft preferences', () => {
    const mods = [makeMod('A.X'), makeMod('A.Y')];
    const rules = new Map<string, CommunityRule>();
    rules.set('a.y', {
      packageId: 'a.y',
      loadAfter: ['a.x'],
      loadBefore: [],
      loadBottom: false,
    });
    const out = autosort({
      activeOrder: ['a.y', 'a.x'],
      snapshot: snapshot(mods),
      rules,
    });
    assert.deepEqual(out.order, ['a.x', 'a.y']);
  });

  it('biases loadBottom mods to the end', () => {
    const mods = [makeMod('A.X'), makeMod('A.Y'), makeMod('A.Z')];
    const rules = new Map<string, CommunityRule>();
    rules.set('a.x', {
      packageId: 'a.x',
      loadAfter: [],
      loadBefore: [],
      loadBottom: true,
    });
    const out = autosort({
      activeOrder: ['a.x', 'a.y', 'a.z'],
      snapshot: snapshot(mods),
      rules,
    });
    assert.equal(out.order[out.order.length - 1], 'a.x');
  });

  it('reports cycle-creating constraints as conflicts instead of throwing', () => {
    const mods = [
      makeMod('A.X', { loadAfter: ['a.y'] }),
      makeMod('A.Y', { loadAfter: ['a.x'] }),
    ];
    const out = autosort({
      activeOrder: ['a.x', 'a.y'],
      snapshot: snapshot(mods),
      rules: new Map(),
    });
    assert.equal(out.order.length, 2);
    assert.ok(
      out.conflicts.length > 0,
      'should report at least one unsatisfiable constraint',
    );
  });
});
