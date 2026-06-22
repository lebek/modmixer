## Recipe/loot/tag JSON folders are SINGULAR in 1.21 (recipe/, loot_table/, tags/)

A crafting recipe is `src/main/resources/data/<modid>/recipe/<name>.json` — `{"type":"minecraft:crafting_shaped","category":…,"key":{…},"pattern":[…],"result":{"id":"<modid>:<item>","count":1}}`. Loot tables go in `loot_table/`, advancements in `advancement/`, tags in `tags/<registry>/`. All singular.

*Why it's tricky:* pre-1.21 used plural `recipes/`, `loot_tables/`. A file in the wrong (plural) folder silently never loads and there's no error. Copy the exact current shape from vanilla with `search_defs <name> defType=recipe` (returns the full JSON to template from).
