## Harmony is a MOD dependency, not a NuGet runtime dependency

The canonical RimWorld pattern (since ~2020): your mod depends on Brrainz's "Harmony" mod (packageId `brrainz.harmony`, Steam Workshop id 2009463077). That mod loads `0Harmony.dll` once into the AppDomain before any user mod runs. Your mod compiles against `Lib.Harmony` NuGet purely for type signatures and DOES NOT ship its own `0Harmony.dll`.

**About.xml:**
```xml
<modDependencies>
  <li>
    <packageId>brrainz.harmony</packageId>
    <displayName>Harmony</displayName>
    <steamWorkshopUrl>steam://url/CommunityFilePage/2009463077</steamWorkshopUrl>
    <downloadUrl>https://github.com/pardeike/HarmonyRimWorld/releases/latest</downloadUrl>
  </li>
</modDependencies>
<loadAfter>
  <li>brrainz.harmony</li>
</loadAfter>
```

**.csproj:**
```xml
<PackageReference Include="Lib.Harmony" Version="2.3.3" PrivateAssets="all">
  <ExcludeAssets>runtime</ExcludeAssets>
</PackageReference>
```

`ExcludeAssets="runtime"` is the magic — it lets the build see HarmonyLib types (so you can write `[HarmonyPatch(...)]` etc.) but stops MSBuild from copying `0Harmony.dll` into your `Assemblies/` folder. The Brrainz mod provides the actual runtime DLL.

*Why it's tricky:* `PrivateAssets="all"` alone does NOT prevent the .dll being copied to output — it only prevents transitive dependency exposure. You need `ExcludeAssets="runtime"` to actually skip the runtime copy. Without it, your mod ships `0Harmony.dll` and conflicts with every other Harmony-using mod that does the same — players see `TypeLoadException` for `HarmonyLib.HarmonyPatch` at boot.

*Why NOT ship `0Harmony.dll` yourself:* if two mods both ship Harmony at slightly different versions (very common — every release of `Lib.Harmony` is a new version token), Mono's assembly resolver picks one and the other mod's patches die at boot with `TypeLoadException`. Brrainz's mod centralizes this so there's exactly one Harmony in the AppDomain.

*Why NOT reference RimWorld's bundled Harmony:* RimWorld 1.5+ ILMerges Harmony into `Assembly-CSharp.dll` for its own internal use, but those types aren't exposed for compilation — you can't build against them.

## Tick-driven map-scoped logic = `MapComponent`, not `GameCondition` or Harmony

Subclass `MapComponent`, override `MapComponentTick()`, and RimWorld auto-discovers it — no XML, no DefOf, no Harmony patch needed.

*Why it's tricky:* docs and examples lean toward `GameCondition` for time-bound effects and toward Harmony for "every tick do X". `MapComponent` is the right answer for "always-on while a settings toggle is true" and is the lowest-friction option.

## When patching a `Thing` base method and you need a comp, cast to `ThingWithComps` first

`Thing.GetComp<T>()` does not exist — comps live on `ThingWithComps`. In a Harmony postfix on a `Thing` base method, pattern-match before calling `TryGetComp`:

```csharp
if (!(__instance is ThingWithComps twc)) yield break;
var forbid = twc.TryGetComp<CompForbiddable>();
if (forbid == null) yield break;
```

CS1061 `'Thing' does not contain a definition for 'GetComp'` is the giveaway.

*Why it's tricky:* most tutorials show `thing.GetComp<>()` because the example is already a `ThingWithComps`. When you patch the base `Thing.GetGizmos`, the parameter type is the parent and the extension method silently doesn't apply.
