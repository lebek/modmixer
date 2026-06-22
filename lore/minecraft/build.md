## Edit identity in gradle.properties, never the generated neoforge.mods.toml

A NeoForge mod's name/id/version live in `gradle.properties` (mod_id, mod_name, mod_version). The manifest at `src/main/templates/META-INF/neoforge.mods.toml` is GENERATED from those by Gradle — don't hand-edit it. To rename the mod use `set_mod_metadata` (it rewrites gradle.properties AND renames the @Mod id, Java package, and resource namespaces to match).

*Why it's tricky:* a mod_id that doesn't match the `@Mod("…")` annotation / `MODID` constant fails at load with "entrypoint class … for mod with id X, which does not exist" — even though the build compiles fine. Keep them in sync; let set_mod_metadata do it.
