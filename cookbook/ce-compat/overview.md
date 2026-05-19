# Does this content need a Combat Extended patch? + LoadFolders setup

> **Reference** — distilled from the Combat Extended *Compatibility Patch Guide*
> (github.com/CombatExtended-Continued/CombatExtended wiki), verified against
> CE for RimWorld 1.6 on 2026-05-19. The *structure* below (operation classes,
> folder layout, gotchas) is stable; the *stat values* are not — CE rebalances
> them every release. For numbers, use the CE balance spreadsheets linked from
> the wiki, not hardcoded guesses.

## Why CE needs patches at all

Combat Extended replaces RimWorld's percentage-based combat with a physics-ish
model: armor is millimetres of Rolled Homogenous Armor (RHA), weapons have
armor penetration measured in the same unit, ammo is a real inventory item,
and bulk/weight affect carrying. Vanilla defs carry none of those fields, so
any mod that adds combat-relevant content needs its defs *patched* to add
them — otherwise CE either ignores the content or treats it as zero-armor /
zero-penetration.

## Scope: what needs a patch

Rule of thumb from the guide: **if it attacks or gets attacked, it likely
needs a patch.** Concretely:

- Apparel and the *materials* (stuff) it can be made from → armor stats.
- Melee weapons → `ToolCE` tools with armor penetration.
- Ranged weapons → magazine, ammo set, recoil, fire modes.
- Turrets → CE turret thingClass.
- Pawns/animals (anything that fights) → armor + suppression comps, unarmed tools.
- New ammo → an `AmmoSetDef`.

Pure-cosmetic content, non-combat buildings, pure-XML stat tweaks unrelated to
combat → usually no patch needed. Psycasts and other exotic mechanics are
case-by-case.

Before writing anything: check whether a patch *already exists*. CE ships
patches for many popular mods, and the modding community maintains separate
compatibility patch mods. Duplicating one causes def-conflict errors.

## The LoadFolders overwrite quirk (read this before choosing file paths)

CE patches are loaded via the `LoadFolders` system. **Files with the same
relative path overwrite each other** across loaded folders — so if your patch
file sits at `Patches/Weapons.xml` and another mod (or CE itself) also has
`Patches/Weapons.xml`, one silently clobbers the other.

The fix has two parts.

**1. Put the CE patch in a redundant nested folder** named after your mod, so
its path is globally unique:

```
ModPatches/<YourModName>/Patches/<YourModName>/YourPatch.xml
```

The doubled `<YourModName>` looks wrong but is intentional: RimWorld keys patch
files by their path *relative to a `Patches/` dir*, so nesting your mod name
inside `Patches/` makes that relative path collision-proof.

**2. Register that folder in a `LoadFolders.xml`** at your mod root — and gate
it on CE being active:

```xml
<?xml version="1.0" encoding="utf-8"?>
<loadFolders>
  <v1.5>
    <li>/</li>
    <li IfModActive="CETeam.CombatExtended">ModPatches/<YourModName></li>
  </v1.5>
  <v1.6>
    <li>/</li>
    <li IfModActive="CETeam.CombatExtended">ModPatches/<YourModName></li>
  </v1.6>
</loadFolders>
```

Two things here are mandatory, not optional:

- **`IfModActive="CETeam.CombatExtended"` on the `ModPatches/...` entry.** Your
  CE patch references `CombatExtended.*` classes (`ToolCE`, `CompProperties_*`,
  etc.). If that folder loads when CE is *not* installed, those classes don't
  exist — the patch errors and the defs it touches break for every non-CE
  player. The gate makes the patch load *only* alongside CE.
  `CETeam.CombatExtended` is CE's packageId. (An older alternative is wrapping
  each operation in `PatchOperationFindMod`; if you use `LoadFolders`, gate it
  here instead and don't do both.)
- **The `<li>/</li>` entry.** Once a `LoadFolders.xml` exists, RimWorld loads
  *only* the folders it lists — it stops auto-loading your mod's own `Defs/`,
  `Patches/`, `Textures/`, etc. `<li>/</li>` re-includes the mod root so your
  base content still loads. Omit it and the whole mod goes dark.

Add one `<vX.Y>` block per entry in your `About.xml` `<supportedVersions>`.

## General principles

- **Compact**: prefer wildcard XPath over per-defName operations where the
  same change applies to many defs (see `[[patches]]` lore).
- **Preserve balance**: a CE patch should make the content *work* under CE,
  not rebalance it. Pull numbers from the CE spreadsheets so your content sits
  on the same curve as CE's own.
- **Reusable**: patch materials once and apparel made from them inherits the
  armor; don't re-specify per item.

See the sibling sections for the per-type recipes: `ranged-weapons.md`,
`melee-weapons.md`, `apparel-and-materials.md`, `pawns-and-turrets.md`.
