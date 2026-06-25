import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseModManifest } from '../mod-manifest.js';

// A real-shaped NeoForge manifest (mirrors resources/modmixer-bridge.jar's
// META-INF/neoforge.mods.toml: multi-line description, typed dependencies).
const NEOFORGE_TOML = `
modLoader = "javafml"
loaderVersion = "[4,)"
license = "MIT"

[[mods]]
modId = "modmixerbridge"
version = "0.1.0"
displayName = "ModMixer Bridge"
authors = "ModMixer"
description = '''
Live diagnostic bridge to ModMixer. Streams errors to the desktop app.
'''

[[dependencies.modmixerbridge]]
modId = "neoforge"
type = "required"
versionRange = "[21.1.0,)"
ordering = "NONE"
side = "BOTH"

[[dependencies.modmixerbridge]]
modId = "minecraft"
type = "required"
versionRange = "[1.21.1,1.21.2)"
side = "BOTH"
`;

describe('parseModManifest', () => {
  it('parses a NeoForge manifest with typed dependencies', () => {
    const mods = parseModManifest({ neoforgeToml: NEOFORGE_TOML, fallbackId: 'whatever' });
    assert.equal(mods.length, 1);
    const m = mods[0];
    assert.equal(m.modId, 'modmixerbridge');
    assert.equal(m.displayName, 'ModMixer Bridge');
    assert.equal(m.version, '0.1.0');
    assert.equal(m.authors, 'ModMixer');
    assert.equal(m.loader, 'neoforge');
    assert.match(m.description ?? '', /Live diagnostic bridge/);
    assert.equal(m.dependencies.length, 2);
    const neo = m.dependencies.find((d) => d.modId === 'neoforge');
    assert.equal(neo?.type, 'required');
    assert.equal(neo?.versionRange, '[21.1.0,)');
  });

  it('maps legacy Forge `mandatory` boolean to required/optional', () => {
    const toml = `
[[mods]]
modId = "oldmod"
version = "2.0"
displayName = "Old Mod"

[[dependencies.oldmod]]
modId = "forge"
mandatory = true
versionRange = "[47,)"

[[dependencies.oldmod]]
modId = "jei"
mandatory = false
`;
    const mods = parseModManifest({ modsToml: toml, fallbackId: 'oldmod' });
    assert.equal(mods[0].loader, 'forge');
    assert.equal(mods[0].dependencies.find((d) => d.modId === 'forge')?.type, 'required');
    assert.equal(mods[0].dependencies.find((d) => d.modId === 'jei')?.type, 'optional');
  });

  it('parses a Fabric manifest with depends map', () => {
    const json = JSON.stringify({
      schemaVersion: 1,
      id: 'fabricmod',
      name: 'Fabric Mod',
      version: '3.1.4',
      authors: ['Alice', { name: 'Bob' }],
      description: 'A fabric mod.',
      depends: { fabricloader: '>=0.15', minecraft: '~1.21' },
    });
    const mods = parseModManifest({ fabricJson: json, fallbackId: 'x' });
    assert.equal(mods.length, 1);
    assert.equal(mods[0].loader, 'fabric');
    assert.equal(mods[0].modId, 'fabricmod');
    assert.equal(mods[0].authors, 'Alice, Bob');
    assert.equal(mods[0].dependencies.length, 2);
    assert.equal(
      mods[0].dependencies.find((d) => d.modId === 'minecraft')?.versionRange,
      '~1.21',
    );
  });

  it('emits one entry per [[mods]] in a multi-mod jar', () => {
    const toml = `
[[mods]]
modId = "core"
version = "1.0"
displayName = "Core"

[[mods]]
modId = "addon"
version = "1.0"
displayName = "Addon"
`;
    const mods = parseModManifest({ neoforgeToml: toml, fallbackId: 'core' });
    assert.deepEqual(
      mods.map((m) => m.modId),
      ['core', 'addon'],
    );
  });

  it('prefers the NeoForge manifest over Fabric when both are present', () => {
    const mods = parseModManifest({
      neoforgeToml: NEOFORGE_TOML,
      fabricJson: JSON.stringify({ id: 'fabricmod', name: 'Fabric' }),
      fallbackId: 'x',
    });
    assert.equal(mods[0].loader, 'neoforge');
    assert.equal(mods[0].modId, 'modmixerbridge');
  });

  it('falls back to a filename-only entry for an unrecognized jar', () => {
    const mods = parseModManifest({ fallbackId: 'somelib-1.2.3' });
    assert.equal(mods.length, 1);
    assert.equal(mods[0].modId, 'somelib-1.2.3');
    assert.equal(mods[0].loader, 'unknown');
    assert.equal(mods[0].version, 'unknown');
    assert.deepEqual(mods[0].dependencies, []);
  });
});
