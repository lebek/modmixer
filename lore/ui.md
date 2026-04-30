## Multi-select gizmos work via shared defaultLabel — let RimWorld merge

Don't try to detect multi-select up front. Just yield your `Command_Action` from `Thing.GetGizmos()` on every selected instance with the *same* `defaultLabel` — the gizmo bar dedupes by label across `Find.Selector.SelectedObjects` and runs the first one's action. Inside the action, iterate `Find.Selector.SelectedObjects` to operate on the full selection.

*Why it's tricky:* there's no "multi-select gizmo" API. The merge is implicit, label-keyed, and only documented by reading `GizmoGridDrawer`. Easy to over-engineer with custom MapComponents or a separate "bulk" entrypoint when the engine already does this for you.
