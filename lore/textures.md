## Any class with a static Texture2D field needs [StaticConstructorOnStartup] or RimWorld warns

RimWorld's startup runs a reflection scan over all loaded types looking for static `Texture2D` / `Material` / `Shader` fields. Any class that has one but lacks `[StaticConstructorOnStartup]` fires the warning:

```
Type Foo probably needs a StaticConstructorOnStartup attribute, because it has a field _tex of type Texture2D. All assets must be loaded in the main thread.
```

Fix: add `[StaticConstructorOnStartup]` to the class. You do NOT need an actual static constructor — the attribute alone silences the warning. Loading the texture lazily on first use (via `ContentFinder<Texture2D>.Get` inside a method) is still fine; the attribute just signals "I'm aware this class participates in main-thread asset loading" and gives RimWorld permission to invoke any static initializers during startup on the main thread.

*Why it's tricky:* lazy-load patterns suppress no errors at runtime (your code works) but produce a startup warning per class, polluting the log. The warning attribution lands on `[RimWorld]` even though the offending type is yours — easy to misclassify as "not my problem."

## When coloring world-map tiles per-tile via a WorldDrawLayer, use WorldMaterials.VertexColorTransparent, not WorldOverlayTransparent

To color individual planet tiles by writing `subMesh.colors` (per-vertex) in a custom `WorldDrawLayer.Regenerate()`, the material's shader MUST read mesh vertex colors. Use `new Material(WorldMaterials.VertexColorTransparent)` — this is exactly what vanilla's `WorldDrawLayer_DebugNoise` uses for per-tile color.

*Why it's tricky:* `ShaderDatabase.WorldOverlayTransparent` (and the pollution shader) tint by the **material's** single color and ignore per-vertex `subMesh.colors` entirely. A mesh built with correct verts/tris/colors will regenerate without error and report thousands of claimed tiles, but render **completely invisibly** — no error, no warning, just nothing on the map. The fix is the material/shader, not the mesh. Build the tile quad by fan-triangulating `Find.WorldGrid.GetTileVertices(tile, verts)` (lift verts ~0.012 along their normal so the tint sits above terrain), and register the layer by appending its type to the Surface `PlanetLayerDef`'s `worldDrawLayers` list via a `PatchOperationAdd`.

## Graphic_StackCount expects a directory of PNGs, not a single file — use Graphic_Single for one-texture items

`Graphic_StackCount` (used by vanilla drugs / stackable items) treats `<texPath>` as a **directory** and loads every PNG inside. Vanilla ships drugs as `Things/Item/Drug/Penoxycyline/Penoxycyline_a.png`, `_b.png`, `_c.png` for low/medium/full stack appearance. If you copy the def shape but drop a single PNG at the literal path, it fails with:

```
Collection cannot init: No textures found at path Things/Item/Drug/MyThing
```

This fires once at game load and the def's icon/render falls back to magenta. The error message says "Collection" — that's the giveaway: `Graphic_StackCount` extends `Graphic_Collection`.

Fix options:
1. **Switch to `Graphic_Single`** in `<graphicData><graphicClass>` — uses one PNG at the literal path. Best when you don't care about stack-count variation.
2. **Make the path a folder** with at least one PNG inside (any name; the loader globs all PNGs). For full stack-count behavior, ship 3+ named `_a.png`, `_b.png`, `_c.png` for low/mid/full.

`Graphic_Random` (plants, scatter art) extends the same `Graphic_Collection` base and has the identical requirement — point it at a folder of `_a`/`_b`/`_c` variants, not a single file.

*Why it's tricky:* the `<texPath>` field in both `Graphic_Single` and `Graphic_StackCount` looks identical in XML and most copy-paste examples use `Graphic_StackCount` because that's what vanilla drugs use. The user's mental model is "this is the path to the icon" — which is right for `Graphic_Single` but wrong for `Graphic_Collection` subclasses.

## When loading a texture for a Mod-class UI, never ContentFinder.Get in a field/static initializer

`ContentFinder<Texture2D>.Get(...)` MUST run on the main thread. A `Verse.Mod` subclass is constructed via `LoadedModManager.CreateModClasses` on a **worker thread** during `LoadAllActiveMods`, so any texture loaded in the Mod class's field initializer or static constructor throws:

`Tried to get a resource "..." from a different thread. All resources must be loaded in the main thread.`

`[StaticConstructorOnStartup]` does NOT save you here — touching the class during Mod construction triggers the cctor on that worker thread before the main-thread StaticConstructorOnStartup pass runs.

*Fix:* resolve the texture lazily behind a `static bool resolved` guard inside `DoSettingsWindowContents` (or any method that runs on the UI/main thread), not in an initializer. Same rule applies to any `Get` for icons used by `Mod`/settings UI.
