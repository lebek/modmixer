## Fire incidents/conditions via dev console → "Execute incident", searching by defName

Don't wait on the storyteller during iteration — the cycle is far too slow for tuning multi-stage events. Trigger directly via dev tools.

*Why it's tricky:* the obvious test path ("start a colony, wait for the event") burns 10+ minutes per iteration. Dev console execution is instant.

## Add temporary settings buttons to test individual sounds/effects without firing the whole event

In your `Mod.DoSettingsWindowContents`, render `Widgets.ButtonText` controls that call your start/stop helpers directly. Use a `bool` flag to toggle ▶/⏹ for sustainers.

*Why it's tricky:* this separates "is the SoundDef/asset correct?" from "is the trigger logic correct?" — collapses minutes-per-attempt to seconds. Easy to skip; massive payoff.

## Live-tune numeric params via ModSettings + HorizontalSlider, read each tick from a MapComponent

Wire the value through `ModSettings`, render `Widgets.HorizontalSlider` in the settings panel, and have a `MapComponent` re-read it every tick. Settings hot-reload when the panel closes — no game restart.

*Why it's tricky:* the obvious workflow (edit code → rebuild → restart RimWorld) is slow; this loops in seconds. Discovery cost is low and applies to everything you'd want to tune.

## RimWorld test loop: check is_rimworld_running, sync, enable, launch, watch

`is_rimworld_running` → `quit_rimworld` (only if running) → `sync_to_game` → `enable_mod_in_game` → `launch_rimworld` → `watch_player_log`. Don't ask the user "is RimWorld open?" — check.

*Why it's tricky:* Steam URL launches don't restart a running instance, so you have to quit first when iterating. `ModsConfig.xml` is rewritten on quit, so syncing while the game is open can re-disable your mod.

## Triage Player.log errors before fixing — many are from OTHER mods

Cross-reference errors like `Could not resolve cross-reference: No Verse.ThingDef named X found` name the *target* def, not the source mod. Grep your active mod's source for that defName — if zero hits, the error belongs to another loaded mod and is noise. Tell the user explicitly ("these are from <other mod>, your mod is clean") rather than triaging them.

*Why it's tricky:* the log mixes all loaded mods together and a freshly-loaded mod easily produces a wall of unrelated XML errors that look damning at first glance. Reflex: debug the first error you see. Right reflex: grep your own source first. Wasted hours come from chasing other people's bugs.
