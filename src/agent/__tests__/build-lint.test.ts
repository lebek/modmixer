import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { lintMod, formatFindings } from '../build-lint.js';

/**
 * Each test stages a tiny synthetic mod under a tmp dir and runs the lints
 * against it. We only assert on the rule + a substring of the message — the
 * exact wording is allowed to drift.
 */
async function makeTmpMod(): Promise<string> {
  const dir = await fsp.mkdtemp(
    path.join(os.tmpdir(), 'modmixer-build-lint-'),
  );
  await fsp.mkdir(path.join(dir, 'Source'), { recursive: true });
  await fsp.mkdir(path.join(dir, 'Defs'), { recursive: true });
  return dir;
}

async function cleanup(dir: string): Promise<void> {
  await fsp.rm(dir, { recursive: true, force: true });
}

describe('lintMod', () => {
  it('flags a CompTickRare override on a ThingDef without tickerType', async () => {
    const mod = await makeTmpMod();
    try {
      await fsp.writeFile(
        path.join(mod, 'Source', 'Comp.cs'),
        `
using RimWorld;
using Verse;
namespace MyMod {
  public class CompProperties_MyComp : CompProperties {
    public CompProperties_MyComp() { compClass = typeof(CompMyComp); }
  }
  public class CompMyComp : ThingComp {
    public override void CompTickRare() { /* never fires without tickerType */ }
  }
}`,
      );
      await fsp.writeFile(
        path.join(mod, 'Defs', 'Things.xml'),
        `<?xml version="1.0" encoding="utf-8" ?>
<Defs>
  <ThingDef ParentName="BuildingBase">
    <defName>MyThing</defName>
    <thingClass>Building</thingClass>
    <comps>
      <li Class="MyMod.CompProperties_MyComp" />
    </comps>
  </ThingDef>
</Defs>`,
      );
      const findings = await lintMod(mod);
      const ticker = findings.find((f) => f.rule === 'tickerType-missing');
      assert.ok(ticker, 'expected a tickerType-missing finding');
      assert.match(ticker.message, /MyThing/);
      assert.match(ticker.message, /CompTickRare/);
    } finally {
      await cleanup(mod);
    }
  });

  it('does not flag when tickerType is set to Rare', async () => {
    const mod = await makeTmpMod();
    try {
      await fsp.writeFile(
        path.join(mod, 'Source', 'Comp.cs'),
        `
public class CompProperties_MyComp : CompProperties {
  public CompProperties_MyComp() { compClass = typeof(CompMyComp); }
}
public class CompMyComp : ThingComp {
  public override void CompTickRare() { }
}`,
      );
      await fsp.writeFile(
        path.join(mod, 'Defs', 'Things.xml'),
        `<?xml version="1.0" encoding="utf-8" ?>
<Defs>
  <ThingDef>
    <defName>MyThing</defName>
    <tickerType>Rare</tickerType>
    <comps>
      <li Class="CompProperties_MyComp" />
    </comps>
  </ThingDef>
</Defs>`,
      );
      const findings = await lintMod(mod);
      assert.equal(
        findings.filter((f) => f.rule === 'tickerType-missing').length,
        0,
      );
    } finally {
      await cleanup(mod);
    }
  });

  it('does not flag a comp that does not override CompTick / CompTickRare', async () => {
    const mod = await makeTmpMod();
    try {
      await fsp.writeFile(
        path.join(mod, 'Source', 'Comp.cs'),
        `
public class CompProperties_DrawOnly : CompProperties {
  public CompProperties_DrawOnly() { compClass = typeof(CompDrawOnly); }
}
public class CompDrawOnly : ThingComp {
  public override void PostDraw() { }
}`,
      );
      await fsp.writeFile(
        path.join(mod, 'Defs', 'Things.xml'),
        `<?xml version="1.0" encoding="utf-8" ?>
<Defs>
  <ThingDef>
    <defName>DrawThing</defName>
    <comps>
      <li Class="CompProperties_DrawOnly" />
    </comps>
  </ThingDef>
</Defs>`,
      );
      const findings = await lintMod(mod);
      assert.equal(
        findings.filter((f) => f.rule === 'tickerType-missing').length,
        0,
      );
    } finally {
      await cleanup(mod);
    }
  });

  it('flags a netstandard2.0 csproj target framework', async () => {
    const mod = await makeTmpMod();
    try {
      await fsp.writeFile(
        path.join(mod, 'Source', 'MyMod.csproj'),
        `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>netstandard2.0</TargetFramework>
  </PropertyGroup>
</Project>`,
      );
      const findings = await lintMod(mod);
      const tfm = findings.find((f) => f.rule === 'wrong-target-framework');
      assert.ok(tfm, 'expected a wrong-target-framework finding');
      assert.match(tfm.message, /netstandard2\.0/);
      assert.match(tfm.message, /net472/);
    } finally {
      await cleanup(mod);
    }
  });

  it('does not flag a net472 csproj', async () => {
    const mod = await makeTmpMod();
    try {
      await fsp.writeFile(
        path.join(mod, 'Source', 'MyMod.csproj'),
        `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net472</TargetFramework>
  </PropertyGroup>
</Project>`,
      );
      const findings = await lintMod(mod);
      assert.equal(
        findings.filter((f) => f.rule === 'wrong-target-framework').length,
        0,
      );
    } finally {
      await cleanup(mod);
    }
  });

  it('returns an empty list for an empty mod', async () => {
    const mod = await makeTmpMod();
    try {
      const findings = await lintMod(mod);
      assert.deepEqual(findings, []);
    } finally {
      await cleanup(mod);
    }
  });

  it('does not flag abstract ThingDefs missing tickerType', async () => {
    const mod = await makeTmpMod();
    try {
      await fsp.writeFile(
        path.join(mod, 'Source', 'Comp.cs'),
        `
public class CompProperties_MyComp : CompProperties {
  public CompProperties_MyComp() { compClass = typeof(CompMyComp); }
}
public class CompMyComp : ThingComp {
  public override void CompTickRare() { }
}`,
      );
      await fsp.writeFile(
        path.join(mod, 'Defs', 'Things.xml'),
        `<?xml version="1.0" encoding="utf-8" ?>
<Defs>
  <ThingDef Name="MyAbstractBase" Abstract="True">
    <comps>
      <li Class="CompProperties_MyComp" />
    </comps>
  </ThingDef>
</Defs>`,
      );
      const findings = await lintMod(mod);
      assert.equal(
        findings.filter((f) => f.rule === 'tickerType-missing').length,
        0,
      );
    } finally {
      await cleanup(mod);
    }
  });
});

describe('formatFindings', () => {
  it('returns an empty string when there are no findings', () => {
    assert.equal(formatFindings([]), '');
  });

  it('renders findings with file paths and an explanatory footer', () => {
    const text = formatFindings([
      {
        rule: 'tickerType-missing',
        file: 'Defs/Things.xml',
        message: 'add tickerType',
      },
    ]);
    assert.match(text, /modmixer lint/);
    assert.match(text, /Defs\/Things\.xml/);
    assert.match(text, /tickerType-missing/);
    assert.match(text, /non-fatal/i);
  });
});

// Sanity check: make sure the test file itself runs even when the OS tmpdir
// is on a different filesystem than the repo (rare, but tsx --test resolves
// cwd-relative imports differently in CI).
describe('environment', () => {
  it('has access to the tmp dir', () => {
    assert.ok(fs.existsSync(os.tmpdir()));
  });
});
