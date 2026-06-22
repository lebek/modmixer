package com.modmixer.bridge;

import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

import org.apache.logging.log4j.Level;
import org.apache.logging.log4j.core.Filter;
import org.apache.logging.log4j.core.LogEvent;
import org.apache.logging.log4j.core.appender.AbstractAppender;
import org.apache.logging.log4j.core.config.Property;

/**
 * Log4j2 appender attached to the ROOT logger at WARN level. This is how the
 * bridge captures errors from <em>inside</em> the running game: Minecraft and
 * essentially every mod log through Log4j2, so a root appender sees the WARN/
 * ERROR/FATAL stream — including uncaught exceptions Minecraft logs before it
 * dies — far more reliably than scraping the rotating Player log file.
 *
 * <p>This is the Java analogue of the RimWorld bridge patching
 * {@code Verse.Log.Error/Warning}. Where RimWorld captures by Harmony-patching
 * the log methods, here we register an appender — the idiomatic, supported
 * Log4j2 way to observe the log stream without touching mod code.
 *
 * <p>Dedup mirrors {@code ErrorsChannel}: a {@link ConcurrentHashMap} keyed by
 * the {@link ErrorFingerprint} hash. We emit exactly ONE {@code error_event}
 * per new fingerprint (the server handles re-prompt suppression for
 * recurrences; protocol.ts has no count/update field, so we deliberately do
 * NOT re-emit on recurrence — only the count map is bumped, for an optional
 * future channel and for the watchdog's "errors collected?" exit-code check).
 *
 * <p>The appender callback runs on whatever thread logged; it must be cheap and
 * non-blocking — it only builds a small JSON string and {@code offer}s it onto
 * the bridge's bounded queue.
 */
final class LogAppender extends AbstractAppender {

    private final BridgeClient client;
    /** Fingerprint -> recurrence count. First insert emits; later bumps don't. */
    private final ConcurrentHashMap<String, AtomicInteger> seen = new ConcurrentHashMap<>();
    /** Count of distinct error-severity (not warning) fingerprints, for exit code. */
    private final AtomicInteger errorCount = new AtomicInteger(0);

    /** Truncation cap, matching the C# bridge's 4096-char text cap. */
    private static final int TEXT_CAP = 4096;
    private static final int FIRST_LINE_CAP = 240;

    LogAppender(BridgeClient client) {
        // name, filter, layout(null -> we don't render), ignoreExceptions=true,
        // properties. ignoreExceptions=true => a failure here never propagates
        // back into the logging call site.
        super("ModMixerBridgeAppender", (Filter) null, null, true, Property.EMPTY_ARRAY);
        this.client = client;
    }

    /** Distinct error-severity fingerprints seen so far (for the exit code). */
    int errorCount() {
        return errorCount.get();
    }

    @Override
    public void append(LogEvent event) {
        try {
            // Root appender is configured at WARN, but guard anyway in case the
            // appender is attached without a level filter.
            Level level = event.getLevel();
            if (level == null || !level.isMoreSpecificThan(Level.WARN)) {
                return;
            }

            String severity = severityFor(level);
            String message = event.getMessage() != null
                ? event.getMessage().getFormattedMessage()
                : "";
            Throwable thrown = event.getThrown();
            String loggerName = event.getLoggerName();
            String threadName = event.getThreadName();

            String hash = ErrorFingerprint.compute(severity, thrown, message);

            // Dedup: only the FIRST occurrence of a fingerprint emits.
            AtomicInteger counter = seen.computeIfAbsent(hash, k -> new AtomicInteger(0));
            int n = counter.incrementAndGet();
            if (n > 1) {
                return; // recurrence — server-side re-prompt suppression owns this
            }

            if ("error".equals(severity)) {
                errorCount.incrementAndGet();
            }

            List<String> attributedMods = Attribution.modsFromStack(thrown);
            String fullText = buildFullText(loggerName, threadName, message, thrown);
            String firstLine = firstLineOf(message.isEmpty() && thrown != null
                ? thrown.toString()
                : message);

            String json = new Json().obj()
                .k("type").s("error_event")
                .k("severity").s(severity)
                .k("firstLine").s(firstLine)
                .k("text").s(truncate(fullText, TEXT_CAP))
                .k("attributedMods").strs(attributedMods)
                .k("hash").s(hash)
                .k("at").n(System.currentTimeMillis())
                .endObj()
                .toString();

            client.send(json);
        } catch (Throwable t) {
            // Diagnostic path: never throw back into the logging framework.
        }
    }

    /** protocol.ts ErrorSeverity: 'message' | 'warning' | 'error'. */
    private static String severityFor(Level level) {
        // ERROR and FATAL both map to "error"; WARN maps to "warning". We never
        // emit "message" from the appender (it only fires at >= WARN); that
        // value exists for parity with the RimWorld Log.Message channel.
        if (level.isMoreSpecificThan(Level.ERROR)) {
            return "error";
        }
        return "warning";
    }

    private static String buildFullText(String loggerName, String threadName,
                                        String message, Throwable thrown) {
        StringBuilder sb = new StringBuilder(256);
        sb.append('[').append(threadName == null ? "?" : threadName).append("] ");
        sb.append(loggerName == null ? "?" : loggerName).append(": ");
        sb.append(message == null ? "" : message);
        if (thrown != null) {
            sb.append('\n');
            appendStackTrace(sb, thrown, 0);
        }
        return sb.toString();
    }

    private static void appendStackTrace(StringBuilder sb, Throwable t, int depth) {
        if (t == null || depth > 8) {
            return;
        }
        sb.append(depth == 0 ? "" : "Caused by: ").append(t).append('\n');
        for (StackTraceElement el : t.getStackTrace()) {
            sb.append("\tat ").append(el).append('\n');
        }
        if (t.getCause() != null && t.getCause() != t) {
            appendStackTrace(sb, t.getCause(), depth + 1);
        }
    }

    private static String firstLineOf(String s) {
        if (s == null || s.isEmpty()) {
            return "";
        }
        int nl = s.indexOf('\n');
        String line = nl < 0 ? s : s.substring(0, nl);
        return line.length() > FIRST_LINE_CAP ? line.substring(0, FIRST_LINE_CAP) : line;
    }

    private static String truncate(String s, int max) {
        if (s == null || s.isEmpty()) {
            return "";
        }
        return s.length() <= max ? s : s.substring(0, max);
    }
}
