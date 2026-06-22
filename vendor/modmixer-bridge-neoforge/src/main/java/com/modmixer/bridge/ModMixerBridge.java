package com.modmixer.bridge;

import java.nio.file.Path;
import java.util.concurrent.atomic.AtomicBoolean;

import org.apache.logging.log4j.Level;
import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.core.LoggerContext;
import org.apache.logging.log4j.core.config.LoggerConfig;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import net.neoforged.api.distmarker.Dist;
import net.neoforged.bus.api.IEventBus;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.common.Mod;
import net.neoforged.fml.event.lifecycle.FMLLoadCompleteEvent;
import net.neoforged.fml.loading.FMLEnvironment;
import net.neoforged.fml.loading.FMLLoader;
import net.neoforged.neoforge.common.NeoForge;

/**
 * ModMixer NeoForge bridge — entry point.
 *
 * <p>At test time the ModMixer desktop app launches the modded client via
 * Gradle {@code runClient} with this mod on the classpath alongside the user's
 * mod. The constructor stands up everything immediately:
 * <ol>
 *   <li>reads the target port / token / timeout / report-file from
 *       {@code -Dmodmixer.*} system properties;</li>
 *   <li>spawns a daemon {@link BridgeClient} reporter thread (bounded queue,
 *       reconnect/backoff) and sends {@code bridge_hello};</li>
 *   <li>attaches a {@link LogAppender} to the Log4j2 ROOT logger at WARN to
 *       capture in-game errors;</li>
 *   <li>on the client, registers {@link ClientHooks} for load-failure /
 *       clean-run screen signals;</li>
 *   <li>arms a wall-clock watchdog that, only if a test timeout was supplied,
 *       auto-exits the process on first of {TitleScreen reached / timeout /
 *       LoadingErrorScreen}.</li>
 * </ol>
 *
 * <p>System properties (all optional unless noted):
 * <ul>
 *   <li>{@code modmixer.port} — TCP port of ModMixer's monitor server
 *       (default {@value #DEFAULT_PORT}).</li>
 *   <li>{@code modmixer.token} — opaque handshake token, echoed in
 *       {@code bridge_hello} if present.</li>
 *   <li>{@code modmixer.testTimeoutMs} — if set, enables auto-exit mode (the
 *       watchdog). If absent, the bridge is purely passive (interactive use).</li>
 *   <li>{@code modmixer.reportFile} — path to append NDJSON fallback records to,
 *       drained on shutdown.</li>
 * </ul>
 *
 * <p>Dist safety: all references to client-only Minecraft/NeoForge classes
 * (TitleScreen, ScreenEvent, LoadingErrorScreen) live in {@link ClientHooks},
 * which is only loaded/registered when {@code FMLEnvironment.dist == CLIENT}.
 * The mod is declared side=BOTH so it also loads cleanly on a dedicated server.
 */
@Mod(ModMixerBridge.MOD_ID)
public final class ModMixerBridge {

    public static final String MOD_ID = "modmixerbridge";
    public static final String BRIDGE_VERSION = "0.1.0";

    /** Wire protocol version — must equal BRIDGE_PROTOCOL_VERSION in protocol.ts. */
    public static final int PROTOCOL_VERSION = 1;

    /** Default monitor port — must equal BRIDGE_PORT in protocol.ts. */
    public static final int DEFAULT_PORT = 13371;

    private static final Logger LOG = LoggerFactory.getLogger(MOD_ID);

    /** ms-since-epoch the bridge initialized — the run identity the server keys on. */
    public static final long STARTED_AT_MS = System.currentTimeMillis();

    private final BridgeClient client;
    private final LogAppender appender;

    /** Auto-exit enabled iff modmixer.testTimeoutMs was supplied. */
    private final boolean autoExit;
    private final long testTimeoutMs;
    /** Guards against multiple exit triggers racing (timeout vs. screen event). */
    private final AtomicBoolean exited = new AtomicBoolean(false);

    /**
     * NeoForge invokes this constructor with the mod's event bus. We register
     * mod-bus listeners on the supplied bus (lifecycle events like
     * FMLLoadCompleteEvent) and game-bus listeners on {@link NeoForge#EVENT_BUS}.
     *
     * VERIFY against 21.1.x: on the 21.1.x line the @Mod constructor accepting a
     * single {@code IEventBus} (the mod event bus) is supported by FML's mod
     * instantiation. A {@code (IEventBus, ModContainer)} or
     * {@code (FMLModContainer, IEventBus, Dist)} form is also accepted; this is
     * the minimal one.
     */
    public ModMixerBridge(IEventBus modEventBus) {
        int port = intProp("modmixer.port", DEFAULT_PORT);
        String token = System.getProperty("modmixer.token");
        Path reportFile = pathProp("modmixer.reportFile");

        Long timeout = longProp("modmixer.testTimeoutMs");
        this.autoExit = timeout != null;
        this.testTimeoutMs = timeout != null ? timeout : 0L;

        String gameVersion = safeMinecraftVersion();

        // (a) Reporter thread + bridge_hello.
        this.client = new BridgeClient(
            port, token, BRIDGE_VERSION, gameVersion, STARTED_AT_MS, reportFile);

        // Attribution table (package -> mod). ModList is available at ctor time.
        Attribution.initialize();

        this.client.start();

        // (b) Log4j2 ROOT appender at WARN.
        this.appender = attachRootAppender(this.client);

        // Mod-bus lifecycle listeners.
        modEventBus.register(this);

        // (c) Client-only screen hooks — load-failure + clean-run signals. Only
        // touch client classes on the client; on a dedicated server the
        // LoadingErrorScreen/TitleScreen path is simply absent (FML shows the
        // failure on the console instead, which the appender already captures).
        if (FMLEnvironment.dist == Dist.CLIENT) {
            ClientHooks.register(this);
        }

        // (e) Watchdog (only auto-exits when a test timeout was supplied).
        startWatchdog();

        LOG.info("[ModMixer Bridge] active — port={} game={} autoExit={} timeoutMs={}",
            port, gameVersion, autoExit, testTimeoutMs);
    }

    // ---- callbacks used by ClientHooks --------------------------------------

    /** Emit one already-serialized error_event line. */
    void emit(String json) {
        client.send(json);
    }

    // ---- Log4j2 wiring -------------------------------------------------------

    /**
     * Attach our appender to the ROOT LoggerConfig at WARN. We start the
     * appender, add it to the config, and refresh contexts so it takes effect.
     *
     * VERIFY against the running Log4j2 version: NeoForge 1.21.1 ships Log4j2
     * 2.x where {@code LogManager.getContext(false)} returns a core
     * {@code LoggerContext}. The cast and {@code getConfiguration()} /
     * {@code getRootLogger()} shape below are stable across 2.17–2.24; guarded
     * so a surprise simply logs a warning and the screen-event channel for
     * load-time issues still works.
     */
    private static LogAppender attachRootAppender(BridgeClient client) {
        LogAppender appender = new LogAppender(client);
        try {
            appender.start();
            LoggerContext ctx = (LoggerContext) LogManager.getContext(false);
            var config = ctx.getConfiguration();
            LoggerConfig root = config.getRootLogger();
            // Add to the root config at WARN; null filter. additive logging is
            // unaffected — the console/file appenders keep running too.
            root.addAppender(appender, Level.WARN, null);
            ctx.updateLoggers();
        } catch (Throwable t) {
            LOG.warn("[ModMixer Bridge] could not attach root log appender; "
                + "in-game error capture disabled (load-failure capture still active)", t);
        }
        return appender;
    }

    // ---- Mod-bus lifecycle ---------------------------------------------------

    /** Mod loading finished without a fatal error screen. */
    @SubscribeEvent
    public void onLoadComplete(FMLLoadCompleteEvent event) {
        LOG.info("[ModMixer Bridge] FMLLoadCompleteEvent — mod load complete");
        // No dedicated protocol message; this is purely an internal milestone
        // (could feed a future "load_complete" channel). Watchdog success is
        // driven by TitleScreen, the more meaningful "the user can play" signal
        // for a client run.
    }

    // ---- Watchdog ------------------------------------------------------------

    /**
     * Wall-clock watchdog. Only started when {@code modmixer.testTimeoutMs} was
     * supplied. On the deadline it exits non-zero if any error-severity events
     * were collected, else zero — a timeout with no errors is treated as a
     * (slow) clean run.
     */
    private void startWatchdog() {
        if (!autoExit) {
            return; // interactive use: never auto-exit
        }
        Thread t = new Thread(() -> {
            try {
                Thread.sleep(testTimeoutMs);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            }
            LOG.warn("[ModMixer Bridge] test timeout ({} ms) elapsed", testTimeoutMs);
            triggerExit(appender != null && appender.errorCount() > 0, "timeout");
        }, "ModMixerBridgeWatchdog");
        t.setDaemon(true);
        t.start();
    }

    /**
     * Flush and exit, once. {@code error} forces a non-zero code; otherwise we
     * exit 0 unless the appender collected error-severity events during the run.
     * No-op when auto-exit is disabled (interactive mode). Called from the
     * watchdog and from {@link ClientHooks} on the screen signals.
     */
    void triggerExit(boolean error, String reason) {
        if (!autoExit) {
            return;
        }
        if (!exited.compareAndSet(false, true)) {
            return; // someone already won the race
        }
        boolean hadErrors = error || (appender != null && appender.errorCount() > 0);
        int code = hadErrors ? 1 : 0;
        LOG.info("[ModMixer Bridge] exiting (reason={}, code={})", reason, code);
        // Give the reporter a moment to drain the socket before we go.
        client.flushAndClose(1500);
        client.stop();
        // exit() (not halt()) so the JVM's other shutdown hooks — including our
        // BridgeClient NDJSON flush hook — get a chance to run for a clean
        // teardown of the game.
        System.exit(code);
    }

    // ---- helpers -------------------------------------------------------------

    private static String safeMinecraftVersion() {
        try {
            // FMLLoader exposes the resolved Minecraft version of the running
            // workspace. VERIFY against 21.1.x: FMLLoader.versionInfo() returns a
            // VersionInfo record with mcVersion(); guarded so a rename falls back.
            var info = FMLLoader.versionInfo();
            if (info != null) {
                return info.mcVersion();
            }
        } catch (Throwable ignored) {
            // fall through
        }
        // Pinned fallback — this bridge ships for exactly 1.21.1.
        return "1.21.1";
    }

    private static int intProp(String key, int dflt) {
        try {
            String v = System.getProperty(key);
            return v == null ? dflt : Integer.parseInt(v.trim());
        } catch (RuntimeException e) {
            return dflt;
        }
    }

    private static Long longProp(String key) {
        try {
            String v = System.getProperty(key);
            return v == null ? null : Long.parseLong(v.trim());
        } catch (RuntimeException e) {
            return null;
        }
    }

    private static Path pathProp(String key) {
        String v = System.getProperty(key);
        if (v == null || v.trim().isEmpty()) {
            return null;
        }
        try {
            return Path.of(v.trim());
        } catch (RuntimeException e) {
            return null;
        }
    }
}
