import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import { scanAssets } from '../scanner.js';
import { clearVanillaPathIndexCache } from '../vanilla-paths.js';

async function makeTmpMod(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'modmixer-scanner-'));
  await fsp.mkdir(path.join(dir, 'Defs'), { recursive: true });
  await fsp.mkdir(path.join(dir, 'Source'), { recursive: true });
  return dir;
}

async function cleanup(dir: string): Promise<void> {
  await fsp.rm(dir, { recursive: true, force: true });
}

describe('scanAssets', () => {
  it('emits slots from the cs-assets manifest', async () => {
    const mod = await makeTmpMod();
    try {
      await fsp.mkdir(path.join(mod, '.modmixer'), { recursive: true });
      await fsp.writeFile(
        path.join(mod, '.modmixer', 'cs-assets.json'),
        JSON.stringify({
          textures: ['UI/SmartPriorities/AutoPrioritize'],
          audio: ['MyMod/Click'],
        }),
      );
      // .cs file with a literal that matches the manifest — drift-check is silent.
      await fsp.writeFile(
        path.join(mod, 'Source', 'Gizmo.cs'),
        `class AutoPrioritizeButton {
  static readonly Texture2D Icon =
    ContentFinder<Texture2D>.Get("UI/SmartPriorities/AutoPrioritize");
  void Use() { ContentFinder<AudioClip>.Get("MyMod/Click"); }
}`,
      );
      const scan = await scanAssets(mod, null, null);
      const tex = scan.requirements.find(
        (r) => r.path === 'Textures/UI/SmartPriorities/AutoPrioritize.png',
      );
      const aud = scan.requirements.find(
        (r) => r.path === 'Sounds/MyMod/Click.ogg',
      );
      assert.ok(tex && aud, 'expected one slot per manifest entry');
      assert.equal(tex.ref.defType, 'C#');
      assert.equal(tex.ref.sourceFile, '.modmixer/cs-assets.json');
      assert.equal(tex.ref.defName, 'AutoPrioritize');
      assert.equal(scan.warnings.length, 0, 'no drift warnings when manifest matches code');
    } finally {
      await cleanup(mod);
    }
  });

  it('drift-warns when a .cs literal is missing from the manifest', async () => {
    const mod = await makeTmpMod();
    try {
      await fsp.mkdir(path.join(mod, '.modmixer'), { recursive: true });
      // Manifest declares one path, code uses two.
      await fsp.writeFile(
        path.join(mod, '.modmixer', 'cs-assets.json'),
        JSON.stringify({ textures: ['UI/Declared'], audio: [] }),
      );
      await fsp.writeFile(
        path.join(mod, 'Source', 'Gizmo.cs'),
        `class X {
  static readonly Texture2D A = ContentFinder<Texture2D>.Get("UI/Declared");
  static readonly Texture2D B = ContentFinder<Texture2D>.Get("UI/Undeclared");
}`,
      );
      const scan = await scanAssets(mod, null, null);
      assert.equal(scan.requirements.length, 1, 'only the declared path becomes a slot');
      assert.ok(
        scan.warnings.some((w) => w.includes('UI/Undeclared')),
        `expected a drift warning about UI/Undeclared, got: ${JSON.stringify(scan.warnings)}`,
      );
    } finally {
      await cleanup(mod);
    }
  });

  it('drift-warns when manifest declares a path no .cs literal matches', async () => {
    const mod = await makeTmpMod();
    try {
      await fsp.mkdir(path.join(mod, '.modmixer'), { recursive: true });
      await fsp.writeFile(
        path.join(mod, '.modmixer', 'cs-assets.json'),
        JSON.stringify({ textures: ['UI/Orphan'], audio: [] }),
      );
      // .cs uses a const — no literal in code matches the manifest entry by
      // string search. Manifest still emits the slot (correct), but drift
      // warns the agent to confirm.
      await fsp.writeFile(
        path.join(mod, 'Source', 'Gizmo.cs'),
        `class X {
  const string OrphanPath = "UI/Orphan";
  static readonly Texture2D A = ContentFinder<Texture2D>.Get(OrphanPath);
}`,
      );
      const scan = await scanAssets(mod, null, null);
      assert.equal(scan.requirements.length, 1, 'slot still emitted from manifest');
      assert.ok(
        scan.warnings.some((w) => w.includes('UI/Orphan') && w.includes('declared')),
        `expected an "orphan manifest entry" drift warning, got: ${JSON.stringify(scan.warnings)}`,
      );
    } finally {
      await cleanup(mod);
    }
  });

  it('expands wornGraphicPath into north/south/east directional sprites', async () => {
    const mod = await makeTmpMod();
    try {
      await fsp.writeFile(
        path.join(mod, 'Defs', 'Apparel.xml'),
        `<?xml version="1.0" encoding="utf-8" ?>
<Defs>
  <ThingDef ParentName="ApparelBase">
    <defName>MyParka</defName>
    <apparel>
      <wornGraphicPath>Things/Pawn/MyParka/MyParka</wornGraphicPath>
    </apparel>
  </ThingDef>
</Defs>`,
      );
      const scan = await scanAssets(mod, null, null);
      const paths = scan.requirements.map((r) => r.path).sort();
      assert.deepEqual(paths, [
        'Textures/Things/Pawn/MyParka/MyParka_east.png',
        'Textures/Things/Pawn/MyParka/MyParka_north.png',
        'Textures/Things/Pawn/MyParka/MyParka_south.png',
      ]);
      // All three directional refs share the same sourceStem (the base path
      // the modder wrote) — fork rewrites need that base to find the right
      // text to replace.
      for (const r of scan.requirements) {
        assert.equal(r.ref.sourceStem, 'Things/Pawn/MyParka/MyParka');
      }
    } finally {
      await cleanup(mod);
    }
  });

  it('honors LoadFolders.xml and resolves assets across content roots', async () => {
    const mod = await fsp.mkdtemp(path.join(os.tmpdir(), 'modmixer-scanner-lf-'));
    try {
      await fsp.writeFile(
        path.join(mod, 'LoadFolders.xml'),
        `<?xml version="1.0" encoding="utf-8"?>
<loadFolders>
  <v1.6>
    <li>/</li>
    <li>Common</li>
  </v1.6>
</loadFolders>`,
      );
      await fsp.mkdir(path.join(mod, 'Common', 'Defs'), { recursive: true });
      await fsp.writeFile(
        path.join(mod, 'Common', 'Defs', 'Things.xml'),
        `<?xml version="1.0" encoding="utf-8" ?>
<Defs>
  <ThingDef>
    <defName>RootItem</defName>
    <graphicData><texPath>Carnival/Item/Mango</texPath></graphicData>
  </ThingDef>
  <ThingDef>
    <defName>CommonItem</defName>
    <graphicData><texPath>Carnival/Item/Drum</texPath></graphicData>
  </ThingDef>
</Defs>`,
      );
      const pngBytes = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
        0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0,
        0x1f, 0x15, 0xc4, 0x89,
      ]);
      await fsp.mkdir(path.join(mod, 'Textures', 'Carnival', 'Item'), {
        recursive: true,
      });
      await fsp.writeFile(
        path.join(mod, 'Textures', 'Carnival', 'Item', 'Mango.png'),
        pngBytes,
      );
      await fsp.mkdir(path.join(mod, 'Common', 'Textures', 'Carnival', 'Item'), {
        recursive: true,
      });
      await fsp.writeFile(
        path.join(mod, 'Common', 'Textures', 'Carnival', 'Item', 'Drum.png'),
        pngBytes,
      );

      const scan = await scanAssets(mod, '1.6', null);
      const byPath = new Map(scan.requirements.map((r) => [r.path, r]));
      const mango = byPath.get('Textures/Carnival/Item/Mango.png');
      const drum = byPath.get('Common/Textures/Carnival/Item/Drum.png');
      assert.ok(mango, 'expected mod-root texture to be resolved');
      assert.ok(drum, 'expected Common/ texture to be resolved');
      assert.equal(mango.status, 'present');
      assert.equal(drum.status, 'present');
    } finally {
      await cleanup(mod);
    }
  });

  it('treats Graphic_Multi graphicData as directional (not a single base file)', async () => {
    const mod = await makeTmpMod();
    try {
      await fsp.writeFile(
        path.join(mod, 'Defs', 'Headdress.xml'),
        `<?xml version="1.0" encoding="utf-8" ?>
<Defs>
  <ThingDef>
    <defName>FeatheredHeaddress</defName>
    <graphicData>
      <texPath>Apparel/FeatheredHeaddress/FeatheredHeaddress</texPath>
      <graphicClass>Graphic_Multi</graphicClass>
    </graphicData>
  </ThingDef>
</Defs>`,
      );
      const scan = await scanAssets(mod, null, null);
      const paths = scan.requirements.map((r) => r.path).sort();
      assert.deepEqual(paths, [
        'Textures/Apparel/FeatheredHeaddress/FeatheredHeaddress_east.png',
        'Textures/Apparel/FeatheredHeaddress/FeatheredHeaddress_north.png',
        'Textures/Apparel/FeatheredHeaddress/FeatheredHeaddress_south.png',
      ]);
      assert.ok(
        !paths.includes('Textures/Apparel/FeatheredHeaddress/FeatheredHeaddress.png'),
      );
    } finally {
      await cleanup(mod);
    }
  });

  it('uses on-disk body-typed files for body-conforming wornGraphicPath', async () => {
    const mod = await makeTmpMod();
    try {
      await fsp.writeFile(
        path.join(mod, 'Defs', 'Bodysuit.xml'),
        `<?xml version="1.0" encoding="utf-8" ?>
<Defs>
  <ThingDef>
    <defName>CarnivalBodysuit</defName>
    <graphicData>
      <texPath>Apparel/CarnivalBodysuit/CarnivalBodysuit</texPath>
      <graphicClass>Graphic_Single</graphicClass>
    </graphicData>
    <apparel>
      <wornGraphicPath>Apparel/CarnivalBodysuit/CarnivalBodysuit</wornGraphicPath>
    </apparel>
  </ThingDef>
</Defs>`,
      );
      const dir = path.join(mod, 'Textures', 'Apparel', 'CarnivalBodysuit');
      await fsp.mkdir(dir, { recursive: true });
      const png = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
        0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0,
        0x1f, 0x15, 0xc4, 0x89,
      ]);
      await fsp.writeFile(path.join(dir, 'CarnivalBodysuit.png'), png);
      for (const body of ['Male', 'Female']) {
        for (const dirSuffix of ['north', 'south', 'east']) {
          await fsp.writeFile(
            path.join(dir, `CarnivalBodysuit_${body}_${dirSuffix}.png`),
            png,
          );
        }
      }
      const scan = await scanAssets(mod, null, null);
      const paths = scan.requirements.map((r) => r.path).sort();
      assert.deepEqual(paths, [
        'Textures/Apparel/CarnivalBodysuit/CarnivalBodysuit.png',
        'Textures/Apparel/CarnivalBodysuit/CarnivalBodysuit_Female_east.png',
        'Textures/Apparel/CarnivalBodysuit/CarnivalBodysuit_Female_north.png',
        'Textures/Apparel/CarnivalBodysuit/CarnivalBodysuit_Female_south.png',
        'Textures/Apparel/CarnivalBodysuit/CarnivalBodysuit_Male_east.png',
        'Textures/Apparel/CarnivalBodysuit/CarnivalBodysuit_Male_north.png',
        'Textures/Apparel/CarnivalBodysuit/CarnivalBodysuit_Male_south.png',
      ]);
      for (const r of scan.requirements) assert.equal(r.status, 'present');
    } finally {
      await cleanup(mod);
    }
  });

  it('still picks up the existing texPath / uiIconPath / clipPath patterns', async () => {
    const mod = await makeTmpMod();
    try {
      await fsp.writeFile(
        path.join(mod, 'Defs', 'Things.xml'),
        `<?xml version="1.0" encoding="utf-8" ?>
<Defs>
  <ThingDef>
    <defName>MyItem</defName>
    <graphicData>
      <texPath>Things/Item/MyItem</texPath>
    </graphicData>
    <uiIconPath>UI/MyItemIcon</uiIconPath>
  </ThingDef>
  <SoundDef>
    <defName>MySound</defName>
    <clipPath>MyMod/Boom</clipPath>
  </SoundDef>
</Defs>`,
      );
      const scan = await scanAssets(mod, null, null);
      const paths = scan.requirements.map((r) => r.path).sort();
      assert.deepEqual(paths, [
        'Sounds/MyMod/Boom.ogg',
        'Textures/Things/Item/MyItem.png',
        'Textures/UI/MyItemIcon.png',
      ]);
    } finally {
      await cleanup(mod);
    }
  });

  it('emits separate slots per def when two defs reference the same path', async () => {
    const mod = await makeTmpMod();
    try {
      await fsp.writeFile(
        path.join(mod, 'Defs', 'Things.xml'),
        `<?xml version="1.0" encoding="utf-8" ?>
<Defs>
  <ThingDef>
    <defName>Sword</defName>
    <graphicData><texPath>Things/Item/Blade</texPath></graphicData>
  </ThingDef>
  <ThingDef>
    <defName>Dagger</defName>
    <graphicData><texPath>Things/Item/Blade</texPath></graphicData>
  </ThingDef>
</Defs>`,
      );
      const scan = await scanAssets(mod, null, null);
      const sharing = scan.requirements.filter(
        (r) => r.path === 'Textures/Things/Item/Blade.png',
      );
      assert.equal(sharing.length, 2, 'expected one slot per def, not a single grouped slot');
      const defNames = sharing.map((r) => r.ref.defName).sort();
      assert.deepEqual(defNames, ['Dagger', 'Sword']);
      // Distinct ids per slot — token offsets differ.
      assert.notEqual(sharing[0].id, sharing[1].id);
    } finally {
      await cleanup(mod);
    }
  });

  it('detects a vanilla path by scanning vanilla def XMLs', async () => {
    const mod = await makeTmpMod();
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'modmixer-scanner-data-'));
    try {
      // Reset the in-process cache so this test's fake dataDir gets re-scanned.
      clearVanillaPathIndexCache();
      // Fake Core pack with a loose def XML that references a texture.
      // RimWorld bundles the actual PNG into Unity archives, so we mimic only
      // the def — the scanner builds its vanilla manifest from these XMLs.
      const coreDefsDir = path.join(dataDir, 'Core', 'Defs', 'ThingDefs');
      await fsp.mkdir(coreDefsDir, { recursive: true });
      await fsp.writeFile(
        path.join(coreDefsDir, 'VanillaThing.xml'),
        `<?xml version="1.0" encoding="utf-8" ?>
<Defs>
  <ThingDef>
    <defName>VanillaThing</defName>
    <graphicData><texPath>Things/Item/VanillaThing</texPath></graphicData>
  </ThingDef>
</Defs>`,
      );

      await fsp.writeFile(
        path.join(mod, 'Defs', 'Reskin.xml'),
        `<?xml version="1.0" encoding="utf-8" ?>
<Defs>
  <ThingDef>
    <defName>Reskin</defName>
    <graphicData><texPath>Things/Item/VanillaThing</texPath></graphicData>
  </ThingDef>
</Defs>`,
      );
      const scan = await scanAssets(mod, null, dataDir);
      const req = scan.requirements[0];
      assert.ok(req.vanilla, 'expected vanilla detection to fire');
      assert.equal(req.vanilla.pack, 'Core');
      // Stub should NOT have been written because the path is vanilla.
      assert.equal(req.stubbed, undefined);
      assert.equal(req.status, 'missing');
    } finally {
      clearVanillaPathIndexCache();
      await cleanup(mod);
      await cleanup(dataDir);
    }
  });
});
