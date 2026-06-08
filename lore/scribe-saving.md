## When a custom WorldObject is held in your own collection, scribe it as a Reference, not Deep — and never override its ID

If you subclass `WorldObject` and also keep your objects in your own `Dictionary`/`List` on a GameComponent/WorldComponent, that collection must scribe them with `LookMode.Reference`, NOT `LookMode.Deep`. `Find.WorldObjects` already deep-saves every live WorldObject; deep-saving again from your collection throws `<TypeName> was already deepsaved at .` (a warning, ×N per object, attributed to your mod). Reference scribing works because WorldObject implements `ILoadReferenceable` (`GetUniqueLoadID()` returns `"WorldObject_" + ID`).

Also: `WorldObjectMaker.MakeWorldObject` already assigns a globally-unique `obj.ID` via `Find.UniqueIDsManager.GetNextWorldObjectID()`. Do NOT overwrite `army.ID` with your own counter — it collides with other world objects' IDs and breaks reference resolution on load. Use the maker-assigned `obj.ID` as your dictionary key so the key matches what reference-scribing resolves against.

*Why it's tricky:* the object saves and loads fine in a fresh session (no error until the SECOND save of the same live object), and the error is only a yellow warning, so it's easy to miss until savegames start corrupting army references.

## Static caches and Sustainers leak across exit-to-menu + load; reset them in a GameComponent FinalizeInit

Any `static` Dictionary/List/HashSet you use as a transient cache (pawn→leader maps, pending-event queues, rolling counters, letter digests, portrait caches) is NOT cleared when the player exits to the main menu and loads a different save — statics live for the whole process. Result: a prior game's state leaks into the new one. The classic symptom is recycled `thingIDNumber`s resolving to a stale cached entry, or per-world-tile keys injecting content onto the wrong map.

Recipe: give each such cache a `public static void Reset()`/`Clear()` and call them all from a `GameComponent.FinalizeInit()` (which runs on every load AND new game). Wrap each in its own try/catch so one failure doesn't skip the rest.

Separately: a `Sustainer` (looping sound, e.g. an ambient hum on a boss pawn) must be explicitly `.End()`-ed when its owner dies/despawns — it does NOT auto-stop just because the pawn is gone, and the audio keeps playing/leaking. Pair sustainer ownership with the same cleanup path that removes the pawn's cached state. Check `sustainer.Ended` before calling `.End()`.

*Why it's tricky:* both bugs are invisible in a single continuous play session (the only one most testing covers) and only manifest on the second loaded game or after a boss dies — easy to ship.
