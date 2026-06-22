/**
 * Pinned Minecraft / NeoForge toolchain versions for the beta. ModMixer targets
 * exactly ONE Minecraft version so it can require exactly one JDK and ship one
 * vendored MDK template + one source-index pipeline. Bumping the target game
 * version is a deliberate, tested change here, not a runtime variable.
 *
 * These should be validated against maven.neoforged.net / parchmentmc before a
 * release bump — the gradlew build fails loudly if a pinned coordinate doesn't
 * resolve, so a stale pin surfaces immediately rather than silently.
 */
export const MINECRAFT_VERSION = '1.21.1';

/**
 * NeoForge 21.1.x line for MC 1.21.1 (NeoForge drops the leading "1." of the MC
 * version: 1.21.1 -> 21.1.z). This is the MDK-head pin; any published 21.1.x
 * patch is valid for 1.21.1. Resolved against maven metadata at scaffold time
 * when possible (see resolveLatestNeoForge), falling back to this.
 */
export const NEOFORGE_VERSION = '21.1.234';

/** Parchment param-name/javadoc mappings applied during source generation. */
export const PARCHMENT_MINECRAFT_VERSION = '1.21.1';
export const PARCHMENT_MAPPINGS_VERSION = '2024.11.17';

/** Java major version Mojang ships for 1.21.x — the one hard host prerequisite. */
export const REQUIRED_JDK_MAJOR = 21;

/**
 * The Minecraft mod loader we target. Used in mod metadata (neoforge.mods.toml)
 * and as the Modrinth `loaders` value on publish.
 */
export const LOADER = 'neoforge' as const;

/** A fingerprint string that changes whenever any pinned coordinate changes,
 * used to key the per-game source index so a toolchain bump forces a rebuild. */
export function toolchainFingerprint(): string {
  return [
    MINECRAFT_VERSION,
    NEOFORGE_VERSION,
    PARCHMENT_MINECRAFT_VERSION,
    PARCHMENT_MAPPINGS_VERSION,
  ].join('|');
}
