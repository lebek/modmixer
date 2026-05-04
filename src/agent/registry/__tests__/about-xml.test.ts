import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseAboutXml } from '../about-xml.js';

describe('parseAboutXml', () => {
  it('parses scalar fields', () => {
    const xml = `<?xml version="1.0"?>
<ModMetaData>
  <name>My Mod</name>
  <packageId>Author.MyMod</packageId>
  <author>Alice</author>
  <description>Does things.</description>
  <supportedVersions>
    <li>1.5</li>
    <li>1.6</li>
  </supportedVersions>
</ModMetaData>`;
    const out = parseAboutXml(xml);
    assert.equal(out.name, 'My Mod');
    assert.equal(out.packageId, 'Author.MyMod');
    assert.equal(out.packageIdLc, 'author.mymod');
    assert.equal(out.author, 'Alice');
    assert.equal(out.description, 'Does things.');
    assert.deepEqual(out.supportedVersions, ['1.5', '1.6']);
  });

  it('handles UTF-8 BOM', () => {
    const xml = '﻿<ModMetaData><name>BOM Mod</name></ModMetaData>';
    const out = parseAboutXml(xml);
    assert.equal(out.name, 'BOM Mod');
  });

  it('parses modDependencies blocks with full metadata', () => {
    const xml = `<ModMetaData>
  <packageId>X.Y</packageId>
  <modDependencies>
    <li>
      <packageId>Brrainz.HarmonyMod</packageId>
      <displayName>Harmony</displayName>
      <steamWorkshopUrl>steam://...</steamWorkshopUrl>
      <downloadUrl>https://github.com/.../releases</downloadUrl>
    </li>
    <li>
      <packageId>VanillaExpanded.Core</packageId>
      <displayName>Vanilla Expanded Framework</displayName>
    </li>
  </modDependencies>
</ModMetaData>`;
    const out = parseAboutXml(xml);
    assert.equal(out.modDependencies.length, 2);
    assert.equal(out.modDependencies[0].packageId, 'Brrainz.HarmonyMod');
    assert.equal(out.modDependencies[0].packageIdLc, 'brrainz.harmonymod');
    assert.equal(out.modDependencies[0].displayName, 'Harmony');
    assert.equal(out.modDependencies[0].steamWorkshopUrl, 'steam://...');
    assert.equal(
      out.modDependencies[0].downloadUrl,
      'https://github.com/.../releases',
    );
    assert.equal(out.modDependencies[1].packageId, 'VanillaExpanded.Core');
  });

  it('parses modDependenciesByVersion and merges with flat deps', () => {
    const xml = `<ModMetaData>
  <modDependencies>
    <li><packageId>A.Always</packageId></li>
  </modDependencies>
  <modDependenciesByVersion>
    <v1.5><li><packageId>B.For15</packageId></li></v1.5>
    <v1.6><li><packageId>C.For16</packageId></li></v1.6>
  </modDependenciesByVersion>
</ModMetaData>`;
    const out = parseAboutXml(xml);
    const ids = out.modDependencies.map((d) => d.packageIdLc).sort();
    assert.deepEqual(ids, ['a.always', 'b.for15', 'c.for16']);
  });

  it('merges loadAfterByVersion / loadBeforeByVersion / incompatibleWithByVersion into the flat lists', () => {
    // Some installed RimWorld mods declare load-order constraints only via
    // the ByVersion variants. Autosort needs to see them in the flat list.
    const xml = `<ModMetaData>
  <loadAfter>
    <li>Always.After</li>
  </loadAfter>
  <loadAfterByVersion>
    <v1.6>
      <li>Ludeon.RimWorld.Royalty</li>
      <li>Ludeon.RimWorld.Biotech</li>
    </v1.6>
  </loadAfterByVersion>
  <loadBeforeByVersion>
    <v1.6><li>Some.Other</li></v1.6>
  </loadBeforeByVersion>
  <incompatibleWithByVersion>
    <v1.5><li>Old.Incompat</li></v1.5>
  </incompatibleWithByVersion>
</ModMetaData>`;
    const out = parseAboutXml(xml);
    assert.deepEqual(out.loadAfter, [
      'always.after',
      'ludeon.rimworld.royalty',
      'ludeon.rimworld.biotech',
    ]);
    assert.deepEqual(out.loadBefore, ['some.other']);
    assert.deepEqual(out.incompatibleWith, ['old.incompat']);
  });

  it('dedupes when the same id appears in both flat and ByVersion lists', () => {
    const xml = `<ModMetaData>
  <loadAfter><li>Foo.Bar</li></loadAfter>
  <loadAfterByVersion>
    <v1.6><li>foo.bar</li><li>Other.Mod</li></v1.6>
  </loadAfterByVersion>
</ModMetaData>`;
    const out = parseAboutXml(xml);
    assert.deepEqual(out.loadAfter, ['foo.bar', 'other.mod']);
  });

  it('lowercases loadAfter / loadBefore / incompatibleWith', () => {
    const xml = `<ModMetaData>
  <loadAfter><li>Foo.Bar</li><li>BAZ.QUX</li></loadAfter>
  <loadBefore><li>Last.Mod</li></loadBefore>
  <incompatibleWith><li>Bad.Mod</li></incompatibleWith>
</ModMetaData>`;
    const out = parseAboutXml(xml);
    assert.deepEqual(out.loadAfter, ['foo.bar', 'baz.qux']);
    assert.deepEqual(out.loadBefore, ['last.mod']);
    assert.deepEqual(out.incompatibleWith, ['bad.mod']);
  });

  it('ignores commented-out <li> entries', () => {
    const xml = `<ModMetaData>
  <loadAfter>
    <!-- <li>commented.mod</li> -->
    <li>real.mod</li>
  </loadAfter>
</ModMetaData>`;
    const out = parseAboutXml(xml);
    assert.deepEqual(out.loadAfter, ['real.mod']);
  });

  it('returns empty shape for malformed input without throwing', () => {
    const out = parseAboutXml('<broken>');
    assert.equal(out.name, '');
    assert.deepEqual(out.modDependencies, []);
  });

  it('decodes XML entities including ampersand', () => {
    const xml = `<ModMetaData><name>Foo &amp; Bar</name></ModMetaData>`;
    const out = parseAboutXml(xml);
    assert.equal(out.name, 'Foo & Bar');
  });

  it('extracts the top-level packageId when modDependencies appears first', () => {
    // Zombieland 1.6 ships About.xml with <modDependencies> BEFORE its own
    // <packageId>. The dep block carries <packageId>brrainz.harmony</packageId>,
    // and a naive non-greedy regex would grab that instead of the real id.
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<ModMetaData>
  <name>Zombieland 1.6</name>
  <author>Andreas Pardeike, Louize</author>
  <modDependencies>
    <li>
      <packageId>brrainz.harmony</packageId>
      <displayName>Harmony</displayName>
    </li>
  </modDependencies>
  <packageId>brrainz.zombieland</packageId>
</ModMetaData>`;
    const out = parseAboutXml(xml);
    assert.equal(out.packageId, 'brrainz.zombieland');
    assert.equal(out.packageIdLc, 'brrainz.zombieland');
    assert.equal(out.modDependencies.length, 1);
    assert.equal(out.modDependencies[0].packageIdLc, 'brrainz.harmony');
  });

  it('normalizes "1.5.0" to "1.5"', () => {
    const xml = `<ModMetaData>
  <supportedVersions>
    <li>1.5.0</li>
    <li>1.6</li>
  </supportedVersions>
</ModMetaData>`;
    const out = parseAboutXml(xml);
    assert.deepEqual(out.supportedVersions, ['1.5', '1.6']);
  });
});
