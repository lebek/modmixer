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

## Positional SoundDef distRange must account for camera altitude (min 15, max 65)

RimWorld's `CameraDriver.MinAltitude = 15f` and `MaxAltitude = 65f` — the camera (and AudioListener) is **never closer than 15 units to the map surface**, even fully zoomed in. A worldspace SoundDef with `<distRange>4~14</distRange>` is **silent at every zoom level** because the listener is always farther than `maxDistance`. There is no log error — the sound plays into the void.

For audible-only-when-zoomed-in proximity sounds, use `<distRange>15~30</distRange>` (or similar starting at 15+). For "always audible on-map" use vanilla's typical `<distRange>0~50</distRange>`. Confirm with `PlayOneShot(SoundInfo.InMap(new TargetInfo(thing.Position, thing.Map)))`.

*Why it's tricky:* every reference (vanilla shambler `0~50`, pawn attacks `0~50`) just covers the whole altitude range, so you never see the constraint stated. The default `distRange` of `25~70` works by accident. Setting a "tight, intimate" range under 15 produces the exact symptom of "code fires, no error, no sound" — indistinguishable from a broken `.ogg`, which is why this took multiple test cycles to find. Look at `Verse.CameraDriver.MinAltitude` if you suspect this.

## When you need a chained-clip Sustainer to play its current clip in full and then stop

RimWorld's `SampleSustainer.Volume` formula bakes a per-clip volume ramp into the **last `sustainRelease` seconds** of every clip (typically 0.5s). During normal chaining this is masked by the next clip's `sustainAttack`. But if you "freeze" new clips (so the current one can finish in isolation when a job ends), the release ramp fades **the music itself** instead of silence — sounds like the song is mid-fading even though scheduledEndTime hasn't been reached.

Recipe (when you want "let the current clip finish naturally, then stop"):
1. Reflect into `Sustainer.subSustainers` (private List<SubSustainer>) and for each:
   - Set `SubSustainer.nextSampleStartTime` (private float) to `float.MaxValue` — prevents new clips chaining.
   - For each item in `SubSustainer.samples` (private List<SampleSustainer>), do `ss.scheduledEndTime += subDef.sustainRelease + 0.1f`. This pushes the release-ramp window past the audible content, so the fade happens during the silence after the clip rather than at its tail.
2. **Keep calling `sustainer.Maintain()`** every tick during the grace period. Skipping Maintain() triggers `Sustainer.End()` after 1 tick, which schedules `Cleanup()` after `sustainFadeoutTime` (0.3s default) — forcibly destroying all active samples mid-play.
3. When `samples.Count == 0` on every SubSustainer, call `sustainer.End()` yourself.
4. Use a **real-time** safety timeout (`Time.realtimeSinceStartup`), not tick-based — at 3x game speed tick-based timeouts shrink to a third of their wall-clock duration. Long music clips (30–70s) will be cut short.

*Why it's tricky:* `sustainRelease` looks like a Sustainer-end fadeout but is actually a per-clip property. `Sustainer.End()` and per-clip release ramps are two completely separate fade mechanisms in RimWorld's audio system. `SampleSustainer` and `SubSustainer` are both public classes in `Verse.Sound`, and `SampleSustainer.scheduledEndTime` is a public field, but the lists hooking them together are private — you need reflection on `Sustainer.subSustainers` and `SubSustainer.samples`/`nextSampleStartTime`.
