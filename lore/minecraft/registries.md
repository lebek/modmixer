## Register items/blocks with DeferredRegister, hooked to the mod bus in the constructor

Create static `DeferredRegister.Items ITEMS = DeferredRegister.createItems(MODID)` (and `.Blocks`, or `DeferredRegister.create(Registries.X, MODID)` for other registries). Register entries with `ITEMS.register("name", () -> new Item(...))` (returns a `DeferredItem`/`DeferredHolder` you reference later), then call `ITEMS.register(modEventBus)` in the `@Mod` constructor. The supplier runs during the registry phase on the MOD bus — not at class load.

*Why it's tricky:* registering straight against `BuiltInRegistries` at the wrong time throws; DeferredRegister handles the timing. Ids are namespaced to your MODID — `ITEMS.register("obsidian_sword", …)` becomes `yourmod:obsidian_sword`. Read the example mod's existing DeferredRegister fields before adding your own.
