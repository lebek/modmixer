## PawnRenderer.RenderPawnAt NREs on off-map fake pawns — use a custom texture instead

Trying to render a real `Pawn` (e.g. a Shambler-mutant human) at an arbitrary world position for a custom visual effect by calling `pawn.Drawer.renderer.RenderPawnAt(drawLoc)` on a `ThingMaker.MakeThing(ThingDefOf.Human)` pawn that was never spawned does NOT work. The renderer cascades through:

1. `ParallelGetPreRenderResults` → `GetBodyPos` → `pawn.ParentHolder.ParentHolder` → **NRE** (off-map pawns have null `ParentHolder`).
2. Even forcing `pawn.jobs.posture = PawnPosture.Standing` so `GetBodyPos` early-returns just moves the NRE one frame deeper into `ParallelPreDraw` / `GetDrawParms` / silhouette graphic lookup.
3. Setting `mutant = new Pawn_MutantTracker(...)` is not enough — you must also call `mutant.Turn()` or `pawn.IsMutant` returns false and `DynamicPawnRenderNodeSetup_Mutants` skips the shambler scar overlay nodes entirely.

`CompStatue` gets away with this only because statues are a special-cased rendering mode (`renderer.SetStatue(stuff)` + specific render flags). For a general "render a shambler-looking thing at this position" use case, the supported alternatives are:

- Spawn an actual pawn on the map (heavy, side effects).
- Use a custom texture (hand-drawn or composited offline) and draw it via `Graphics.DrawMesh` with a `MaterialPropertyBlock` for per-instance alpha. This is what `Mote_*` defs in Anomaly DLC do for shambler-themed effects (`Mote_ShamblerAlert`, `Mote_ShamblerRaiseMist`, etc.).

*Why it's tricky:* `RenderPawnAt` looks like a clean public API and `CompStatue` looks like an existence proof that off-map rendering works, but the renderer has many implicit dependencies on spawned-pawn state (`ParentHolder`, `CurrentBed`, `Spawned`-guarded blocks) that aren't documented and only show up as NREs. Don't sink hours into making it work — use a texture.

## Procedural pawn breathing/scale must patch ScaleFor's .z (not .y) and feed time from a main-thread per-frame snapshot

To make idle pawns visibly breathe/scale via Harmony on `PawnRenderNodeWorker.ScaleFor` (Verse), there are three non-obvious traps:

1. **Scale the `.z` axis, never `.y`.** `ScaleFor` returns a `Vector3` mapping `drawSize.x → .x` and `drawSize.y → .z`; `.z` is the on-screen vertical for a top-down pawn. `.y` is depth and is force-overwritten by `PawnRenderNode.GetTransform` (`scale.y = 1f;`) immediately after `ScaleFor` returns — so a postfix that does `__result.y *= factor` has **zero** visible effect. Use `__result.z`.

2. **Root scale propagates to children** via `PawnRenderTree.TryGetMatrix` (it composes the ancestor chain's transforms), so scaling only the root/body node breathes the whole pawn. Identify the root by reflecting `PawnRenderNode.tree` → `PawnRenderTree.rootNode`; the head node is `PawnRenderNode_Head` (type-name "Head" also catches `PawnRenderNode_AttachmentHead` eyes — good for a blink squash).

3. **`ScaleFor` runs on Unity worker threads.** The `DrawPhase.ParallelPreDraw` phase is dispatched as `PreDrawThings : IJobParallelFor`, so `Time.realtimeSinceStartup` and `Find.TickManager` (main-thread-only) are unsafe inside the postfix. Snapshot them once per frame on the main thread with a prefix on `DynamicDrawManager.DrawDynamicThings` into `static volatile float`/`bool`, and have all animation math read those. This also keeps the parallel-pre-draw and draw phases on one consistent timestamp.

**Bonus:** to move the whole pawn (sway/bob), patch `Pawn.DynamicDrawPhaseAt(ref Vector3 drawLoc)` — it forwards drawLoc to `Drawer.renderer.DynamicDrawPhaseAt` (body via cached `results.bodyPos`, shadow via the passed drawLoc, no double-offset). Patching base `Thing.DynamicDrawPhaseAt` does nothing for pawns: that path only calls `Pawn.DrawAt`, which renders comps only, while the override uses its own unmodified drawLoc copy for the renderer.

**Note:** scale effects freeze when zoomed out past `ZoomRootSize > 18f` because `ParallelGetPreRenderResults` short-circuits to a cached texture-atlas frame before running the node transforms; positional offsets still apply since they feed `bodyPos`.

## To animate/shake a single plant (tree) per-frame, skip it in Plant.Print and redraw it yourself

Plants are **printed into the map's static section mesh** (`Plant.Print` → `Printer_Plane.PrintPlane`), not drawn each frame, so you cannot move one by nudging a DrawPos — the geometry is baked until the section is regenerated. Wind sway is GPU-side (per-vertex sway weights × a *global* wind uniform), so it can't target one plant either.

Recipe to shake/animate one tree on demand (e.g. on an axe hit):
1. Harmony **prefix on `Plant.Print` returning `false`** while that plant is "animating" — removes it from the static mesh.
2. `map.mapDrawer.MapMeshDirty(cell, MapMeshFlagDefOf.Things)` **once** at animation start (so the skip takes effect) and **once** at end (so it re-prints normally). `MapMeshFlagDefOf.Things` implicitly converts to the `ulong` the API wants.
3. Redraw the plant yourself every frame from a `MapComponent.MapComponentUpdate()` (auto-instantiated on every map; runs in the render path so `Graphics.DrawMesh` shows this frame). Pivot at the trunk base: `Translate(basePos) * Rotate(AngleAxis(angle, Vector3.up)) * Scale(size) * Translate(0,0,0.5)` with `MeshPool.plane10`. Size = `def.graphicData.drawSize.x * def.plant.visualSizeRange.LerpThroughRange(growth)`; material = `plant.Graphic.MatSingleFor(plant)`; base z = `Position.z` (cell south edge, matching Print's bottom-clamp); altitude Y = `def.Altitude`.

*Why it's tricky:* the obvious "offset DrawPos / patch TrueCenter" does nothing because nothing reads it per-frame, and re-printing the whole section every frame to bake an offset is a perf trap. Skipping Print + self-drawing dirties the section only twice per event. Minor gotcha: `Graphic_Random` trees may show a different leaf variant while self-drawn (Print seeds variant from `Position.GetHashCode()`, not `MatSingleFor`), so capture one material at start and reuse it.
