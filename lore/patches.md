## Wide patches: use wildcard XPath, not named-defName lookup

For "patch every storyteller" / "every animal" use `<xpath>/Defs/StorytellerDef/comps</xpath>` with `PatchOperationAdd`. Avoid `Defs/StorytellerDef[defName="Cassandra"]/comps` style.

*Why it's tricky:* named lookups can run before Core defs are fully registered, producing `Failed to find <named def>` errors that look like typos but are timing failures. Wildcard XPath sidesteps the timing issue entirely.

## `PatchOperationAdd` targets the list parent, not `list/li`

`<xpath>/Defs/X/comps</xpath>` + `<value><li Class="..."/></value>` ✓. Targeting `comps/li` either fails or appends in the wrong place when the list is empty.

*Why it's tricky:* it feels natural to "point at where the new li goes" but XPath Add wants the parent and the new node as the value.

## A Patches/ file's root element must be &lt;Patch&gt; (singular), not &lt;Patches&gt;

Every XML file under a mod's `Patches/` folder must have `<Patch>` as its single root element (wrapping `<Operation>` entries). Using the plural `<Patches>` makes RimWorld reject the **entire file** at load with:

```
Unexpected document element in patch XML; got Patches, expected 'Patch'
```

*Why it's tricky:* the error is attributed to `[RimWorld]` (Verse's `LoadedModManager` does the parse), not the mod, so it's easy to misclassify as unrelated. The whole file is silently dropped — every PatchOperation in it just never runs, with no per-operation error — so the symptom is "my patches do nothing" rather than a crash. The folder is plural (`Patches/`) which baits the plural root tag. Fix is the one-line root + closing tag rename to `<Patch>`/`</Patch>`.
