using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using HarmonyLib;
using Verse;

namespace ModMixer.Bridge
{
    // Builds and sends a snapshot of:
    //  - load order + assembly counts per mod
    //  - the full Harmony patch graph, with mod attribution
    //  - detected conflicts (destructive prefix collisions, duplicate harmony
    //    ids, stacked transpilers)
    //
    // Snapshot once on connect, then every 30s in case mods register late
    // patches.
    public static class ModsChannel
    {
        private static long lastSnapshotMs;

        public static void Tick(BridgeClient client, long nowMs)
        {
            if (lastSnapshotMs != 0 && nowMs - lastSnapshotMs < 30_000) return;
            Snapshot(client, nowMs);
        }

        public static void Snapshot(BridgeClient client, long nowMs)
        {
            string json;
            try
            {
                json = BuildSnapshot(nowMs);
            }
            catch (Exception ex)
            {
                Log.Warning("[ModMixerBridge] snapshot failed: " + ex.Message);
                return;
            }
            client.Send(json);
            lastSnapshotMs = nowMs;
        }

        private static string BuildSnapshot(long nowMs)
        {
            var modsList = LoadedModManager.RunningMods?.ToList() ?? new List<ModContentPack>();

            // Per-mod aggregates: patchCount and destructivePrefixCount.
            var perMod = new Dictionary<string, ModAggregate>(modsList.Count);
            foreach (var m in modsList)
            {
                perMod[NameOf(m)] = new ModAggregate { Mod = m };
            }

            var patches = new List<PatchRow>();
            var conflicts = new List<ConflictRow>();

            foreach (var method in Harmony.GetAllPatchedMethods())
            {
                var info = Harmony.GetPatchInfo(method);
                if (info == null) continue;

                // Backfill: mods that registered Harmony before our ctor patch
                // was installed have unknown ids. We can recover the owning
                // assembly from any of their patch methods.
                BackfillOwners(info.Prefixes);
                BackfillOwners(info.Postfixes);
                BackfillOwners(info.Transpilers);
                BackfillOwners(info.Finalizers);

                var row = new PatchRow
                {
                    MethodSig = SignatureOf(method),
                    Prefixes = ModNamesOfPatches(info.Prefixes),
                    Postfixes = ModNamesOfPatches(info.Postfixes),
                    Transpilers = ModNamesOfPatches(info.Transpilers),
                    Finalizers = ModNamesOfPatches(info.Finalizers),
                    DestructiveBy = DestructivePatchOwnerMods(info.Prefixes),
                };

                // Tally per-mod. info.Prefixes etc are ReadOnlyCollection<Patch>.
                foreach (var p in info.Prefixes) Bump(perMod, p, isPrefix: true, prefixIsDestructive: PatchIsDestructive(p));
                foreach (var p in info.Postfixes) Bump(perMod, p, isPrefix: false, prefixIsDestructive: false);
                foreach (var p in info.Transpilers) Bump(perMod, p, isPrefix: false, prefixIsDestructive: false);
                foreach (var p in info.Finalizers) Bump(perMod, p, isPrefix: false, prefixIsDestructive: false);

                patches.Add(row);

                // Conflict: 2+ destructive prefixes from different mods.
                if (row.DestructiveBy.Count >= 2)
                {
                    conflicts.Add(new ConflictRow
                    {
                        Kind = "double_destructive_prefix",
                        Mods = row.DestructiveBy,
                        Subject = row.MethodSig,
                        Detail = "Multiple mods install a destructive prefix on this method; only one will actually run.",
                    });
                }
                // Conflict: stacked transpilers across multiple mods on the same method.
                var distinctTranspilers = row.Transpilers.Distinct().ToList();
                if (distinctTranspilers.Count >= 2)
                {
                    conflicts.Add(new ConflictRow
                    {
                        Kind = "stacked_transpilers",
                        Mods = distinctTranspilers,
                        Subject = row.MethodSig,
                        Detail = "Multiple mods rewrite IL on this method; order-sensitive interactions are likely.",
                    });
                }
            }

            // Duplicate Harmony ids surfaced by Attribution.
            lock (Attribution.Lock)
            {
                foreach (var dup in Attribution.DuplicateIds)
                {
                    conflicts.Add(new ConflictRow
                    {
                        Kind = "duplicate_harmony_id",
                        Mods = new List<string> { dup.ModA, dup.ModB },
                        Subject = dup.HarmonyId,
                        Detail = "Two mods registered Harmony with the same id.",
                    });
                }
            }

            // Build JSON.
            var json = new Json().Obj()
                .K("type").S("mods_snapshot")
                .K("takenAt").N(nowMs)
                .K("mods").Arr();

            int orderIdx = 0;
            foreach (var m in modsList)
            {
                var name = NameOf(m);
                perMod.TryGetValue(name, out var agg);
                int asmCount = m.assemblies?.loadedAssemblies?.Count ?? 0;
                bool hasAsm = asmCount > 0;

                json.Obj()
                    .K("packageId").S(m.PackageId ?? name)
                    .K("name").S(name)
                    .K("loadOrder").N(orderIdx++)
                    .K("hasAssemblies").B(hasAsm)
                    .K("assemblyCount").N(asmCount)
                    .K("patchCount").N(agg?.PatchCount ?? 0)
                    .K("destructivePrefixCount").N(agg?.DestructivePrefixCount ?? 0)
                    .EndObj();
            }
            json.EndArr();

            json.K("patches").Arr();
            foreach (var p in patches)
            {
                json.Obj()
                    .K("method").S(p.MethodSig)
                    .K("prefixes").Strs(p.Prefixes)
                    .K("postfixes").Strs(p.Postfixes)
                    .K("transpilers").Strs(p.Transpilers)
                    .K("finalizers").Strs(p.Finalizers)
                    .K("destructiveBy").Strs(p.DestructiveBy)
                    .EndObj();
            }
            json.EndArr();

            json.K("conflicts").Arr();
            foreach (var c in conflicts)
            {
                json.Obj()
                    .K("kind").S(c.Kind)
                    .K("mods").Strs(c.Mods)
                    .K("subject").S(c.Subject)
                    .K("detail").S(c.Detail)
                    .EndObj();
            }
            json.EndArr().EndObj();

            return json.ToString();
        }

        private static List<string> ModNamesOfPatches(System.Collections.ObjectModel.ReadOnlyCollection<Patch> patches)
        {
            var seen = new HashSet<string>();
            var ordered = new List<string>();
            foreach (var p in patches)
            {
                var name = Attribution.ModForHarmonyId(p.owner);
                if (seen.Add(name)) ordered.Add(name);
            }
            return ordered;
        }

        private static List<string> DestructivePatchOwnerMods(
            System.Collections.ObjectModel.ReadOnlyCollection<Patch> prefixes)
        {
            var seen = new HashSet<string>();
            var ordered = new List<string>();
            foreach (var p in prefixes)
            {
                if (!PatchIsDestructive(p)) continue;
                var name = Attribution.ModForHarmonyId(p.owner);
                if (seen.Add(name)) ordered.Add(name);
            }
            return ordered;
        }

        private static void BackfillOwners(
            System.Collections.ObjectModel.ReadOnlyCollection<Patch> patches)
        {
            foreach (var p in patches)
            {
                if (p?.PatchMethod == null) continue;
                var asm = p.PatchMethod.DeclaringType?.Assembly;
                if (asm == null) continue;
                Attribution.RegisterHarmonyId(p.owner, asm);
            }
        }

        private static bool PatchIsDestructive(Patch p)
        {
            // A prefix that returns bool can short-circuit the original.
            return p.PatchMethod != null && p.PatchMethod.ReturnType == typeof(bool);
        }

        private static string SignatureOf(MethodBase method)
        {
            if (method == null) return "<null>";
            var t = method.DeclaringType;
            var typeName = t == null ? "<global>" : (t.FullName ?? t.Name);
            return typeName + ":" + method.Name;
        }

        private static string NameOf(ModContentPack m)
            => m?.Name ?? m?.PackageId ?? "<unknown>";

        private static void Bump(
            Dictionary<string, ModAggregate> per,
            Patch patch,
            bool isPrefix,
            bool prefixIsDestructive)
        {
            var modName = Attribution.ModForHarmonyId(patch.owner);
            if (!per.TryGetValue(modName, out var agg))
            {
                // Patches owned by something not in our mod list (e.g. dynamic
                // assemblies) — track under the Harmony id name.
                agg = new ModAggregate { Mod = null };
                per[modName] = agg;
            }
            agg.PatchCount++;
            if (isPrefix && prefixIsDestructive) agg.DestructivePrefixCount++;
        }

        private sealed class ModAggregate
        {
            public ModContentPack Mod;
            public int PatchCount;
            public int DestructivePrefixCount;
        }

        private sealed class PatchRow
        {
            public string MethodSig;
            public List<string> Prefixes;
            public List<string> Postfixes;
            public List<string> Transpilers;
            public List<string> Finalizers;
            public List<string> DestructiveBy;
        }

        private sealed class ConflictRow
        {
            public string Kind;
            public List<string> Mods;
            public string Subject;
            public string Detail;
        }
    }
}
