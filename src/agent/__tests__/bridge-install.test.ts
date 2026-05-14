import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  BRIDGE_PACKAGE_ID,
  ensureBridgeInstalled,
  removeBridgeInstall,
} from '../bridge-install.js';
import { setRimWorldInstallOverride } from '../paths.js';
import type { RegistrySnapshot } from '../registry/types.js';

/**
 * Set up a self-contained fake-install + fake-bundled-bridge tree under
 * tmpdir, point detectRimWorldPaths()'s install override at it, and point
 * process.resourcesPath at the bundled-bridge parent so
 * resolveBridgeSourceDir() picks it up. RimWorld's `Mods/` and the
 * managed-dll probe (used by detectRimWorldPaths) are placeholder files —
 * we only care about modsDir resolution, not running RimWorld.
 */
interface TestEnv {
  installDir: string;
  modsDir: string;
  /** Where the "bundled" bridge lives. resolveBridgeSourceDir picks this up
   *  via process.resourcesPath/modmixer-bridge. */
  bundledBridgeDir: string;
  cleanup: () => Promise<void>;
}

async function setupEnv(): Promise<TestEnv> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mm-bridge-test-'));
  const installDir = path.join(root, 'RimWorld');
  const managedDir = path.join(installDir, 'RimWorldWin64_Data', 'Managed');
  const modsDir = path.join(installDir, 'Mods');
  await fsp.mkdir(managedDir, { recursive: true });
  await fsp.mkdir(modsDir, { recursive: true });
  // Placeholder so detectExecutable() doesn't bail and detectRimWorldPaths
  // returns a usable modsDir / managedDir pair.
  await fsp.writeFile(
    path.join(managedDir, 'Assembly-CSharp.dll'),
    'placeholder',
  );
  await fsp.writeFile(
    path.join(installDir, 'RimWorldWin64.exe'),
    'placeholder',
  );

  // Resource dir contains a fake modmixer-bridge mod with the minimum
  // About.xml the helper checks for.
  const resourcesDir = path.join(root, 'resources');
  const bundledBridgeDir = path.join(resourcesDir, 'modmixer-bridge');
  await fsp.mkdir(path.join(bundledBridgeDir, 'About'), { recursive: true });
  await fsp.writeFile(
    path.join(bundledBridgeDir, 'About', 'About.xml'),
    '<?xml version="1.0"?><ModMetaData><packageId>modmixer.bridge</packageId></ModMetaData>',
  );

  setRimWorldInstallOverride(installDir);
  const priorResourcesPath = (process as { resourcesPath?: string }).resourcesPath;
  (process as { resourcesPath: string }).resourcesPath = resourcesDir;

  return {
    installDir,
    modsDir,
    bundledBridgeDir,
    cleanup: async () => {
      setRimWorldInstallOverride(null);
      if (priorResourcesPath === undefined) {
        delete (process as { resourcesPath?: string }).resourcesPath;
      } else {
        (process as { resourcesPath: string }).resourcesPath = priorResourcesPath;
      }
      await fsp.rm(root, { recursive: true, force: true });
    },
  };
}

const EMPTY_SNAPSHOT: RegistrySnapshot = {
  mods: [],
  active: [],
  activeOrder: [],
  missingActive: [],
  gameVersion: '1.6.0 rev0',
  gameVersionMajorMinor: '1.6',
};

function workshopSnapshot(): RegistrySnapshot {
  return {
    ...EMPTY_SNAPSHOT,
    mods: [
      {
        folder: '9999999999',
        path: 'C:/fake/workshop/9999999999',
        source: 'workshop',
        about: {
          name: 'Modmixer Bridge',
          packageId: BRIDGE_PACKAGE_ID,
          packageIdLc: BRIDGE_PACKAGE_ID,
          author: 'ModMixer',
          description: '',
          supportedVersions: ['1.6'],
          modDependencies: [],
          loadAfter: [],
          loadBefore: [],
          incompatibleWith: [],
        },
        hasDlls: true,
        publishedFileId: '9999999999',
        workspaceSynced: false,
      },
    ],
  };
}

describe('ensureBridgeInstalled', () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await setupEnv();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it('creates a junction when no prior install exists', async () => {
    const result = await ensureBridgeInstalled(EMPTY_SNAPSHOT);
    assert.equal(result.available, true);
    assert.equal(result.installed, true);
    const target = path.join(env.modsDir, 'ModmixerBridge');
    const lst = await fsp.lstat(target);
    assert.ok(lst.isSymbolicLink(), 'expected a junction/symlink at target');
    const resolved = await fsp.realpath(target);
    assert.equal(
      resolved.toLowerCase(),
      path.resolve(env.bundledBridgeDir).toLowerCase(),
    );
  });

  it('is idempotent — re-call when junction already points at our source', async () => {
    await ensureBridgeInstalled(EMPTY_SNAPSHOT);
    const result2 = await ensureBridgeInstalled(EMPTY_SNAPSHOT);
    assert.equal(result2.available, true);
    assert.equal(
      result2.installed,
      false,
      'second call should not report a fresh install',
    );
    // Junction still in place.
    const target = path.join(env.modsDir, 'ModmixerBridge');
    assert.ok(fs.existsSync(target));
  });

  it('skips when the user has the bridge via Workshop', async () => {
    const result = await ensureBridgeInstalled(workshopSnapshot());
    assert.equal(result.available, true);
    assert.equal(result.installed, false);
    assert.equal(result.skipReason, 'workshop');
    const target = path.join(env.modsDir, 'ModmixerBridge');
    assert.ok(!fs.existsSync(target), 'should not have created a junction');
  });

  it('skips when a real directory already occupies the target slot', async () => {
    const target = path.join(env.modsDir, 'ModmixerBridge');
    await fsp.mkdir(target, { recursive: true });
    await fsp.writeFile(path.join(target, 'About.xml'), '<placeholder/>');

    const result = await ensureBridgeInstalled(EMPTY_SNAPSHOT);
    assert.equal(result.available, true);
    assert.equal(result.installed, false);
    assert.equal(result.skipReason, 'local');
    // We didn't replace the user's directory.
    assert.ok(fs.statSync(target).isDirectory());
    assert.ok(!fs.lstatSync(target).isSymbolicLink());
  });

  it('refreshes a stale junction pointing somewhere else', async () => {
    const target = path.join(env.modsDir, 'ModmixerBridge');
    // Make a stale junction → some unrelated path that exists.
    const stalePath = path.join(env.installDir, 'StaleBridgeOldLocation');
    await fsp.mkdir(stalePath, { recursive: true });
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    await fsp.symlink(stalePath, target, linkType);

    const result = await ensureBridgeInstalled(EMPTY_SNAPSHOT);
    assert.equal(result.installed, true);
    const resolved = await fsp.realpath(target);
    assert.equal(
      resolved.toLowerCase(),
      path.resolve(env.bundledBridgeDir).toLowerCase(),
    );
  });
});

describe('removeBridgeInstall', () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await setupEnv();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it('removes a junction we created', async () => {
    await ensureBridgeInstalled(EMPTY_SNAPSHOT);
    const target = path.join(env.modsDir, 'ModmixerBridge');
    assert.ok(fs.existsSync(target));

    const removed = await removeBridgeInstall();
    assert.equal(removed, true);
    assert.ok(!fs.existsSync(target));
  });

  it('leaves a real directory alone (refuses to delete non-junction)', async () => {
    const target = path.join(env.modsDir, 'ModmixerBridge');
    await fsp.mkdir(target, { recursive: true });
    await fsp.writeFile(path.join(target, 'About.xml'), '<placeholder/>');

    const removed = await removeBridgeInstall();
    assert.equal(removed, false);
    assert.ok(fs.statSync(target).isDirectory());
  });

  it('is safe to call when nothing is installed', async () => {
    const removed = await removeBridgeInstall();
    assert.equal(removed, false);
  });
});
