using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Reflection;
using HarmonyLib;
using Verse;

namespace ModMixer.Bridge
{
    // Hooks Verse.Log.Message / Warning / Error and emits a structured
    // error_event for each. Mod attribution comes from the captured stack
    // trace via Attribution.ModsFromStack.
    //
    // Dedup is done client-side; we just hash the stack signature and emit it
    // alongside the event so the renderer can collapse repeats.
    public static class ErrorsChannel
    {
        private static BridgeClient currentClient;

        public static void Bind(BridgeClient client)
        {
            currentClient = client;
        }

        // Hot path: called from inside Log.Error/Warning/Message via Harmony
        // postfix patches. Don't allocate excessively, don't throw.
        public static void Capture(string text, string severity)
        {
            var client = currentClient;
            if (client == null || !client.Connected) return;
            try
            {
                var trace = new StackTrace(2, false);
                var mods = Attribution.ModsFromStack(trace);
                var firstLine = text == null ? "" : FirstLine(text);
                var hash = Hash(firstLine, mods);

                var json = new Json().Obj()
                    .K("type").S("error_event")
                    .K("severity").S(severity)
                    .K("firstLine").S(firstLine)
                    .K("text").S(Truncate(text, 4096))
                    .K("attributedMods").Strs(mods)
                    .K("hash").S(hash)
                    .K("at").N(BridgeMod.NowMs())
                    .EndObj()
                    .ToString();
                client.Send(json);
            }
            catch
            {
                // Diagnostic path; never crash the game.
            }
        }

        private static string FirstLine(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            int nl = s.IndexOf('\n');
            var line = nl < 0 ? s : s.Substring(0, nl);
            return line.Length > 240 ? line.Substring(0, 240) : line;
        }

        private static string Truncate(string s, int max)
        {
            if (string.IsNullOrEmpty(s)) return "";
            return s.Length <= max ? s : s.Substring(0, max);
        }

        private static string Hash(string firstLine, List<string> mods)
        {
            unchecked
            {
                long h = 1469598103934665603L; // FNV offset basis (signed)
                if (firstLine != null)
                {
                    for (int i = 0; i < firstLine.Length; i++)
                        h = ((h << 5) - h) ^ firstLine[i];
                }
                if (mods != null)
                {
                    foreach (var m in mods)
                    {
                        if (m == null) continue;
                        for (int i = 0; i < m.Length; i++)
                            h = ((h << 5) - h) ^ m[i];
                    }
                }
                return h.ToString("x");
            }
        }
    }

    [HarmonyPatch]
    internal static class LogErrorPatch
    {
        public static IEnumerable<MethodBase> TargetMethods()
        {
            yield return AccessTools.Method(typeof(Log), nameof(Log.Error), new[] { typeof(string) });
        }
        public static void Postfix(string text) => ErrorsChannel.Capture(text, "error");
    }

    [HarmonyPatch]
    internal static class LogWarningPatch
    {
        public static IEnumerable<MethodBase> TargetMethods()
        {
            yield return AccessTools.Method(typeof(Log), nameof(Log.Warning), new[] { typeof(string) });
        }
        public static void Postfix(string text) => ErrorsChannel.Capture(text, "warning");
    }
}
