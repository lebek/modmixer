## Wide patches: use wildcard XPath, not named-defName lookup

For "patch every storyteller" / "every animal" use `<xpath>/Defs/StorytellerDef/comps</xpath>` with `PatchOperationAdd`. Avoid `Defs/StorytellerDef[defName="Cassandra"]/comps` style.

*Why it's tricky:* named lookups can run before Core defs are fully registered, producing `Failed to find <named def>` errors that look like typos but are timing failures. Wildcard XPath sidesteps the timing issue entirely.

## `PatchOperationAdd` targets the list parent, not `list/li`

`<xpath>/Defs/X/comps</xpath>` + `<value><li Class="..."/></value>` ✓. Targeting `comps/li` either fails or appends in the wrong place when the list is empty.

*Why it's tricky:* it feels natural to "point at where the new li goes" but XPath Add wants the parent and the new node as the value.
