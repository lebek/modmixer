## SubSoundDef volumeRange is on a 0–100 scale, not 0–1

Use `<volumeRange><min>85</min><max>100</max></volumeRange>` — `SubSoundDef.RandomizedVolume()` divides by 100f internally. Most other RimWorld float fields are 0–1, so this is easy to get wrong.

*Why it's tricky:* using 0–1 values produces audible-but-near-silent playback with NO log error. The only signal is "I hear nothing." Decompiling `SubSoundDef` is the only way to spot the `/100f`.

## Camera/UI sounds need `<onCamera>true</onCamera>` on every subSound

For SoundDefs played via `PlayOneShotOnCamera` or sustainers spawned from `SoundInfo.OnCamera(...)`, every `<li>` under `<subSounds>` must contain `<onCamera>true</onCamera>`.

*Why it's tricky:* without it the engine logs `Tried to play <Def> on camera but it has no on-camera subSounds.` and nothing plays. Sustainer templates copied from vanilla often have it; one-shot defs copy-pasted from worldspace examples often don't.

## SoundDef `<clipPath>` is relative to `Sounds/`, no extension, no leading slash

`<clipPath>Emission/emission_warning</clipPath>` resolves to `Sounds/Emission/emission_warning.ogg`. Writing `Sounds/Emission/...` or including `.ogg` resolves to nothing.

*Why it's tricky:* the failure mode is `Could not load AudioClip at '...' in any active mod` — looks like a missing-file error but is almost always a path-shape error.

## Play a one-shot SoundDef from C# with `PlayOneShotOnCamera()` — no Map argument

`mySoundDef.PlayOneShotOnCamera()` ✓. The `PlayOneShotOnCamera(Map)` overload looks helpful but is a guard, not a target — it bails when `WorldRendererUtility.DrawingMap` is false (i.e. most of the time outside the world map). Vanilla never passes a map to this method.

*Why it's tricky:* IntelliSense shows the Map overload as if it scopes the sound to a map. It doesn't — it silently suppresses the sound on the regular play map. Symptom: silent failure with no log line.

## Spawn a sustainer with `MaintenanceType.None`, store the handle, call `.End()` later

```csharp
var sustainer = mySoundDef.TrySpawnSustainer(SoundInfo.OnCamera(MaintenanceType.None));
// ...later...
sustainer.End();
```

Do NOT use `MaintenanceType.PerTick` unless you call `.Maintain()` on the sustainer every single tick — otherwise it self-destructs after one tick.

*Why it's tricky:* the sound plays for one frame then dies, with no log error. The `PerTick` name suggests "ticks while playing"; it actually means "requires per-tick maintenance from you."

## Sound starter extension methods live in `Verse.Sound`, not `Verse`

Add `using Verse.Sound;` to use `PlayOneShotOnCamera`, `TrySpawnSustainer`, etc. The static `SoundStarter` class is in that namespace.

*Why it's tricky:* `SoundDef` itself lives in `Verse`, so `using Verse;` looks sufficient and the methods just appear missing.

## TrySpawnSustainer requires SoundDef.sustain=true — pre-flight check or you spam the log every tick

`SoundDef.TrySpawnSustainer(SoundInfo)` only works on defs with `<sustain>True</sustain>` in their XML. Calling it on a one-shot def (`PsychicSootheGlobal`, `PsychicPulseGlobal`, `LetterArrive_*`, all combat/impact sounds, etc.) fires `Log.Error("Tried to spawn a sustainer from non-sustainer sound X.")` and returns null — NOT a thrown exception, so a `try/catch` around the call doesn't help.

If you also Maintain() the (null) sustainer in a per-tick path, the error fires every tick — 60/s, 600+ in 10 seconds.

Pattern:
```csharp
if (snd != null && snd.sustain)
{
    sustainer = snd.TrySpawnSustainer(SoundInfo.InMap(pawn, MaintenanceType.PerTick));
}
```
And cache "I tried" with a bool latch so a missing/wrong def doesn't retry on every tick either.

Vanilla sustainer SoundDefs (confirmed, base-game, no DLC needed) — list in `Defs/Core/SoundDefs/Building_Sustainers_Ambiences.xml`:
- `CrashedShipPart_Ambience` — evil drone, perfect for ominous boss vibes
- `GeothermalPlant_Ambience` — low industrial hum
- `WindTurbine_Ambience` / `WaterMill_Ambience` — gentler hums
- `Television_Ambience` — domestic-noise drone
- `WoodFiredGenerator_Ambience` / `ChemfuelFiredGenerator_Ambience` — combustion hums

*Why it's tricky:* the name doesn't tell you. `PsychicSootheGlobal` SOUNDS like a sustained-feel global hum (and is — when played as a one-shot it has a long tail). But its def has no `<sustain>True</sustain>`, so the engine refuses to drive it as a Sustainer. Always check the def XML, don't go by the name.
