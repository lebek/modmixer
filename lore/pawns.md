## When a system refers to colonists by name, use Nick (LabelShort) not NameTriple.First

RimWorld colonists carry a `NameTriple(First, Nick, Last)`. The in-game UI — colonist bar, inspector, letters, chat bubbles — always shows the **Nick**, not the **First**. Vanilla generation often produces pairs like `("Otto", "Crane", "Jacobson")` where the player only ever sees "Crane".

If you're serialising the roster for an LLM, a notification, or any UI string, use `pawn.Name.ToStringShort` (which is `NameTriple.Nick`) or equivalently `pawn.LabelShort`. If you use `NameTriple.First` you'll get names the player doesn't recognise and the system will look like it's hallucinating ("the chat said Otto/Sly/Renata but my colonists are Crane/Jacobson/Steele").

For pawn lookup by name from an external string (LLM output, save file, network), match against Nick FIRST, then fall back to First — be lenient on input since both names exist on the pawn, but always *emit* Nick.

*Why it's tricky:* NameTriple looks like a flat name tuple, and `First` is the obvious thing to reach for. There's no compile-time signal that you've picked the wrong field — the test only fails when a player happens to roll a vanilla pawn whose First differs from their Nick (which is most of them).

## Vanilla trait names in the UI are often degree labels of a spectrum TraitDef, not standalone defs

When the in-game trait label is something like "nervous", "kind", "hard worker", "lazy", "depressive", the *displayed* word is usually one degree of a spectrum `TraitDef` — the defName itself names the spectrum. `nervous` is degree `-1` of `Nerves`. `hard worker` is degree `1` of `Industriousness`. `pessimist` is degree `-1` of `NaturalMood`. The dead giveaway is `[Commander] Unknown TraitDef: Nervous` (or similar) — the user-facing name doesn't resolve through `DefDatabase<TraitDef>.GetNamed`.

Recipe to find the real (defName, degree): `search_source '<label>nervous</label>' --filePattern '**/TraitDefs/*.xml'` — the file path tells you it's `Traits_Spectrum.xml`, and the surrounding XML shows the parent `<defName>` + the `<degree>` of that `<li>` in `<degreeDatas>`. Then add as `new Trait(td, degree, forced: true)` with the right degree value.

*Why it's tricky:* TraitDef lookup-by-defName fails silently for the most common-sounding labels because the wiki, in-game tooltips, and player intuition all use the per-degree label. Knee-jerk renaming attempts ("Nervous" → "QuickLearner" → "FastLearner") never converge if the symbol you want is a spectrum degree, not a standalone TraitDef.

## Making a humanlike crawl-attack when downed requires faking the IsMutant gates

Vanilla humanlikes never crawl-attack when downed — the whole system (introduced for Anomaly shamblers) is gated behind `pawn.IsMutant`. Three places need to flip for a humanlike to behave like a shambler:

1. **`Pawn_HealthTracker.MakeDowned`** calls `pawn.ClearMind_NewTemp(wasDowned: true)` unless `pawn.IsMutant && CanCrawl && mutant.Def.canAttackWhileCrawling`. ClearMind nukes the current job, so even if everything else worked the pawn would just lie there. Fix: Harmony **prefix on `Pawn.ClearMind_NewTemp` returning false** when `wasDowned == true` AND your pawn kind matches (e.g. `kindDef.defName == "Zombie"`).
2. **`Pawn.CanAttackWhileCrawling`** (getter) returns `mutant.Def.canAttackWhileCrawling` or false. Used by `Toils_Combat` and the `ThreatDisabled` check at `Pawn.cs:~4111` (`if (Downed && (!CanAttackWhileCrawling || !Crawling)) return true;`). Fix: Harmony **postfix on the getter** to force `__result = true` for your kind. Without this, downed pawns are flagged "threat disabled" and enemies stop targeting them, and any toil that wants to attack while crawling bails.
3. (Optional) The pawn's current job needs `isCrawlingIfDowned = true`. This **defaults to true** on `JobDef`; only a handful of vanilla jobs (joy, childcare, a few misc) override to false, so combat jobs from a Manhunter mental state are fine.

Don't try to fake `IsMutant` itself — `mutant` is null for non-Anomaly pawns and the rest of the codebase will NRE the moment it tries to dereference `pawn.mutant.Def`.

*Why it's tricky:* The "downed but still crawling" behavior LOOKS like a generic pawn capability — it's not. It's an Anomaly mechanic and the gates are scattered across three files. Patching just `CanAttackWhileCrawling` isn't enough because `MakeDowned`'s ClearMind kills the job before any combat code runs.
