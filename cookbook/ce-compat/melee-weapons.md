# Patch a melee weapon for Combat Extended

> **Reference** — see `overview.md` for the verification date and the
> values-drift caveat. Penetration/parry *numbers* come from the CE balance
> spreadsheet; the structure below is stable.

## The recipe

CE replaces vanilla melee `<tools>` with `CombatExtended.ToolCE` tools, which
add armor penetration (sharp and blunt, in mm RHA) on top of the vanilla
power/cooldown fields. Replace the weapon's `<tools>` list:

```xml
<Operation Class="PatchOperationReplace">
  <xpath>/Defs/ThingDef[defName="YourMeleeWeapon"]/tools</xpath>
  <value>
    <tools>
      <li Class="CombatExtended.ToolCE">
        <label>edge</label>
        <capacities><li>Cut</li></capacities>
        <power>18</power>
        <cooldownTime>1.55</cooldownTime>
        <armorPenetrationSharp>0.48</armorPenetrationSharp>
        <armorPenetrationBlunt>0.425</armorPenetrationBlunt>
        <linkedBodyPartsGroup>Blade</linkedBodyPartsGroup>
      </li>
      <li Class="CombatExtended.ToolCE">
        <label>handle</label>
        <capacities><li>Blunt</li></capacities>
        <power>9</power>
        <cooldownTime>1.6</cooldownTime>
        <armorPenetrationSharp>0</armorPenetrationSharp>
        <armorPenetrationBlunt>0.62</armorPenetrationBlunt>
        <linkedBodyPartsGroup>Handle</linkedBodyPartsGroup>
      </li>
    </tools>
  </value>
</Operation>
```

Add CE melee stats and weapon tags as well:

```xml
<Operation Class="PatchOperationAdd">
  <xpath>/Defs/ThingDef[defName="YourMeleeWeapon"]/statBases</xpath>
  <value>
    <MeleeCounterParryBonus>0.45</MeleeCounterParryBonus>
    <Bulk>3.5</Bulk>
  </value>
</Operation>
```

`MeleeParryChance` / `MeleeDodgeChance` exist on the wielder, not the weapon —
patch those on pawn/apparel defs, not here.

## Gotchas

- **Every `<li>` in the tools list must be `Class="CombatExtended.ToolCE"`.**
  Mixing a plain vanilla `<li>` (no Class) into a CE tools list means that
  tool has no penetration and quietly underperforms — CE doesn't error, the
  weapon just hits like wet paper against armor.
- **Replace the whole `<tools>` list, don't `Add` into it.** Vanilla tools
  left alongside CE tools double the weapon's attack options. Use
  `PatchOperationReplace` on `.../tools`.
- Stuff-made melee weapons (a knife made of "steel" vs "plasteel") get their
  penetration scaled by the material — make sure the material itself is
  patched too (see `apparel-and-materials.md`).
