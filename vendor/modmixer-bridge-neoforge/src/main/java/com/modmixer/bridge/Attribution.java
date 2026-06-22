package com.modmixer.bridge;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import net.neoforged.fml.ModList;
import net.neoforged.neoforgespi.language.IModInfo;
import net.neoforged.neoforgespi.language.ModFileScanData;

/**
 * Maps stack-trace packages back to the mod that owns them — the Java analogue
 * of the RimWorld bridge's {@code Attribution.ModsFromStack}.
 *
 * <p>RimWorld can ask Harmony which assembly registered a patch; the JVM has no
 * such registry, so we approximate by package ownership. At init we build a
 * {@code packagePrefix -> modId} table from the loaded mod list (each mod's
 * declared root package), then walk a Throwable's frames and collect the
 * distinct mods whose package owns a frame.
 *
 * <p>Falls back to "Minecraft" when only vanilla/loader frames are present, and
 * never returns an empty list (the {@code attributedMods} field in protocol.ts
 * is always populated; the RimWorld bridge guarantees the same).
 *
 * <p>Thread-safe: the table is built once and read-only thereafter.
 */
final class Attribution {

    /** Longest-prefix-wins package -> modId map. Insertion order is longest-first. */
    private static volatile Map<String, String> packageToMod = new LinkedHashMap<>();

    /** Package prefixes that are vanilla / loader / JDK and should be ignored. */
    private static final String[] VANILLA_PREFIXES = {
        "net.minecraft.",
        "com.mojang.",
        "net.neoforged.",
        "cpw.mods.",
        "org.apache.logging.",
        "java.",
        "jdk.",
        "sun.",
        "com.modmixer.bridge.", // our own frames never attribute to a user mod
    };

    private Attribution() {
    }

    /**
     * Build the package->mod table from the loaded mod list. Safe to call once
     * the mod list is populated (constructor time is fine on NeoForge — ModList
     * is available by the time mod constructors run).
     */
    static void initialize() {
        Map<String, String> map = new LinkedHashMap<>();
        try {
            ModList modList = ModList.get();
            if (modList != null) {
                for (IModInfo mod : modList.getMods()) {
                    String modId = mod.getModId();
                    if (modId == null || modId.isEmpty()) {
                        continue;
                    }
                    for (String pkg : rootPackagesOf(mod)) {
                        // Don't let our own mod or the loader masquerade as a user mod.
                        if (isVanillaPackage(pkg + ".")) {
                            continue;
                        }
                        map.putIfAbsent(pkg + ".", modId);
                    }
                }
            }
        } catch (Throwable t) {
            // Diagnostic path: an attribution failure must never break the game.
        }
        // Sort longest-prefix-first so "com.foo.sub" wins over "com.foo".
        Map<String, String> sorted = new LinkedHashMap<>();
        map.entrySet().stream()
            .sorted((a, bEntry) -> Integer.compare(bEntry.getKey().length(), a.getKey().length()))
            .forEach(e -> sorted.put(e.getKey(), e.getValue()));
        packageToMod = sorted;
    }

    /**
     * Distinct mod ids whose package owns a frame in this Throwable's stack,
     * top-down. Returns ["Minecraft"] if only vanilla frames are present, and
     * ["Unknown"] only if there is no stack at all.
     */
    static List<String> modsFromStack(Throwable throwable) {
        List<String> result = new ArrayList<>();
        if (throwable == null) {
            result.add("Unknown");
            return result;
        }
        Set<String> seen = new LinkedHashSet<>();
        // Walk the causal chain too — the root cause frames often name the mod.
        Throwable t = throwable;
        int guard = 0;
        while (t != null && guard++ < 16) {
            for (StackTraceElement frame : t.getStackTrace()) {
                String cls = frame.getClassName();
                if (cls == null || isVanillaClass(cls)) {
                    continue;
                }
                String mod = modForClass(cls);
                if (mod != null && seen.add(mod)) {
                    result.add(mod);
                }
            }
            t = t.getCause();
        }
        if (result.isEmpty()) {
            result.add("Minecraft");
        }
        return result;
    }

    /** Resolve a single class name to its owning mod id, or null if unattributed. */
    static String modForClass(String className) {
        if (className == null) {
            return null;
        }
        for (Map.Entry<String, String> e : packageToMod.entrySet()) {
            if (className.startsWith(e.getKey())) {
                return e.getValue();
            }
        }
        return null;
    }

    private static boolean isVanillaClass(String className) {
        return isVanillaPackage(className);
    }

    private static boolean isVanillaPackage(String s) {
        for (String prefix : VANILLA_PREFIXES) {
            if (s.startsWith(prefix)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Best-effort root packages for a mod. IModInfo does not publish a clean
     * "root package" accessor, so we read the mod's scanned class set from its
     * file's {@code ModFileScanData} and reduce each class to a 2-3 segment
     * package prefix, taking the distinct set.
     *
     * <p>The accessor chain
     * {@code IModInfo.getOwningFile().getFile().getScanResult().getClasses()}
     * and {@code ClassData.clazz().getClassName()} were verified against
     * neoforged/FancyModLoader. {@code ClassData.clazz()} is an ASM
     * {@code org.objectweb.asm.Type} (on the loader classpath). Wrapped in
     * try/catch so any drift degrades to "Unknown" attribution, never a crash.
     */
    private static List<String> rootPackagesOf(IModInfo mod) {
        List<String> packages = new ArrayList<>();
        try {
            ModFileScanData scanData = mod.getOwningFile().getFile().getScanResult();
            if (scanData == null) {
                return packages;
            }
            Set<String> prefixes = new LinkedHashSet<>();
            for (ModFileScanData.ClassData c : scanData.getClasses()) {
                String name = c.clazz().getClassName();
                String pkg = packagePrefix(name);
                if (pkg != null && !isVanillaPackage(pkg + ".")) {
                    prefixes.add(pkg);
                }
            }
            packages.addAll(prefixes);
        } catch (Throwable t) {
            // Fall through to empty — attribution simply won't fire for this mod.
        }
        return packages;
    }

    /** Reduce a fully-qualified class name to a 2-3 segment package prefix. */
    private static String packagePrefix(String className) {
        if (className == null) {
            return null;
        }
        int lastDot = className.lastIndexOf('.');
        if (lastDot < 0) {
            return null;
        }
        String pkg = className.substring(0, lastDot);
        // Keep at most the first 3 segments so "com.foo.bar.baz.Thing" -> "com.foo.bar".
        String[] parts = pkg.split("\\.");
        int keep = Math.min(parts.length, 3);
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < keep; i++) {
            if (i > 0) {
                b.append('.');
            }
            b.append(parts[i]);
        }
        return b.toString();
    }
}
