# Patch pawns, animals, and turrets for Combat Extended

> **Reference** — see `overview.md` for the verification date and the
> values-drift caveat. Durability/penetration *numbers* are placeholders —
> pull real values from the CE balance spreadsheet.

## Pawns and animals

Anything that fights needs two CE comps and, if it attacks unarmed, CE-style
natural tools.

**Natural armor durability** — armor on a creature degrades and (optionally)
regenerates:

```xml
<Operation Class="PatchOperationAdd">
  <xpath>/Defs/ThingDef[defName="YourCreature"]/comps</xpath>
  <value>
    <li Class="CombatExtended.CompProperties_ArmorDurability">
      <Durability>500</Durability>
      <Regenerates>true</Regenerates>
      <RegenInterval>600</RegenInterval>
    </li>
  </value>
</Operation>
```

**Suppression** — without `CompProperties_Suppressable` the pawn never reacts
to incoming fire (no cover-seeking, no suppression pinning), which makes it
feel broken under CE:

```xml
<li Class="CombatExtended.CompProperties_Suppressable" />
```

**Unarmed tools** — replace the creature's melee `<tools>` with `ToolCE`
entries (same shape as `melee-weapons.md`), giving fists/claws/teeth real
penetration:

```xml
<li Class="CombatExtended.ToolCE">
  <label>fist</label>
  <capacities><li>Blunt</li></capacities>
  <power>8</power>
  <cooldownTime>2</cooldownTime>
  <armorPenetrationBlunt>0.5</armorPenetrationBlunt>
  <linkedBodyPartsGroup>HandsCE</linkedBodyPartsGroup>
</li>
```

## Turrets

Swap the turret's `thingClass` to the CE turret class and check its height:

```xml
<Operation Class="PatchOperationReplace">
  <xpath>/Defs/ThingDef[defName="YourTurret"]/thingClass</xpath>
  <value><thingClass>CombatExtended.Building_TurretGunCE</thingClass></value>
</Operation>
```

The turret's gun def also needs the ranged-weapon treatment — see
`ranged-weapons.md` — since a CE turret fires through the CE verb/ammo system.

## Gotchas

- **A very short turret may not fire over walls or embrasures.** CE's
  cover/line-of-fire geometry factors in turret height (`fillPercent`); CE's
  own turrets sit at `fillPercent` 0.85–1. Lower it too far for aesthetics and
  the turret can end up unable to shoot out from behind cover. There is no
  documented hard cutoff — test behind an embrasure rather than trusting a
  specific number.
- **Forgetting `CompProperties_Suppressable` is the silent one** — the pawn
  still works, still fights, but stands in the open getting shot because CE's
  AI suppression hooks have nothing to read. Easy to miss because nothing
  errors.
- `Durability` on `CompProperties_ArmorDurability` is per-armor-layer wear,
  not hit points — a high value means armor lasts many fights, not that the
  creature is tankier per hit.
