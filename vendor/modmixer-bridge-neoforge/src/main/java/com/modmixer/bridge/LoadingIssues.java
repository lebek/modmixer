package com.modmixer.bridge;

import java.util.ArrayList;
import java.util.List;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import net.neoforged.fml.ModLoader;
import net.neoforged.fml.ModLoadingIssue;
import net.neoforged.neoforgespi.language.IModInfo;

/**
 * Reads NeoForge's canonical mod-loading issue list and turns each issue into a
 * bridge {@code error_event} payload. The Java analogue of the load-failure half
 * of the RimWorld bridge.
 *
 * <p>Source of truth: {@code net.neoforged.fml.ModLoader.getLoadingIssues()},
 * which returns the typed {@code List<ModLoadingIssue>} the loader accumulated.
 * We deliberately read it from the loader rather than off the
 * {@code LoadingErrorScreen}, because the screen converts the issues into
 * private {@code FormattedIssue} records on construction and does not expose the
 * originals.
 *
 * <p>{@code ModLoadingIssue} (net.neoforged.fml) is a record on the 21.1.x line:
 * <pre>
 *   record ModLoadingIssue(Severity severity, String translationKey,
 *                          List&lt;Object&gt; translationArgs, Throwable cause,
 *                          Path affectedPath, IModFile affectedModFile,
 *                          IModInfo affectedMod)
 *   enum Severity { WARNING, ERROR }
 * </pre>
 * Verified against neoforged/FancyModLoader. {@code ModLoader.getLoadingIssues()}
 * is marked {@code @ApiStatus.Internal} but is {@code public static}; it is the
 * only stable handle on the full issue list. If a future patch removes it the
 * whole call is guarded and degrades to "no load issues harvested".
 *
 * <p>This class is side-agnostic (everything it touches lives in
 * {@code net.neoforged.fml}); only the screen <em>trigger</em> in
 * {@link ClientHooks} is client-only.
 */
final class LoadingIssues {

    private static final Logger LOG = LoggerFactory.getLogger("modmixerbridge");
    private static final int TEXT_CAP = 4096;

    private LoadingIssues() {
    }

    /** Build one error_event JSON string per current loading issue. */
    static List<String> harvest() {
        List<String> out = new ArrayList<>();
        List<ModLoadingIssue> issues;
        try {
            issues = ModLoader.getLoadingIssues();
        } catch (Throwable t) {
            LOG.warn("[ModMixer Bridge] ModLoader.getLoadingIssues() unavailable (API drift?)", t);
            return out;
        }
        if (issues == null || issues.isEmpty()) {
            return out;
        }
        for (ModLoadingIssue issue : issues) {
            try {
                out.add(toEvent(issue));
            } catch (Throwable t) {
                // Skip a malformed issue rather than abort the whole harvest.
            }
        }
        return out;
    }

    private static String toEvent(ModLoadingIssue issue) {
        boolean isError = issue.severity() == ModLoadingIssue.Severity.ERROR;
        String severity = isError ? "error" : "warning";

        String translationKey = issue.translationKey();
        String firstLine = translationKey != null ? translationKey : "Mod loading issue";

        String affectedModId = null;
        IModInfo affected = issue.affectedMod();
        if (affected != null) {
            affectedModId = affected.getModId();
        }

        Throwable cause = issue.cause();

        StringBuilder text = new StringBuilder();
        text.append(firstLine);
        List<Object> args = issue.translationArgs();
        if (args != null && !args.isEmpty()) {
            text.append(' ').append(args);
        }
        if (affectedModId != null) {
            text.append("\naffectedMod: ").append(affectedModId);
        }
        if (issue.affectedPath() != null) {
            text.append("\naffectedPath: ").append(issue.affectedPath());
        }
        if (cause != null) {
            text.append('\n').append(stackToString(cause));
        }

        List<String> mods = new ArrayList<>();
        if (affectedModId != null && !affectedModId.isEmpty()) {
            mods.add(affectedModId);
        } else {
            mods.addAll(Attribution.modsFromStack(cause));
        }

        // Fingerprint off the stable bits — translation key + affected mod +
        // cause class — so the same load failure dedups across relaunch attempts.
        String hash = ErrorFingerprint.hashString(
            severity + "|" + firstLine + "|"
                + (affectedModId == null ? "" : affectedModId) + "|"
                + (cause == null ? "" : cause.getClass().getName()));

        return new Json().obj()
            .k("type").s("error_event")
            .k("severity").s(severity)
            .k("firstLine").s(firstLine)
            .k("text").s(truncate(text.toString(), TEXT_CAP))
            .k("attributedMods").strs(mods)
            .k("hash").s(hash)
            .k("at").n(System.currentTimeMillis())
            .endObj()
            .toString();
    }

    private static String truncate(String s, int max) {
        if (s == null || s.isEmpty()) {
            return "";
        }
        return s.length() <= max ? s : s.substring(0, max);
    }

    private static String stackToString(Throwable t) {
        if (t == null) {
            return "";
        }
        StringBuilder sb = new StringBuilder();
        sb.append(t).append('\n');
        for (StackTraceElement el : t.getStackTrace()) {
            sb.append("\tat ").append(el).append('\n');
        }
        Throwable cause = t.getCause();
        int guard = 0;
        while (cause != null && cause != t && guard++ < 8) {
            sb.append("Caused by: ").append(cause).append('\n');
            for (StackTraceElement el : cause.getStackTrace()) {
                sb.append("\tat ").append(el).append('\n');
            }
            cause = cause.getCause();
        }
        return sb.toString();
    }
}
