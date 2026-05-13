## "Leak suspected in object pool for PawnPaths" — bulk-spawning past the pool cap

`Leak suspected in object pool for PawnPaths, created: 40, expected less than 39. Dispose them so they can be reused by the pool.` fires when a mod spawns enough pawns in a single tick that every spawned pawn requests a `PawnPath` before any prior path is recycled. RimWorld's `PawnPathPool` defaults to ~39 active paths; once you exceed that on the same tick the engine assumes a leak rather than a legitimate horde.

This is a **warning, not a fatal error** — the mod still works and zombies/raiders still move. But it pollutes the log every spawn and indicates the spawn is fighting the engine's assumptions.

Mitigations (in increasing order of effort):

1. **Stagger the spawn across ticks.** Instead of a `for` loop that calls `GenSpawn.Spawn` 100×, schedule the spawns via a `MapComponent` or one-shot `LongEventHandler`/`TickManager` callback that drips e.g. 10 pawns per tick over 10 ticks. The pool recycles between ticks, so the warning never fires.
2. **Use `PawnsArrivalModeWorker_EdgeWalkIn`-style entry.** Vanilla raids of 100+ pirates don't trip this warning because the arrival worker spawns at the map edge with a brief delay between pawns; copying that pattern (or calling `IncidentWorker_Raid`'s helpers when applicable) gets the staggering for free.
3. **Skip pathing entirely on spawn.** If your pawns don't need a path immediately (they'll wander/idle for a tick), set their initial job to `JobDefOf.Wait` or similar — no `PawnPath` request, no pool pressure.

*Why it's tricky:* the warning says "leak" but you're not leaking — you're legitimately using more paths than the pool was tuned for. Search for `PawnPathPool` in C# source if you're tempted to patch the cap; staggering is the cleaner fix.

## C# performance work — patch the right method, not the obvious one

When optimizing pawn behavior at scale (100+ pawns), the bottleneck is usually NOT what `Performance Profiler` shows in the inspector. The expensive paths in `Pawn` ticking, in order:

1. `Pawn_NeedsTracker.NeedsTrackerTick` (every need updates every ~150 ticks)
2. `Pawn_Thinker.ThinkerTick` (think tree evaluation)
3. `Pawn_PathFollower.PatherTick` (moving pawns only)
4. `Pawn_HealthTracker.HealthTick` (only matters if Hediffs are stacked deep)

If your design lets pawns skip needs entirely (zombies, mechs, custom races with `<race><needsRest>false</needsRest>` etc.), patching `Pawn_NeedsTracker.ShouldHaveNeed` to short-circuit on your kind is usually the single biggest win. A Harmony postfix returning `false` for any of `Food`/`Rest`/`Joy`/`Beauty`/`Comfort` cuts dozens of need-tick allocations per pawn per real-second.

*Why it's tricky:* the obvious target (`Pawn.Tick`) is mostly dispatching to subsystems; patching it doesn't help. The expensive work is in the trackers it calls.
