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
