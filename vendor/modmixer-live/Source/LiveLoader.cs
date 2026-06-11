using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Runtime.CompilerServices;
using HarmonyLib;
using Verse;

namespace ModMixer.Live
{
    // Command executors for the app's three live-modding verbs:
    //
    //   hot_load    — load a freshly built DLL into the running game, run its
    //                 startup ctors, (re)apply its Harmony patches under the
    //                 app-chosen id, optionally hot-reload defs.
    //   exec_csharp — load a DLL and invoke a single static Run() once. The
    //                 GenSpawn ledger is armed for the duration so the app
    //                 can report what the action spawned.
    //   reload_defs — standalone vanilla def hot-reload.
    //
    // Everything runs inside a synchronous LongEventHandler long event:
    // main thread, loading overlay, and the sim can't tick mid-mutation
    // (the event owns the frame). The player's time speed is deliberately
    // left alone — no pausing before or after. Every command — including
    // ones that throw — produces exactly one cmd_result, because the app
    // is waiting on the id.
    public static class LiveLoader
    {
        // True only while an exec_csharp Run() is on the stack. The GenSpawn
        // postfix records spawns into the ledger while armed. Main-thread
        // only (long events and spawns both run there), so a plain bool.
        public static bool LedgerArmed;

        private sealed class LedgerEntry
        {
            public int ThingId;
            public string DefName;
        }

        private static readonly List<LedgerEntry> Ledger = new List<LedgerEntry>();

        // Called from LiveBehaviour.Update with a hot_load / exec_csharp /
        // reload_defs message.
        public static void Enqueue(JsonValue msg)
        {
            if (msg == null) return;
            string type = msg["type"]?.AsString() ?? "";
            string id = msg["id"]?.AsString() ?? "";
            try
            {
                LongEventHandler.QueueLongEvent(
                    () => Execute(type, id, msg),
                    // Shown raw — Translate() falls back to the key itself.
                    "Applying Modmixer changes",
                    false, // synchronous: executors need the main thread
                    null);
            }
            catch (Exception ex)
            {
                SendResult(id, false, "failed to queue command: " + ex);
            }
        }

        private static void Execute(string type, string id, JsonValue msg)
        {
            bool ok;
            string detail;
            try
            {
                switch (type)
                {
                    case "hot_load":
                    {
                        var r = HotLoad(
                            msg["dllPath"]?.AsString(),
                            msg["harmonyId"]?.AsString(),
                            msg["reloadDefs"]?.AsBool() ?? false);
                        ok = r.ok;
                        detail = r.detail;
                        break;
                    }
                    case "exec_csharp":
                    {
                        var r = ExecCsharp(msg["dllPath"]?.AsString());
                        ok = r.ok;
                        detail = r.detail;
                        break;
                    }
                    case "reload_defs":
                    {
                        var r = ReloadDefs();
                        ok = r.ok;
                        detail = r.detail;
                        break;
                    }
                    default:
                        ok = false;
                        detail = "unknown command type: " + type;
                        break;
                }
            }
            catch (Exception ex)
            {
                // A throwing executor must still answer — the app is waiting
                // on this id. Full ToString: the agent debugs from the stack.
                ok = false;
                detail = ex.ToString();
            }
            SendResult(id, ok, detail);
        }

        public static (bool ok, string detail) HotLoad(string dllPath, string harmonyId, bool reloadDefs)
        {
            if (string.IsNullOrEmpty(dllPath)) return (false, "hot_load: missing dllPath");
            if (string.IsNullOrEmpty(harmonyId)) return (false, "hot_load: missing harmonyId");
            if (!File.Exists(dllPath)) return (false, "hot_load: dll not found: " + dllPath);

            var harmony = new Harmony(harmonyId);

            // Unpatch BEFORE loading the replacement so the old generation's
            // patches never coexist with the new ones. Safe when nothing has
            // been patched under this id yet.
            try { harmony.UnpatchAll(harmonyId); }
            catch (Exception ex) { return (false, "hot_load: unpatch failed: " + ex); }

            Assembly asm;
            try { asm = Assembly.Load(File.ReadAllBytes(dllPath)); }
            catch (Exception ex) { return (false, "hot_load: assembly load failed: " + ex); }

            // RimWorld only runs [StaticConstructorOnStartup] ctors at boot;
            // a hot-loaded generation has to trigger its own. Scoped strictly
            // to the new assembly — re-running other mods' static ctors would
            // double-initialize them.
            int ctorsRun = 0;
            string ctorNote = "";
            foreach (var t in SafeGetTypes(asm))
            {
                try
                {
                    if (!t.IsDefined(typeof(StaticConstructorOnStartup), false)) continue;
                    RuntimeHelpers.RunClassConstructor(t.TypeHandle);
                    ctorsRun++;
                }
                catch (Exception ex)
                {
                    // One bad static ctor shouldn't abort the rest of the load.
                    if (ctorNote.Length == 0)
                        ctorNote = "; static ctor failed on " + t.Name + ": " + FirstLine(ex.ToString());
                }
            }

            try { harmony.PatchAll(asm); }
            catch (Exception ex) { return (false, "hot_load: PatchAll failed: " + ex); }

            int patched = 0;
            try { foreach (var m in harmony.GetPatchedMethods()) patched++; }
            catch { /* count is informational only. */ }

            ClearGenTypesCaches();

            string defsNote = "";
            if (reloadDefs)
            {
                var r = ReloadDefs();
                defsNote = r.ok ? "; defs reloaded" : "; " + r.detail + " (DLL load succeeded)";
            }

            return (true, "loaded " + (asm.GetName()?.Name ?? "assembly") + ": "
                + patched + " methods patched, " + ctorsRun + " static ctors run"
                + ctorNote + defsNote);
        }

        public static (bool ok, string detail) ExecCsharp(string dllPath)
        {
            if (string.IsNullOrEmpty(dllPath)) return (false, "exec_csharp: missing dllPath");
            if (!File.Exists(dllPath)) return (false, "exec_csharp: dll not found: " + dllPath);

            Assembly asm;
            try { asm = Assembly.Load(File.ReadAllBytes(dllPath)); }
            catch (Exception ex) { return (false, "exec_csharp: assembly load failed: " + ex); }

            // Convention: a type named LiveAction with a public static
            // parameterless Run(). Any other type's Run() works as a
            // fallback so the generated code doesn't have to be exact.
            MethodInfo run = null;
            foreach (var t in SafeGetTypes(asm))
            {
                MethodInfo m;
                try
                {
                    m = t.GetMethod("Run",
                        BindingFlags.Public | BindingFlags.Static,
                        null, Type.EmptyTypes, null);
                }
                catch { continue; } // ambiguous/broken type — keep scanning
                if (m == null) continue;
                if (t.Name == "LiveAction") { run = m; break; }
                if (run == null) run = m;
            }
            if (run == null)
                return (false, "exec_csharp: no public static parameterless Run() found");

            Ledger.Clear();
            LedgerArmed = true;
            object ret;
            try
            {
                ret = run.Invoke(null, null);
            }
            catch (Exception ex)
            {
                // Unwrap the reflection wrapper; the app-side agent reads the
                // full stack of the action's own exception to debug its code.
                var inner = (ex as TargetInvocationException)?.InnerException ?? ex;
                return (false, inner.ToString());
            }
            finally
            {
                LedgerArmed = false;
            }

            string retText = ret == null ? "done" : (ret.ToString() ?? "done");
            return (true, retText + "; spawned " + Ledger.Count + " things");
        }

        public static (bool ok, string detail) ReloadDefs()
        {
            MethodInfo m = null;
            try
            {
                // Dev-mode def hot-reload. Present on 1.5/1.6 but it's an
                // internal dev tool, so probe rather than hard-binding to a
                // signature that may drift.
                foreach (var cand in typeof(PlayDataLoader).GetMethods(
                    BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static))
                {
                    if (cand.Name == "HotReloadDefs" && cand.GetParameters().Length == 0)
                    {
                        m = cand;
                        break;
                    }
                }
            }
            catch { /* fall through to unsupported. */ }
            if (m == null)
                return (false, "defs reload unsupported on this RimWorld version");
            try
            {
                m.Invoke(null, null);
                return (true, "defs reloaded");
            }
            catch (Exception ex)
            {
                var inner = (ex as TargetInvocationException)?.InnerException ?? ex;
                return (false, "defs reload threw: " + inner);
            }
        }

        // Called by the GenSpawn postfix below.
        public static void RecordSpawn(Thing thing)
        {
            if (!LedgerArmed || thing == null) return;
            try
            {
                Ledger.Add(new LedgerEntry
                {
                    ThingId = thing.thingIDNumber,
                    DefName = thing.def != null ? thing.def.defName : "?",
                });
            }
            catch
            {
                // The ledger is advisory; never disturb a spawn over it.
            }
        }

        private static void SendResult(string id, bool ok, string detail)
        {
            try
            {
                var client = LiveMod.Client;
                if (client == null) return;
                var json = new Json()
                    .Obj()
                    .K("type").S("cmd_result")
                    .K("id").S(id)
                    .K("ok").B(ok)
                    .K("detail").S(detail ?? "")
                    .K("at").N(LiveMod.NowMs())
                    .EndObj()
                    .ToString();
                client.Send(json);
            }
            catch
            {
                // Reporting must never crash the long event it reports on.
            }
        }

        // GenTypes memoizes type lookups (by-name resolution, subclass
        // scans). A new assembly invalidates those memos; without clearing,
        // defs referencing hot-loaded classes resolve to stale misses.
        private static void ClearGenTypesCaches()
        {
            try
            {
                var t = typeof(GenTypes);
                var clear = AccessTools.Method(t, "ClearCache");
                if (clear != null && clear.IsStatic && clear.GetParameters().Length == 0)
                {
                    clear.Invoke(null, null);
                    return;
                }
                // No ClearCache on this build — best effort: empty static
                // fields whose names mark them as caches. Only those: GenTypes
                // also holds config lists (e.g. ignored namespaces) that must
                // survive.
                foreach (var f in t.GetFields(
                    BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic))
                {
                    try
                    {
                        if (f.Name.IndexOf("cache", StringComparison.OrdinalIgnoreCase) < 0)
                            continue;
                        var v = f.GetValue(null);
                        if (v is System.Collections.IDictionary dict) dict.Clear();
                        else if (!f.FieldType.IsArray && v is System.Collections.IList list) list.Clear();
                    }
                    catch
                    {
                        // Skip stubborn fields; partial clearing still helps.
                    }
                }
            }
            catch
            {
                // Cache clearing is an optimization, not a correctness gate.
            }
        }

        private static Type[] SafeGetTypes(Assembly asm)
        {
            try
            {
                return asm.GetTypes();
            }
            catch (ReflectionTypeLoadException ex)
            {
                // Some types failed to bind (missing refs); use the ones that
                // loaded.
                var list = new List<Type>();
                if (ex.Types != null)
                    foreach (var t in ex.Types)
                        if (t != null) list.Add(t);
                return list.ToArray();
            }
            catch
            {
                return new Type[0];
            }
        }

        private static string FirstLine(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            int nl = s.IndexOf('\n');
            return nl < 0 ? s : s.Substring(0, nl);
        }
    }

    // The spawn ledger tap. The exact Spawn overload differs across builds
    // (forbidLeavings was appended at some point), so we resolve it
    // defensively and skip the patch entirely when no known shape exists —
    // the ledger is a nicety, not a requirement.
    [HarmonyPatch]
    internal static class GenSpawnLedgerPatch
    {
        private static MethodBase Resolve()
        {
            var sig6 = new[]
            {
                typeof(Thing), typeof(IntVec3), typeof(Map), typeof(Rot4),
                typeof(WipeMode), typeof(bool),
            };
            var m = AccessTools.Method(typeof(GenSpawn), "Spawn", sig6);
            if (m != null) return m;
            var sig7 = new[]
            {
                typeof(Thing), typeof(IntVec3), typeof(Map), typeof(Rot4),
                typeof(WipeMode), typeof(bool), typeof(bool),
            };
            return AccessTools.Method(typeof(GenSpawn), "Spawn", sig7);
        }

        // False makes Harmony skip this class without evaluating
        // TargetMethods at all.
        public static bool Prepare() => Resolve() != null;

        public static IEnumerable<MethodBase> TargetMethods()
        {
            var m = Resolve();
            // Yield nothing rather than throwing if the overload vanished
            // between Prepare and here — Harmony tolerates an empty yield.
            if (m != null) yield return m;
        }

        // __result is the thing actually placed (it can differ from the
        // argument when the spawn wraps or replaces it).
        public static void Postfix(Thing __result)
        {
            try
            {
                LiveLoader.RecordSpawn(__result);
            }
            catch
            {
                // Never crash a spawn from a diagnostic patch.
            }
        }
    }
}
