# Patch apparel and materials (stuff) for Combat Extended

> **Reference** — see `overview.md` for the verification date and the
> values-drift caveat. All armor *numbers* below are placeholders — pull real
> values from the CE balance spreadsheet.

## Materials (stuff) — patch once, reuse everywhere

CE armor for stuff-made items derives from stats on the material def itself,
so patching the material once means every item made from it inherits sensible
armor — this is the "patch once" payoff. The fields all live in the material's
`<statBases>`:

```xml
<Operation Class="PatchOperationAdd">
  <xpath>Defs/ThingDef[defName="YourMaterial"]/statBases</xpath>
  <value>
    <StuffPower_Armor_Sharp>0.05</StuffPower_Armor_Sharp>
    <StuffPower_Armor_Blunt>0.04</StuffPower_Armor_Blunt>
    <Bulk>0.05</Bulk>
  </value>
</Operation>
```

`StuffPower_Armor_Sharp` / `_Blunt` are how much the material contributes to
the armor of items made from it; `<Bulk>` is the per-unit volume CE uses for
carry weight. Vanilla materials already declare `StuffPower_Armor_*`, so CE
itself uses `PatchOperationReplace` on `.../statBases/StuffPower_Armor_Sharp`
for those — use `Add` (as above) only for a new modded material that omits
them, `Replace` if it already has them.

Add the material to the relevant CE stuff categories (`<li>Metallic_Weapon</li>`,
`<li>Steeled</li>`, etc.) so CE recipes and balance treat it correctly.

## Apparel — explicit armor + optional partial coverage

For apparel, set the CE armor ratings directly (sharp and blunt, mm RHA) and
the thickness multiplier:

```xml
<Operation Class="PatchOperationAdd">
  <xpath>/Defs/ThingDef[defName="YourArmor"]/statBases</xpath>
  <value>
    <ArmorRating_Sharp>16</ArmorRating_Sharp>
    <ArmorRating_Blunt>34</ArmorRating_Blunt>
    <StuffEffectMultiplierArmor>5</StuffEffectMultiplierArmor>
    <Bulk>10</Bulk>
  </value>
</Operation>
```

For armor that protects some body parts differently from others, use the
`PartialArmorExt` mod extension (it goes in the apparel def's
`<modExtensions>`). Each `<stats>` entry is one `<li>` holding a single
`ArmorRating_Sharp` or `ArmorRating_Blunt` value plus a flat `<parts>` list of
body-part defNames — use two `<li>`s to set both sharp and blunt for the same
parts:

```xml
<li Class="CombatExtended.PartialArmorExt">
  <stats>
    <li>
      <ArmorRating_Sharp>2.5</ArmorRating_Sharp>
      <parts>
        <li>Eye</li>
        <li>Nose</li>
        <li>Jaw</li>
      </parts>
    </li>
    <li>
      <ArmorRating_Blunt>5</ArmorRating_Blunt>
      <parts>
        <li>Eye</li>
        <li>Nose</li>
        <li>Jaw</li>
      </parts>
    </li>
  </stats>
</li>
```

## Gotchas

- **`PartialArmorExt` entries are per-part `ArmorRating_*` values, not
  multipliers** — each `<li>` is one armor number plus the body parts it
  applies to; there is no `<mult>` or `<key>`/`<part>` field. Copy the numbers
  from a comparable CE apparel patch rather than guessing the scale.
- **Apparel sometimes works unpatched.** If a vanilla armor's sharp/blunt
  values happen to land near CE's curve, CE uses them as-is and the item is
  "good enough." The guide explicitly notes the difference is often small —
  so for a minor apparel item, test before assuming a patch is mandatory.
- Patch the **material**, not each item, whenever items share stuff — see the
  Materials section above. Re-specifying armor per item is the common mistake.
