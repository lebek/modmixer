using System.Diagnostics;
using HarmonyLib;
using UnityEngine;
using Verse;

namespace ModMixer.Bridge
{
    // Sampled ~4Hz from the BridgeBehaviour Update(). Tracks TPS by counting
    // calls to TickManager.DoSingleTick (Harmony patch below) and FPS via
    // Unity's smoothed delta.
    public static class PerfChannel
    {
        private static readonly Process Self = Process.GetCurrentProcess();
        private static readonly Stopwatch BridgeCost = new Stopwatch();

        private static int tickCounterAccum;
        private static float tickAccumWindowSec;
        private static double tpsSmoothed;

        // Called by the Harmony postfix below — incremented per game tick.
        public static void IncrementTick()
        {
            // Lock-free; Unity update runs on main thread.
            tickCounterAccum++;
        }

        public static void Tick(BridgeClient client, float deltaSec)
        {
            BridgeCost.Restart();
            tickAccumWindowSec += deltaSec;

            // Send a perf sample every ~250ms.
            if (tickAccumWindowSec < 0.25f) { BridgeCost.Stop(); return; }

            // Convert observed ticks-in-window to TPS, then smooth.
            double observedTps = tickCounterAccum / tickAccumWindowSec;
            tpsSmoothed = tpsSmoothed * 0.6 + observedTps * 0.4;
            tickCounterAccum = 0;
            tickAccumWindowSec = 0;

            int gameTick = 0;
            int speed = 0;
            try
            {
                if (Find.TickManager != null)
                {
                    gameTick = Find.TickManager.TicksGame;
                    speed = (int)Find.TickManager.CurTimeSpeed;
                }
            }
            catch { }

            double fps = 1f / Mathf.Max(0.0001f, Time.smoothDeltaTime);
            double frameMs = Time.smoothDeltaTime * 1000.0;
            double heapMb = System.GC.GetTotalMemory(false) / (1024.0 * 1024.0);
            double wsMb = 0;
            try { wsMb = Self.WorkingSet64 / (1024.0 * 1024.0); } catch { }

            BridgeCost.Stop();
            double bridgeMs = BridgeCost.Elapsed.TotalMilliseconds;

            var json = new Json()
                .Obj()
                .K("type").S("perf")
                .K("gameTick").N(gameTick)
                .K("speed").N(speed)
                .K("tps").N(tpsSmoothed)
                .K("fps").N(fps)
                .K("frameMs").N(frameMs)
                .K("heapMb").N(heapMb)
                .K("workingSetMb").N(wsMb)
                .K("bridgeMs").N(bridgeMs)
                .EndObj()
                .ToString();
            client.Send(json);
        }
    }

    [HarmonyPatch(typeof(TickManager), "DoSingleTick")]
    internal static class DoSingleTickPatch
    {
        // Harmony postfix; void return; can't be destructive.
        public static void Postfix() => PerfChannel.IncrementTick();
    }
}
