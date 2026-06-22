package com.modmixer.bridge;

import java.io.IOException;
import java.io.OutputStream;
import java.io.Writer;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Single background-thread TCP client — the Java port of the RimWorld bridge's
 * {@code BridgeClient.cs}. Connects out to ModMixer's monitor server on
 * 127.0.0.1:port and writes newline-delimited UTF-8 JSON, one message per line.
 *
 * <p>Design constraints, matched from the C# bridge:
 * <ul>
 *   <li>Producers (the Log4j2 appender, screen-event handlers) NEVER block.
 *       They {@link #send(String)} onto a bounded {@link LinkedBlockingQueue};
 *       if the queue is full the line is dropped (offer, not put).</li>
 *   <li>The reporter thread is a daemon, so it can never keep the JVM alive.</li>
 *   <li>Reconnect with exponential backoff (500ms -&gt; 5000ms), so the game
 *       does not care whether ModMixer's server is listening first.</li>
 *   <li>On (re)connect we send {@code bridge_hello} immediately; the server
 *       uses {@code startedAt} to tell a real relaunch from a TCP blip.</li>
 *   <li>An optional NDJSON file fallback mirrors every queued line to disk so a
 *       crash-before-flush still yields a report; a shutdown hook drains the
 *       queue to that file.</li>
 * </ul>
 */
final class BridgeClient {

    private static final Logger LOG = LoggerFactory.getLogger("modmixerbridge");

    private static final String HOST = "127.0.0.1";
    private static final int INITIAL_BACKOFF_MS = 500;
    private static final int MAX_BACKOFF_MS = 5000;
    private static final int CONNECT_TIMEOUT_MS = 2000;
    /** Bounded so a runaway error cascade can't OOM the game; far above any
     *  healthy run. Excess lines are dropped, matching "never block producer". */
    private static final int QUEUE_CAPACITY = 4096;

    private final int port;
    private final String token; // optional, reserved; sent in hello if present
    private final String bridgeVersion;
    private final String gameVersion;
    private final long startedAtMs;
    private final Path reportFile; // NDJSON fallback path, or null

    private final LinkedBlockingQueue<String> outbox = new LinkedBlockingQueue<>(QUEUE_CAPACITY);
    private final AtomicBoolean stopping = new AtomicBoolean(false);
    private volatile boolean connected = false;
    private Thread thread;
    private Writer reportWriter; // guarded by reportLock
    private final Object reportLock = new Object();

    BridgeClient(int port, String token, String bridgeVersion, String gameVersion,
                 long startedAtMs, Path reportFile) {
        this.port = port;
        this.token = token;
        this.bridgeVersion = bridgeVersion;
        this.gameVersion = gameVersion;
        this.startedAtMs = startedAtMs;
        this.reportFile = reportFile;
    }

    boolean isConnected() {
        return connected;
    }

    /** Start the daemon reporter thread and register the shutdown-flush hook. */
    void start() {
        openReportFile();
        thread = new Thread(this::runLoop, "ModMixerBridgeReporter");
        thread.setDaemon(true);
        thread.start();

        Runtime.getRuntime().addShutdownHook(new Thread(this::onShutdown, "ModMixerBridgeShutdown"));
    }

    void stop() {
        stopping.set(true);
        // Nudge the queue so the take() unblocks promptly.
        outbox.offer("");
    }

    /**
     * Enqueue one already-serialized JSON line (no trailing newline). Never
     * blocks: drops on a full queue. Always mirrors to the NDJSON file first so
     * a crash before the socket flushes still records the event.
     */
    void send(String line) {
        if (line == null || line.isEmpty()) {
            return;
        }
        appendToReportFile(line);
        // offer(), never put(): the producer must not block the game thread.
        outbox.offer(line);
    }

    // ---- reporter thread -----------------------------------------------------

    private void runLoop() {
        int backoff = INITIAL_BACKOFF_MS;
        while (!stopping.get()) {
            Socket socket = null;
            try {
                socket = new Socket();
                socket.setTcpNoDelay(true);
                socket.connect(new InetSocketAddress(HOST, port), CONNECT_TIMEOUT_MS);
                connected = true;
                backoff = INITIAL_BACKOFF_MS;

                OutputStream out = socket.getOutputStream();
                writeLine(out, buildHello());
                pumpOutbox(socket, out);
            } catch (Throwable t) {
                // Expected when ModMixer's server isn't listening yet.
            } finally {
                connected = false;
                closeQuietly(socket);
            }

            if (stopping.get()) {
                break;
            }
            sleep(backoff);
            backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
        }
        closeReportFile();
    }

    /** Drain the queue to the socket, blocking on the queue. Throws on socket
     *  error so the outer loop reconnects. */
    private void pumpOutbox(Socket socket, OutputStream out) throws IOException, InterruptedException {
        while (!stopping.get()) {
            String line = outbox.poll(1, TimeUnit.SECONDS);
            if (stopping.get()) {
                return;
            }
            if (line == null) {
                // Idle: cheap liveness probe so a dead peer triggers reconnect.
                if (socket.isClosed() || !socket.isConnected()) {
                    throw new IOException("peer gone");
                }
                continue;
            }
            if (line.isEmpty()) {
                continue; // wake-up sentinel
            }
            writeLine(out, line);
        }
    }

    private String buildHello() {
        // Field names mirror protocol.ts BridgeHello EXACTLY. The TS type names
        // the version field `rimworldVersion` and that is the only field the
        // server reads for the connection banner, so we MUST emit it. We also
        // add a forward-looking `gameVersion` alias carrying the same value; the
        // server ignores unknown fields (JSON.parse) so this is safe.
        Json j = new Json().obj()
            .k("type").s("bridge_hello")
            .k("protocol").n(ModMixerBridge.PROTOCOL_VERSION)
            .k("rimworldVersion").s(gameVersion)
            .k("gameVersion").s(gameVersion)
            .k("bridgeVersion").s(bridgeVersion)
            .k("startedAt").n(startedAtMs);
        if (token != null && !token.isEmpty()) {
            j.k("token").s(token);
        }
        return j.endObj().toString();
    }

    private static void writeLine(OutputStream out, String line) throws IOException {
        byte[] bytes = (line + "\n").getBytes(StandardCharsets.UTF_8);
        out.write(bytes);
        out.flush();
    }

    // ---- NDJSON file fallback ------------------------------------------------

    private void openReportFile() {
        if (reportFile == null) {
            return;
        }
        try {
            Path parent = reportFile.getParent();
            if (parent != null) {
                Files.createDirectories(parent);
            }
            synchronized (reportLock) {
                reportWriter = Files.newBufferedWriter(
                    reportFile,
                    StandardCharsets.UTF_8,
                    StandardOpenOption.CREATE,
                    StandardOpenOption.WRITE,
                    StandardOpenOption.APPEND);
            }
        } catch (Throwable t) {
            LOG.warn("[ModMixer Bridge] could not open report file {}", reportFile, t);
        }
    }

    private void appendToReportFile(String line) {
        synchronized (reportLock) {
            if (reportWriter == null) {
                return;
            }
            try {
                reportWriter.write(line);
                reportWriter.write('\n');
                reportWriter.flush();
            } catch (Throwable t) {
                // Best effort; don't let a disk error perturb the game.
            }
        }
    }

    private void closeReportFile() {
        synchronized (reportLock) {
            if (reportWriter != null) {
                try {
                    reportWriter.flush();
                    reportWriter.close();
                } catch (Throwable ignored) {
                    // ignore
                }
                reportWriter = null;
            }
        }
    }

    /** Shutdown hook: drain any still-queued lines to the NDJSON file. The
     *  socket may already be gone, but the file gives ModMixer a last report. */
    private void onShutdown() {
        try {
            List<String> remaining = new ArrayList<>();
            outbox.drainTo(remaining);
            for (String line : remaining) {
                if (line != null && !line.isEmpty()) {
                    appendToReportFile(line);
                }
            }
        } catch (Throwable ignored) {
            // ignore
        } finally {
            closeReportFile();
        }
    }

    /** Block until the outbox is empty or {@code timeoutMs} elapses, then close
     *  the report file. Used by the watchdog before a clean System.exit so the
     *  final error_events make it out the socket. */
    void flushAndClose(long timeoutMs) {
        long deadline = System.currentTimeMillis() + timeoutMs;
        while (!outbox.isEmpty() && System.currentTimeMillis() < deadline) {
            sleep(20);
        }
        closeReportFile();
    }

    // ---- helpers -------------------------------------------------------------

    private static void closeQuietly(Socket socket) {
        if (socket != null) {
            try {
                socket.close();
            } catch (IOException ignored) {
                // ignore
            }
        }
    }

    private static void sleep(int ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
