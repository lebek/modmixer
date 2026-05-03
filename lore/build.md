## `CS1061` / `CS0246` from a missing `using` — RimWorld splits APIs across sub-namespaces

When a method or type "should exist" but the compiler insists it doesn't, the type is usually in a sub-namespace that `using RimWorld; using Verse;` doesn't pull in. The pattern is `error CS1061: '<Type>' does not contain a definition for '<Member>' and no accessible extension method` (extension methods) or `CS0246: The type or namespace name '<Name>' could not be found` (plain types). Add the right `using` instead of fishing in the existing namespaces.

Most-bitten cases:

| Symbol | Lives in | Notes |
| --- | --- | --- |
| `Pawn.IsWorldPawn()`, `Find.WorldPawns`, `Caravan`, `Settlement`, `WorldObject`, `Tile` | `RimWorld.Planet` | Anything off the planet/world map. |
| `QuestNode`, `QuestNode_*`, `QuestPart_*`, `QuestGen`, `Slate` | `RimWorld.QuestGen` | Quest scripting. The QuestPart base is in `RimWorld`, but QuestPart_<Subclass> is in QuestGen. |
| `JobDriver`, `JobDriver_*`, `Toils_*`, `ThinkNode`, `ThinkNode_*`, `WorkGiver_*`, `MentalState_*`, `Pawn_PathFollower` | `Verse.AI` | All pawn AI / job execution. Easy to miss because `JobDef` itself is in `Verse`. |
| `SoundDef`, `SubSoundDef`, `Sustainer`, `SoundInfo`, `SoundDefOf` | `Verse.Sound` | `SoundDefOf` is the trap — looks like it should be in `RimWorld` alongside other `*DefOf`. |
| `Texture2D`, `Color`, `Vector2/3`, `Rect`, `GUI.*`, `TextAnchor` | `UnityEngine` | And `TextAnchor` also needs the `UnityEngine.TextRenderingModule` reference (next entry). |
| `Sketch`, `SketchEntity_*`, `SketchResolverDef` | `RimWorld.SketchGen` | Procedural building generation. |
| `SymbolDef`, `SymbolResolver_*`, `BaseGenUtility` | `RimWorld.BaseGen` | Base/raid scenario generation. |

When in doubt, run `search_source <SymbolName>` and look at the file path of the *declaration* (e.g. `Verse.AI\MentalStateWorker.cs`) — the path segment before the filename is the namespace.

*Why it's tricky:* RimWorld's namespace split is not aligned with what the type does. `JobDef` is in `Verse` but everything that *uses* it is in `Verse.AI`. `WorldPawnsUtility` (which defines the `IsWorldPawn` extension) is in `RimWorld.Planet` even though the extended type (`Pawn`) is in `Verse`. Adding `using Verse;` and `using RimWorld;` does not transitively pull in their child namespaces.

## `CS0012: 'TextAnchor' is defined in an assembly that is not referenced` — add UnityEngine.TextRenderingModule

When you call `Widgets.ButtonText` (or anything taking a `TextAnchor?` overload) and hit CS0012, add this to the csproj:

```xml
<Reference Include="UnityEngine.TextRenderingModule">
  <HintPath>$(RimWorldRoot)\..\UnityEngine.TextRenderingModule.dll</HintPath>
  <Private>false</Private>
</Reference>
```

*Why it's tricky:* most mods only reference `UnityEngine.CoreModule`. Code compiles fine until you actually invoke the overload that pulls in `TextAnchor`, then CS0012 fires.

## To inspect a 1.x RimWorld type, use `decompile_dll`, never bash-invoke `ilspycmd`

The in-app `decompile_dll` tool runs ilspycmd through a path-policy guard. Bash-invoking `ilspycmd` triggers a permission prompt AND current upstream packages have a broken `DotnetToolSettings.xml` that fails `dotnet tool install`.

*Why it's tricky:* if `decompile_dll -t TypeName` returns "Could not find type definition", grep the dump for the namespace first — `WeatherOverlay_Rain` lives in `RimWorld`, not `Verse`, etc.
