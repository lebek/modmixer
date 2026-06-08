## PreceptDef random-generation uses defaultSelectionWeight, NOT selectionWeight — defaults to 0

PreceptDef has TWO weight fields and they do different things:

- `selectionWeight` (default 1f) — used by `Precept_Ritual` and a few other narrow code paths, e.g. ritual variant selection.
- `defaultSelectionWeight` (default **0f**) — used by `IdeoFoundation.RandomizePrecepts` for picking ONE precept per IssueDef during random ideoligion generation.

If your custom precept omits `defaultSelectionWeight`, it has weight 0 and `TryRandomElementByWeight` skips it — your precept is **never picked** in random ideo generation. The player can still add it manually in the ideoligion editor (because the editor lists all valid precepts unconditionally), which is why this bug looks like "works in the editor, missing from generated ideos."

Fix: every PreceptDef that should appear in random ideos needs `<defaultSelectionWeight>1</defaultSelectionWeight>` (or higher to weight it more).

*Why it's tricky:* the field name `selectionWeight` is the obvious one to set, and it's the one that exists by default value 1f, so things "look right." The generator quietly skips your precept and the player only notices "this precept never shows up in random ideos." Search target if you hit this: `RandomizePrecepts` in `IdeoFoundation.cs` line ~214 — the `.TryRandomElementByWeight((PreceptDef x) => x.defaultSelectionWeight, ...)` call is the smoking gun.

## Hide a ritual QualityFactor row when it doesn't apply: override Applies AND GetQualityFactor

A `RitualOutcomeComp_Quality` subclass needs TWO methods to fully hide itself from both the runtime quality math AND the ritual-preview UI when its precondition isn't met:

- `public override bool Applies(LordJob_Ritual ritual)` — return false to skip the comp during ritual execution. `RitualOutcomeEffectWorker_FromQuality` (and Bestowing) guards every comp use with `comp is RitualOutcomeComp_Quality && comp.Applies(jobRitual)`.
- `public override QualityFactor GetQualityFactor(Precept_Ritual ritual, ...)` — return null to omit the row from the dialog that previews the ritual (e.g. `Dialog_BeginLordJob` filters with `if (qualityFactor == null) continue;`).

If you only override one, you get a half-fix: the comp still influences quality at runtime OR the preview still lists the row with a 0 value.

*Why it's tricky:* the base `Applies` returns `true` unconditionally on `RitualOutcomeComp_Quality`, and `QualityOffset` is called without consulting `Applies` from inside the base class — `Applies` is a higher-level gate the worker uses to decide whether to call this comp at all. Returning null from `Count` doesn't help (it's a float). Returning null from `GetQualityFactor` is safe and is the vanilla pattern (`RitualOutcomeComp_PawnAge` does this).
