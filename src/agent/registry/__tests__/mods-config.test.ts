import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseModsConfig } from '../mods-config.js';

describe('parseModsConfig', () => {
  it('parses version, activeMods, knownExpansions', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<ModsConfigData>
  <version>1.6.123 rev123</version>
  <activeMods>
    <li>Ludeon.RimWorld</li>
    <li>Ludeon.RimWorld.Royalty</li>
    <li>Author.MyMod</li>
  </activeMods>
  <knownExpansions>
    <li>Ludeon.RimWorld.Royalty</li>
  </knownExpansions>
</ModsConfigData>`;
    const out = parseModsConfig(xml);
    assert.equal(out.version, '1.6.123 rev123');
    assert.deepEqual(out.activeMods, [
      'ludeon.rimworld',
      'ludeon.rimworld.royalty',
      'author.mymod',
    ]);
    assert.deepEqual(out.knownExpansions, ['ludeon.rimworld.royalty']);
  });

  it('handles empty file gracefully', () => {
    const out = parseModsConfig('');
    assert.equal(out.version, '');
    assert.deepEqual(out.activeMods, []);
    assert.deepEqual(out.knownExpansions, []);
  });

  it('strips BOM', () => {
    const xml =
      '﻿<ModsConfigData><version>1.5</version><activeMods><li>X.Y</li></activeMods><knownExpansions></knownExpansions></ModsConfigData>';
    const out = parseModsConfig(xml);
    assert.equal(out.version, '1.5');
    assert.deepEqual(out.activeMods, ['x.y']);
  });

  it('skips commented-out entries', () => {
    const xml = `<ModsConfigData>
  <activeMods>
    <!-- <li>disabled.mod</li> -->
    <li>real.mod</li>
  </activeMods>
</ModsConfigData>`;
    const out = parseModsConfig(xml);
    assert.deepEqual(out.activeMods, ['real.mod']);
  });
});
