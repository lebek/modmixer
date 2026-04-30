## `Could not find parent node named "RawPlant"` is a load-order bug, not a typo

The abstract parent isn't yet in the def index when the child resolves. Either declare your mod's load order *after* the owning mod, or copy the abstract `<ThingDef Abstract="True">` into your own defs.

*Why it's tricky:* the error message reads like a misspelled `parentName` but the spelling is fine — it's a timing problem.
