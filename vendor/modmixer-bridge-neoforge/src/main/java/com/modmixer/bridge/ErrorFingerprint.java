package com.modmixer.bridge;

import java.util.regex.Pattern;

/**
 * Stable fingerprint for an error occurrence, used as the dedup key the
 * ModMixer server buckets on (see server.ts {@code ingestErrorEvent}, keyed by
 * {@code hash}).
 *
 * <p>The hash algorithm is byte-for-byte identical to the RimWorld bridge's
 * {@code ErrorsChannel.HashFromStack} (FNV-1a offset basis seed, then a
 * {@code h = h*31 ^ c} mix per char, emitted as lowercase two's-complement
 * hex). We only need self-consistency within a single run — the server treats
 * the hash as an opaque string — but reusing the exact mix keeps the two
 * bridges visually identical and avoids surprises if a hash ever leaks into a
 * shared snapshot.
 *
 * <p>Java has no Harmony stack rewriting, so instead of hashing live
 * {@code StackFrame}s we hash a normalized signature built from:
 * <pre>
 *   level + exceptionClass + normalizedMessage + topN(normalizedStackFrames)
 * </pre>
 * Normalization strips per-occurrence noise (numbers, coordinates, hex hashes,
 * lambda/synthetic suffixes) so "same bug, different victim entity" collapses
 * to one bucket — the same intent as the C# call-site hash.
 */
final class ErrorFingerprint {

    /** FNV-1a 64-bit offset basis (signed), identical seed to the C# bridge. */
    private static final long FNV_OFFSET_BASIS = 1469598103934665603L;

    /** How many stack frames feed the signature. The call site is always near
     *  the top; deeper frames (render/update loops) drift across occurrences. */
    private static final int MAX_FRAMES = 8;

    // Numbers (incl. decimals/negatives) — entity ids, coords, counts, ticks.
    private static final Pattern NUMBERS = Pattern.compile("-?\\d+(?:\\.\\d+)?");
    // 0x-prefixed hex and bare long hex runs — object hashes, addresses.
    private static final Pattern HEX = Pattern.compile("0x[0-9a-fA-F]+|\\b[0-9a-fA-F]{8,}\\b");
    // Block/entity coordinates like "BlockPos{x=12, y=64, z=-3}" or "[12, 64, -3]".
    private static final Pattern COORDS = Pattern.compile("[\\[{(][^\\]})]*[,;][^\\]})]*[\\]})]");
    // Lambda / synthetic method suffixes that carry a counter, e.g. "lambda$foo$3".
    private static final Pattern LAMBDA = Pattern.compile("\\$\\$Lambda\\$\\d+/0x[0-9a-fA-F]+|lambda\\$[^/\\s]*\\$\\d+");

    private ErrorFingerprint() {
    }

    /**
     * Compute the dedup hash. Inputs that are null are treated as empty.
     *
     * @param level      severity string ("error" / "warning" / "message")
     * @param throwable  the captured Throwable, or null
     * @param message    the formatted log message
     */
    static String compute(String level, Throwable throwable, String message) {
        StringBuilder sig = new StringBuilder(256);
        sig.append(level == null ? "" : level).append('|');
        sig.append(throwable == null ? "" : throwable.getClass().getName()).append('|');
        sig.append(normalizeMessage(message)).append('|');

        if (throwable != null) {
            StackTraceElement[] frames = throwable.getStackTrace();
            int n = Math.min(frames.length, MAX_FRAMES);
            for (int i = 0; i < n; i++) {
                sig.append(normalizeFrame(frames[i])).append('\n');
            }
        }
        return hashString(sig.toString());
    }

    /**
     * The FNV-seed + {@code h*31 ^ c} mix, emitted as lowercase
     * two's-complement hex. Mirrors {@code ErrorsChannel.HashFromStack}:
     * C#'s {@code unchecked} long wraps exactly like Java long arithmetic, and
     * {@code long.ToString("x")} == {@code Long.toHexString(long)} (both print
     * the raw two's-complement nibbles, lowercase, no leading zeros).
     */
    static String hashString(String s) {
        long h = FNV_OFFSET_BASIS;
        for (int i = 0; i < s.length(); i++) {
            // h = h*31 ^ c, with Java long wraparound matching C# unchecked.
            h = ((h << 5) - h) ^ s.charAt(i);
        }
        return Long.toHexString(h);
    }

    /** Collapse per-occurrence noise out of a free-text message. */
    static String normalizeMessage(String message) {
        if (message == null || message.isEmpty()) {
            return "";
        }
        String s = message;
        // Order matters: coords/hex before bare numbers so their inner digits
        // don't get partially rewritten first.
        s = COORDS.matcher(s).replaceAll("{}");
        s = HEX.matcher(s).replaceAll("#");
        s = NUMBERS.matcher(s).replaceAll("#");
        // Keep only the first line; later lines are often the variable payload.
        int nl = s.indexOf('\n');
        if (nl >= 0) {
            s = s.substring(0, nl);
        }
        return s.trim();
    }

    /** A frame reduced to "declaringClass.method" with synthetic counters removed. */
    static String normalizeFrame(StackTraceElement frame) {
        if (frame == null) {
            return "";
        }
        String cls = frame.getClassName() == null ? "" : frame.getClassName();
        String method = frame.getMethodName() == null ? "" : frame.getMethodName();
        String combined = cls + "." + method;
        combined = LAMBDA.matcher(combined).replaceAll("lambda");
        // Strip a trailing "$1"-style synthetic class index that the JIT/compiler
        // can renumber across runs.
        return combined.replaceAll("\\$\\d+", "\\$");
    }
}
