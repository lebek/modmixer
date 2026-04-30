## Plant `<preferability>RawBad</preferability>` requires Nutrition > 0 — use `NeverForNutrition` for inedible plants

`Config error in Plant_X: Nutrition == 0 but preferability is RawBad instead of NeverForNutrition`. RimWorld validates that any plant whose nutrition is zero must declare `<preferability>NeverForNutrition</preferability>`. `RawBad` is reserved for plants that *are* edible but unappealing. Either set a non-zero `<statBases><Nutrition>...</Nutrition></statBases>` or downgrade preferability.

*Why it's tricky:* `RawBad` reads like "barely food at all" and feels right for a decorative plant — the engine treats it as a stricter contract than the English suggests. The error only fires at game load, never at mod-build time.
