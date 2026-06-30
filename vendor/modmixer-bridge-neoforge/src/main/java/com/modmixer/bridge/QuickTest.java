package com.modmixer.bridge;

import java.util.function.Function;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import net.minecraft.client.Minecraft;
import net.minecraft.core.RegistryAccess;
import net.minecraft.core.registries.Registries;
import net.minecraft.world.Difficulty;
import net.minecraft.world.level.GameRules;
import net.minecraft.world.level.GameType;
import net.minecraft.world.level.LevelSettings;
import net.minecraft.world.level.WorldDataConfiguration;
import net.minecraft.world.level.levelgen.WorldDimensions;
import net.minecraft.world.level.levelgen.WorldOptions;
import net.minecraft.world.level.levelgen.presets.WorldPresets;
import net.minecraft.world.level.storage.LevelStorageSource;

/**
 * Client-only "quicktest" helper — the Minecraft analogue of RimWorld's
 * {@code -quicktest}. When the ModMixer desktop app launches the dev client with
 * {@code -Dmodmixer.quicktest=<creative|survival>}, the bridge drives it straight
 * from the title screen into a freshly-created superflat world, so the user lands
 * in-game with their mod loaded instead of clicking through Singleplayer → Create
 * World → wait → Join on every test cycle.
 *
 * <p>Kept in a separate class (like {@link ClientHooks}) so the dedicated server
 * never loads the client-only world-creation classes referenced here; it is only
 * touched behind a {@code FMLEnvironment.dist == CLIENT} guard.
 *
 * <p>Fresh each cycle: any prior quicktest world is deleted before creation, so
 * the user never resumes a stale one (mirrors RimWorld regenerating its map per
 * launch). Cheats are enabled (handy for in-game testing); the world type is
 * always superflat — near-instant to generate and the standard testing surface.
 *
 * <p>VERIFY against 21.1.x: every Minecraft call below was checked against the
 * decompiled, Parchment-mapped 1.21.1 sources, but the world-creation surface is
 * the most likely to drift on a game-version bump — {@link WorldOpenFlows
 * #createFreshLevel}, {@link LevelSettings}'s 7-arg ctor, {@link WorldPresets
 * #FLAT} + {@code WorldPreset.createWorldDimensions()}, and {@code
 * Minecraft.createWorldOpenFlows()}. A signature change degrades gracefully: the
 * try/catch leaves the user at the title screen rather than breaking the run.
 */
final class QuickTest {

    private static final Logger LOG = LoggerFactory.getLogger("modmixerbridge");

    /** Fixed folder/level name — one reused, always-fresh quicktest world. */
    private static final String LEVEL_NAME = "modmixer-quicktest";

    private QuickTest() {}

    /**
     * Create a fresh superflat world in {@code mode} and enter it. Scheduled onto
     * the client thread's task queue (we are invoked from a ScreenEvent.Opening
     * handler) so we never create a level mid screen-construction. Any failure is
     * swallowed: the user simply stays at the title screen.
     */
    static void enterFreshFlatWorld(GameType mode) {
        Minecraft mc = Minecraft.getInstance();
        mc.execute(() -> {
            try {
                resetWorld(mc);

                LevelSettings settings = new LevelSettings(
                    LEVEL_NAME,
                    mode,
                    false,                 // hardcore
                    Difficulty.NORMAL,
                    true,                  // allowCommands (cheats on — useful for tests)
                    new GameRules(),
                    WorldDataConfiguration.DEFAULT);

                // Bake the flat dimensions from the registry MC hands the function
                // — mirrors WorldPresets.createNormalWorldDimensions, with FLAT in
                // place of NORMAL.
                Function<RegistryAccess, WorldDimensions> flatDimensions = registries ->
                    registries.registryOrThrow(Registries.WORLD_PRESET)
                        .getHolderOrThrow(WorldPresets.FLAT)
                        .value()
                        .createWorldDimensions();

                LOG.info("[ModMixer Bridge] quicktest — creating fresh superflat {} world", mode);
                mc.createWorldOpenFlows().createFreshLevel(
                    LEVEL_NAME,
                    settings,
                    WorldOptions.defaultWithRandomSeed(),
                    flatDimensions,
                    mc.screen);
            } catch (Throwable t) {
                LOG.warn("[ModMixer Bridge] quicktest world creation failed; "
                    + "leaving the user at the title screen", t);
            }
        });
    }

    /**
     * Delete any existing quicktest world so each launch starts clean.
     * {@link LevelStorageSource.LevelStorageAccess#deleteLevel()} walks and
     * removes the save dir and closes its own directory lock; we still safeClose
     * in a finally so the lock is released if the delete throws partway. Uses
     * {@code mc.getLevelSource()} so the real saves dir is targeted regardless of
     * where the run's game directory lives.
     */
    private static void resetWorld(Minecraft mc) {
        try {
            LevelStorageSource source = mc.getLevelSource();
            if (!source.levelExists(LEVEL_NAME)) {
                return;
            }
            LevelStorageSource.LevelStorageAccess access = source.validateAndCreateAccess(LEVEL_NAME);
            try {
                access.deleteLevel();
            } finally {
                access.safeClose();
            }
        } catch (Throwable t) {
            // Non-fatal: createFreshLevel will overwrite level.dat anyway. Worst
            // case prior terrain lingers; log so it's visible in the console.
            LOG.warn("[ModMixer Bridge] could not clear prior quicktest world", t);
        }
    }
}
