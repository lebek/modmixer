package com.modmixer.bridge;

import java.util.List;

/**
 * Tiny hand-rolled JSON writer, a direct port of the RimWorld bridge's Json.cs.
 *
 * <p>We avoid pulling in Gson/Jackson so the bridge stays a single self-contained
 * jar with zero extra runtime deps (Log4j2 is already on the Minecraft
 * classpath). The escaping rules and value formatting below are kept identical
 * to the C# writer so both bridges emit byte-for-byte compatible payloads for
 * the same logical message — the ModMixer server parses them with the same
 * {@code JSON.parse} either way.
 *
 * <p>Not thread-safe; build one per message on the calling thread.
 */
final class Json {
    private final StringBuilder sb = new StringBuilder(256);
    // After writing a value, the next sibling needs a leading comma. After a key
    // (k) or an opening brace, it does not.
    private boolean needComma;

    Json obj() {
        comma();
        sb.append('{');
        needComma = false;
        return this;
    }

    Json endObj() {
        sb.append('}');
        needComma = true;
        return this;
    }

    Json arr() {
        comma();
        sb.append('[');
        needComma = false;
        return this;
    }

    Json endArr() {
        sb.append(']');
        needComma = true;
        return this;
    }

    Json k(String key) {
        comma();
        sb.append('"');
        escapeInto(sb, key);
        sb.append("\":");
        needComma = false;
        return this;
    }

    Json s(String value) {
        comma();
        if (value == null) {
            sb.append("null");
        } else {
            sb.append('"');
            escapeInto(sb, value);
            sb.append('"');
        }
        needComma = true;
        return this;
    }

    Json n(long value) {
        comma();
        sb.append(Long.toString(value));
        needComma = true;
        return this;
    }

    Json b(boolean value) {
        comma();
        sb.append(value ? "true" : "false");
        needComma = true;
        return this;
    }

    Json strs(List<String> values) {
        arr();
        if (values != null) {
            for (String v : values) {
                s(v);
            }
        }
        endArr();
        return this;
    }

    @Override
    public String toString() {
        return sb.toString();
    }

    private void comma() {
        if (needComma) {
            sb.append(',');
        }
    }

    private static void escapeInto(StringBuilder b, String s) {
        if (s == null) {
            return;
        }
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"':
                    b.append("\\\"");
                    break;
                case '\\':
                    b.append("\\\\");
                    break;
                case '\n':
                    b.append("\\n");
                    break;
                case '\r':
                    b.append("\\r");
                    break;
                case '\t':
                    b.append("\\t");
                    break;
                case '\b':
                    b.append("\\b");
                    break;
                case '\f':
                    b.append("\\f");
                    break;
                default:
                    if (c < 0x20) {
                        b.append(String.format("\\u%04X", (int) c));
                    } else {
                        b.append(c);
                    }
                    break;
            }
        }
    }
}
