package com.modmixer.bridge;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import net.minecraft.client.gui.screens.TitleScreen;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.neoforge.client.event.ScreenEvent;
import net.neoforged.neoforge.client.gui.LoadingErrorScreen;
import net.neoforged.neoforge.common.NeoForge;

/**
 * Client-only event hooks. Kept in a separate class so the dedicated server
 * never loads the client-only classes referenced here (TitleScreen,
 * ScreenEvent, LoadingErrorScreen) — {@link ModMixerBridge} only touches this
 * class behind a {@code FMLEnvironment.dist == CLIENT} guard.
 *
 * <p>Two signals are surfaced:
 * <ul>
 *   <li>{@link LoadingErrorScreen} opening — NeoForge shows this when mod
 *       loading failed. We harvest the loader's mod-loading issues (via the
 *       typed {@link LoadingIssues}, not off the screen) and emit one
 *       {@code error_event} per issue, then (in auto-exit mode) bail non-zero.</li>
 *   <li>{@link TitleScreen} opening — the client reached the main menu, i.e. a
 *       clean boot. That is the watchdog success trigger (exit 0 in auto-exit
 *       mode). We deliberately emit nothing on the wire — protocol.ts has no
 *       "clean run" message.</li>
 * </ul>
 */
final class ClientHooks {

    private static final Logger LOG = LoggerFactory.getLogger("modmixerbridge");

    private final ModMixerBridge owner;

    private ClientHooks(ModMixerBridge owner) {
        this.owner = owner;
    }

    /** Register a fresh instance on the game event bus. Client-side only. */
    static void register(ModMixerBridge owner) {
        NeoForge.EVENT_BUS.register(new ClientHooks(owner));
    }

    /**
     * Fires whenever a GUI screen opens. We only act on the loading-error and
     * title screens; everything else is ignored cheaply.
     *
     * VERIFY against 21.1.x: ScreenEvent.Opening lives in
     * net.neoforged.neoforge.client.event and exposes getScreen().
     */
    @SubscribeEvent
    public void onScreenOpening(ScreenEvent.Opening event) {
        var screen = event.getScreen();
        if (screen instanceof LoadingErrorScreen) {
            // The screen itself only exposes converted private records, so read
            // the canonical issue list from the loader instead.
            for (String errorEvent : LoadingIssues.harvest()) {
                owner.emit(errorEvent);
            }
            owner.triggerExit(true, "LoadingErrorScreen");
        } else if (screen instanceof TitleScreen) {
            LOG.info("[ModMixer Bridge] TitleScreen reached — clean run");
            owner.triggerExit(false, "TitleScreen");
        }
    }
}
