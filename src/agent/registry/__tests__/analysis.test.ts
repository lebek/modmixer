import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSnapshot } from '../analysis.js';
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
      modVersion: '',
      supportedVersions: [],
      modDependencies: [],
      loadAfter: [],
      loadBefore: [],
      incompatibleWith: [],
      ...opts,
    },
  };
}

function snapshot(args: {
  mods: RegistryMod[];
  active: string[];
  gameMajorMinor?: string;
}): RegistrySnapshot {
  return {
    mods: args.mods,
    active: args.active.map((p, i) => ({
      packageId: p,
      loadOrder: i + 1,
      mod: args.mods.find((m) => m.about.packageIdLc === p) ?? null,
    })),
    activeOrder: args.active,
    missingActive: args.active.filter(
      (p) => !args.mods.find((m) => m.about.packageIdLc === p),
    ),
    gameVersion: args.gameMajorMinor ?? '',
    gameVersionMajorMinor: args.gameMajorMinor ?? null,
  };
}

describe('analyzeSnapshot', () => {
  it('flags missing dependencies', () => {
    const a = mkMod('a.x', {
      modDependencies: [
        {
          packageId: 'a.dep',
          packageIdLc: 'a.dep',
          displayName: 'The Dep',
          steamWorkshopUrl: '',
          downloadUrl: '',
        },
      ],
    });
    const result = analyzeSnapshot(snapshot({ mods: [a], active: ['a.x'] }));
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0].kind, 'missing-dependency');
    assert.equal(result.issues[0].otherPackageId, 'a.dep');
  });

  it('flags incompatible mods both active', () => {
    const a = mkMod('a.x', { incompatibleWith: ['a.y'] });
    const b = mkMod('a.y');
    const result = analyzeSnapshot(
      snapshot({ mods: [a, b], active: ['a.x', 'a.y'] }),
    );
    const issue = result.issues.find((i) => i.kind === 'incompatible-mod-active');
    assert.ok(issue, 'should detect incompatibility');
  });

  it('flags load-order violations', () => {
    const a = mkMod('a.x', { loadAfter: ['a.y'] });
    const b = mkMod('a.y');
    const result = analyzeSnapshot(
      snapshot({ mods: [a, b], active: ['a.x', 'a.y'] }),
    );
    const issue = result.issues.find((i) => i.kind === 'load-order-violation');
    assert.ok(issue, 'a.x should flag load-order against a.y');
  });

  it('does not flag load-order when other mod is inactive', () => {
    const a = mkMod('a.x', { loadAfter: ['a.absent'] });
    const result = analyzeSnapshot(snapshot({ mods: [a], active: ['a.x'] }));
    const issue = result.issues.find((i) => i.kind === 'load-order-violation');
    assert.equal(issue, undefined);
  });

  it('flags version-incompat for both active and inactive mods', () => {
    const a = mkMod('a.x', { supportedVersions: ['1.4'] });
    const b = mkMod('a.y', { supportedVersions: ['1.6'] });
    const result = analyzeSnapshot(
      snapshot({
        mods: [a, b],
        active: ['a.x'],
        gameMajorMinor: '1.6',
      }),
    );
    const flags = result.issues.filter((i) => i.kind === 'version-incompat');
    assert.equal(flags.length, 1, 'a.x is incompat; b.y is compat');
    assert.equal(flags[0].packageId, 'a.x');
  });
});
