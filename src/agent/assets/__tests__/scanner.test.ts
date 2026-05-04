import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import { scanAssets } from '../scanner.js';
import type { TextureSpec } from '../types.js';

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
    // Gizmo icon for the auto-prioritize button
    static readonly Texture2D Icon =
      ContentFinder<Texture2D>.Get("UI/SmartPriorities/AutoPrioritize");
  }
}`,
      );
      const scan = await scanAssets(mod);
      const req = scan.requirements.find(
        (r) => r.path === 'Textures/UI/SmartPriorities/AutoPrioritize.png',
      );
      assert.ok(req, 'expected texture requirement from ContentFinder');
      assert.equal(req.kind, 'texture');
      assert.equal(req.referencedBy[0].defType, 'C#');
      assert.equal(req.referencedBy[0].defName, 'AutoPrioritizeButton');
      assert.match(req.referencedBy[0].field, /ContentFinder<Texture2D>/);
      assert.equal(req.referencedBy[0].sourceFile, 'Source/Gizmo.cs');
      assert.equal(req.notes[0], 'Gizmo icon for the auto-prioritize button');
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
      const scan = await scanAssets(mod);
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
      <!-- Long fur parka, directional sprites -->
      <wornGraphicPath>Things/Pawn/MyParka/MyParka</wornGraphicPath>
    </apparel>
  </ThingDef>
</Defs>`,
      );
      const scan = await scanAssets(mod);
      const paths = scan.requirements.map((r) => r.path).sort();
      assert.deepEqual(paths, [
        'Textures/Things/Pawn/MyParka/MyParka_east.png',
        'Textures/Things/Pawn/MyParka/MyParka_north.png',
        'Textures/Things/Pawn/MyParka/MyParka_south.png',
      ]);
      const req = scan.requirements[0];
      const spec = req.spec as TextureSpec;
      assert.equal(spec.acceptsMask, true);
      assert.match(spec.description, /apparel/i);
      assert.equal(req.notes[0], 'Long fur parka, directional sprites');
    } finally {
      await cleanup(mod);
    }
  });

  it('honors LoadFolders.xml and resolves assets across content roots', async () => {
    const mod = await fsp.mkdtemp(path.join(os.tmpdir(), 'modmixer-scanner-lf-'));
    try {
      // Layout: defs live under Common/Defs (per LoadFolders), one texture sits
      // at the mod root and another sits under Common/. Both should resolve.
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
      // Real PNG (8-byte signature + IHDR + IEND is enough for the sniffer).
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

      const scan = await scanAssets(mod, '1.6');
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
      const scan = await scanAssets(mod);
      const paths = scan.requirements.map((r) => r.path).sort();
      assert.deepEqual(paths, [
        'Textures/Apparel/FeatheredHeaddress/FeatheredHeaddress_east.png',
        'Textures/Apparel/FeatheredHeaddress/FeatheredHeaddress_north.png',
        'Textures/Apparel/FeatheredHeaddress/FeatheredHeaddress_south.png',
      ]);
      // No phantom <base>.png ref — RimWorld would never load it.
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
      // Drop body-typed files on disk: Male/Female × north/south/east.
      const dir = path.join(mod, 'Textures', 'Apparel', 'CarnivalBodysuit');
      await fsp.mkdir(dir, { recursive: true });
      const png = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
        0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0,
        0x1f, 0x15, 0xc4, 0x89,
      ]);
      // The Graphic_Single icon at the base path.
      await fsp.writeFile(path.join(dir, 'CarnivalBodysuit.png'), png);
      for (const body of ['Male', 'Female']) {
        for (const dirSuffix of ['north', 'south', 'east']) {
          await fsp.writeFile(
            path.join(dir, `CarnivalBodysuit_${body}_${dirSuffix}.png`),
            png,
          );
        }
      }
      const scan = await scanAssets(mod);
      const paths = scan.requirements.map((r) => r.path).sort();
      // We should have the icon plus the 6 body-typed worn sprites — no phantom
      // plain `_north/_south/_east` paths the def never asked for.
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
      const scan = await scanAssets(mod);
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
});
