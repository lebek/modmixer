import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import { scanAssets } from '../scanner.js';

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
  it('picks up ContentFinder<Texture2D>.Get from C# files', async () => {
    const mod = await makeTmpMod();
    try {
      await fsp.writeFile(
        path.join(mod, 'Source', 'Gizmo.cs'),
        `using UnityEngine;
using Verse;
namespace MyMod {
  public class AutoPrioritizeButton {
    static readonly Texture2D Icon =
      ContentFinder<Texture2D>.Get("UI/SmartPriorities/AutoPrioritize");
  }
}`,
      );
      const scan = await scanAssets(mod, null, null);
      const req = scan.requirements.find(
        (r) => r.path === 'Textures/UI/SmartPriorities/AutoPrioritize.png',
      );
      assert.ok(req, 'expected texture requirement from ContentFinder');
      assert.equal(req.kind, 'texture');
      assert.equal(req.ref.defType, 'C#');
      assert.equal(req.ref.defName, 'AutoPrioritizeButton');
      assert.match(req.ref.field, /ContentFinder<Texture2D>/);
      assert.equal(req.ref.sourceFile, 'Source/Gizmo.cs');
      assert.equal(req.ref.sourceStem, 'UI/SmartPriorities/AutoPrioritize');
    } finally {
      await cleanup(mod);
    }
  });

  it('picks up ContentFinder<AudioClip>.Get as an audio requirement', async () => {
    const mod = await makeTmpMod();
    try {
      await fsp.writeFile(
        path.join(mod, 'Source', 'Sound.cs'),
        `class Foo {
  void Bar() {
    var clip = ContentFinder<AudioClip>.Get("MyMod/Click");
  }
}`,
      );
      const scan = await scanAssets(mod, null, null);
      const req = scan.requirements.find(
        (r) => r.path === 'Sounds/MyMod/Click.ogg',
      );
      assert.ok(req, 'expected audio requirement from ContentFinder');
      assert.equal(req.kind, 'audio');
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

  it('resolves a vanilla fallback when dataDir contains the path', async () => {
    const mod = await makeTmpMod();
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'modmixer-scanner-data-'));
    try {
      // Fake Core pack with one texture under Core/Textures/.
      const corePngDir = path.join(dataDir, 'Core', 'Textures', 'Things', 'Item');
      await fsp.mkdir(corePngDir, { recursive: true });
      await fsp.writeFile(path.join(corePngDir, 'VanillaThing.png'), Buffer.alloc(0));

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
      assert.ok(req.vanilla, 'expected vanilla fallback to resolve');
      assert.equal(req.vanilla.pack, 'Core');
      // Stub should NOT have been written because vanilla resolves.
      assert.equal(req.stubbed, undefined);
      assert.equal(req.status, 'missing');
    } finally {
      await cleanup(mod);
      await cleanup(dataDir);
    }
  });
});
