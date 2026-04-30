using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Reflection;
using HarmonyLib;
using Verse;

namespace ModMixer.Bridge
{
    // Maps Harmony patch owners and stack frames back to mods. We rebuild an
    // Assembly -> mod-name dictionary from LoadedModManager, and snipe
    // Harmony's constructor with a prefix to bind each Harmony id to the
    // assembly that registered it.
    public static class Attribution
    {
        // Filled at init.
        private static readonly Dictionary<Assembly, string> AsmToMod =
            new Dictionary<Assembly, string>();

        // Harmony id -> assembly that created the Harmony() instance.
        private static readonly Dictionary<string, Assembly> HarmonyIdToAsm =
            new Dictionary<string, Assembly>();

        // Detected duplicate-id incidents (different mods using the same
        // Harmony id), reported as conflicts.
        public static readonly List<DuplicateIdIncident> DuplicateIds =
            new List<DuplicateIdIncident>();

        public static readonly object Lock = new object();

        public sealed class DuplicateIdIncident
        {
            public string HarmonyId;
            public string ModA;
            public string ModB;
        }

        public static void Initialize()
        {
            lock (Lock)
            {
                AsmToMod.Clear();
                HarmonyIdToAsm.Clear();
                DuplicateIds.Clear();

                foreach (var mod in LoadedModManager.RunningMods)
                {
                    if (mod?.assemblies?.loadedAssemblies == null) continue;
                    foreach (var asm in mod.assemblies.loadedAssemblies)
                    {
                        if (asm == null) continue;
                        if (!AsmToMod.ContainsKey(asm))
                            AsmToMod.Add(asm, mod.Name ?? mod.PackageId ?? "Unknown");
                    }
                }

                // Vanilla.
                var vanilla = typeof(Pawn).Assembly;
                if (!AsmToMod.ContainsKey(vanilla))
                    AsmToMod.Add(vanilla, "RimWorld");
            }
        }

        public static string ModForAssembly(Assembly asm)
        {
            if (asm == null) return "Unknown";
            lock (Lock)
            {
                if (AsmToMod.TryGetValue(asm, out var name)) return name;
            }
            var full = asm.FullName ?? "";
            if (full.IndexOf("UnityEngine", StringComparison.Ordinal) >= 0) return "RimWorld";
            if (full.IndexOf("0Harmony", StringComparison.Ordinal) >= 0) return "Harmony";
            return "Unknown";
        }

        public static string ModForHarmonyId(string id)
        {
            if (string.IsNullOrEmpty(id)) return "Unknown";
            Assembly asm;
            lock (Lock)
            {
                if (!HarmonyIdToAsm.TryGetValue(id, out asm)) return id;
            }
            return ModForAssembly(asm);
        }

        // Called by HarmonyCtorPatch — binds a Harmony id to the assembly that
        // is currently invoking new Harmony(id).
        public static void RegisterHarmonyId(string id, Assembly assembly)
        {
            if (string.IsNullOrEmpty(id) || assembly == null) return;
            lock (Lock)
            {
                if (HarmonyIdToAsm.TryGetValue(id, out var existing))
                {
                    if (existing != assembly)
                    {
                        DuplicateIds.Add(new DuplicateIdIncident
                        {
                            HarmonyId = id,
                            ModA = ModForAssembly(existing),
                            ModB = ModForAssembly(assembly),
                        });
                    }
                    return;
                }
                HarmonyIdToAsm.Add(id, assembly);
            }
        }

        // Walk the stack frames, collect the distinct mod names whose
        // assemblies appear. Skips Harmony frames, ours, and Unity. Falls
        // back to "RimWorld" if only vanilla frames are present.
        public static List<string> ModsFromStack(StackTrace trace)
        {
            var result = new List<string>();
            if (trace == null) return result;
            var seen = new HashSet<string>();
            var ourAsm = typeof(Attribution).Assembly;
            var harmonyAsm = typeof(Harmony).Assembly;

            foreach (var frame in trace.GetFrames() ?? Array.Empty<StackFrame>())
            {
                var method = Harmony.GetMethodFromStackframe(frame);
                if (method is MethodInfo mi)
                {
                    var orig = Harmony.GetOriginalMethod(mi);
                    if (orig != null) method = orig;
                }
                var asm = method?.DeclaringType?.Assembly ?? method?.ReflectedType?.Assembly;
                if (asm == null) continue;
                if (asm == ourAsm || asm == harmonyAsm) continue;
                var modName = ModForAssembly(asm);
                if (modName == "Harmony" || modName == "Unknown") continue;
                if (seen.Add(modName)) result.Add(modName);
            }

            if (result.Count == 0) result.Add("RimWorld");
            return result;
        }
    }

    [HarmonyPatch]
    internal static class HarmonyCtorPatch
    {
        public static IEnumerable<MethodBase> TargetMethods()
        {
            // The (string id) ctor is what mods call. Other overloads exist
            // but are uncommon; we don't catch them.
            yield return AccessTools.Constructor(typeof(Harmony), new[] { typeof(string) });
        }

        // Run BEFORE the original ctor. We walk the stack to find the caller's
        // assembly. Strict prefix (no return type bool) — we never short-circuit.
        public static void Prefix(string id)
        {
            try
            {
                var ourAsm = typeof(HarmonyCtorPatch).Assembly;
                var harmonyAsm = typeof(Harmony).Assembly;
                var trace = new StackTrace(1, false);
                foreach (var frame in trace.GetFrames() ?? Array.Empty<StackFrame>())
                {
                    var method = frame.GetMethod();
                    var asm = method?.DeclaringType?.Assembly ?? method?.ReflectedType?.Assembly;
                    if (asm == null) continue;
                    if (asm == ourAsm) continue;
                    if (asm == harmonyAsm) continue;
                    Attribution.RegisterHarmonyId(id, asm);
                    return;
                }
            }
            catch
            {
                // Never crash the game from a diagnostic patch.
            }
        }
    }
}
