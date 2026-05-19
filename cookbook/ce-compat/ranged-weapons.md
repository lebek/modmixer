# Patch a ranged weapon for Combat Extended

> **Reference** — see `overview.md` for the verification date and the
> values-drift caveat. Pull magazine/recoil/penetration *numbers* from the CE
> balance spreadsheet; the operation shape below is stable.

## The recipe

CE ships a custom patch operation, `CombatExtended.PatchOperationMakeGunCECompatible`,
that does most of the work — it rewrites the weapon's verb into a CE verb and
attaches the CE comps. You supply the CE-specific stats inside it:

```xml
<Operation Class="CombatExtended.PatchOperationMakeGunCECompatible">
  <defName>YourGunDefName</defName>
  <statBases>
    <RangedWeapon_Cooldown>0.37</RangedWeapon_Cooldown>
    <SightsEfficiency>1</SightsEfficiency>
    <ShotSpread>0.07</ShotSpread>
    <SwayFactor>1.38</SwayFactor>
    <Bulk>7.5</Bulk>
    <Mass>3.6</Mass>
  </statBases>
  <Properties>
    <recoilAmount>1.38</recoilAmount>
    <verbClass>CombatExtended.Verb_ShootCE</verbClass>
    <hasStandardCommand>true</hasStandardCommand>
    <ammoConsumedPerShotCount>1</ammoConsumedPerShotCount>
  </Properties>
  <AmmoUser>
    <ammoSet>AmmoSet_762x39mm</ammoSet>
    <magazineSize>30</magazineSize>
    <reloadTime>4.9</reloadTime>
  </AmmoUser>
  <FireModes>
    <aimedBurstShotCount>5</aimedBurstShotCount>
    <aiUseBurstMode>TRUE</aiUseBurstMode>
    <noSingleShot>false</noSingleShot>
  </FireModes>
</Operation>
```

`<ammoSet>` ties the gun to an ammunition family — reuse an existing CE
`AmmoSetDef` (e.g. `AmmoSet_762x39mm`) whenever the gun fires a real-world
caliber CE already models. Only define your own when the caliber is genuinely
new (see `pawns-and-turrets.md` is *not* where ammo lives — a new `AmmoSetDef`
is its own def; the CE wiki's AmmoSet section is the reference).

## Gotchas

- **`PatchOperationMakeGunCECompatible` matches the target by `<defName>`
  only.** It selects `Defs/ThingDef[defName="..."]`, so it will NOT match an
  abstract parent by `Name`, and the weapon def must already be loaded —
  `<loadAfter>` the mod that defines it. When no def matches, CE logs
  `PatchOperationMakeGunCECompatible tried to find def <X> by defName, but it
  doesn't exist`. (The operation creates the `<verbs>` node itself if the
  weapon lacks one and strips the vanilla `Verb_Shoot`/`Verb_LaunchProjectile`
  entry — a missing `<verbs>` is *not* the failure mode; a wrong or unloaded
  defName is.)

- **Omitting `<AmmoUser>` is legal but restrictive.** A gun with no `AmmoUser`
  can't use the ammo system — it just fires its `defaultProjectile` with no
  magazine/reload. Acceptable for a charge weapon or a gimmick gun; wrong for
  anything that should feel like a normal firearm.

- **A new `AmmoSetDef` is a separate def, not part of the weapon patch.** It's
  `<CombatExtended.AmmoSetDef>` with an `<ammoTypes>` block mapping each ammo
  `ThingDef` to the projectile it fires
  (`<Ammo_X_FMJ>Bullet_X_FMJ</Ammo_X_FMJ>`), plus `<similarTo>` pointing at a
  comparable existing AmmoSet. Defining ammo also pulls in new ammo
  ThingDefs, projectiles, and crafting recipes — only do it for a genuinely
  new caliber; reuse a stock CE `AmmoSet_*` whenever the gun fires a
  real-world round CE already models.

- Patch ordering: the CE operation must run after the weapon def exists. If
  the weapon comes from another mod, declare `<loadAfter>` that mod (and CE)
  in About.xml — see `[[compat]]` lore for load-order mechanics.
