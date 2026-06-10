using System;
using HarmonyLib;
using UnityEngine;
using Verse;

namespace ModMixer.Live
{
    public class LiveMod : Mod
    {
        public const string Id = "modmixer.live";
        public const string LiveVersion = "0.1.0";
        public static readonly long StartedAtMs = NowMs();

        public static LiveClient Client;

        public LiveMod(ModContentPack content) : base(content)
        {
            try
            {
                var harmony = new Harmony(Id);
                // Installs the PlaySettings toggle and the GenSpawn ledger
                // patch (which skips itself if the overload isn't found).
                harmony.PatchAll();

                Client = new LiveClient();
                Client.Start();

                // Per-frame inbox drain — needs to live on a Unity GameObject
                // so Update() runs each frame.
                var go = new GameObject("ModmixerLiveBehaviour");
                UnityEngine.Object.DontDestroyOnLoad(go);
                go.AddComponent<LiveBehaviour>();

                Log.Message("[Modmixer Live] loaded — looking for Modmixer on 127.0.0.1:13372");
            }
            catch (Exception ex)
            {
                Log.Error("[Modmixer Live] init failed: " + ex);
            }
        }

        public static long NowMs()
            => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    }

    internal sealed class LiveBehaviour : MonoBehaviour
    {
        private void Update()
        {
            var client = LiveMod.Client;
            if (client == null) return;
            try
            {
                JsonValue msg;
                while (client.Inbox.TryDequeue(out msg)) Dispatch(msg);
            }
            catch
            {
                // Never propagate exceptions back into the Unity update loop.
            }
        }

        private static void Dispatch(JsonValue msg)
        {
            switch (msg["type"]?.AsString())
            {
                case "agent_busy":
                    LiveWindowState.Busy = msg["busy"]?.AsBool() ?? false;
                    break;
                case "agent_status":
                    LiveWindowState.StatusLine = msg["text"]?.AsString() ?? "";
                    break;
                case "agent_say":
                    LiveWindowState.Append(true, msg["text"]?.AsString() ?? "");
                    break;
                case "hot_load":
                case "exec_csharp":
                case "reload_defs":
                    // Executors run inside a LongEventHandler long event so
                    // they get the main thread, a loading overlay, and a
                    // paused sim.
                    LiveLoader.Enqueue(msg);
                    break;
                default:
                    // server_hello and anything newer than this build — ignore.
                    break;
            }
        }

        private void OnApplicationQuit()
        {
            LiveMod.Client?.Stop();
        }
    }
}
