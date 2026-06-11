using System;
using HarmonyLib;
using RimWorld;
using UnityEngine;
using Verse;

namespace ModMixer.Live
{
    public class LiveMod : Mod
    {
        public const string Id = "modmixer.live";
        // Resolved from About.xml <modVersion> — the single source of truth
        // shared with the app (pre-launch gate) and the Workshop publish
        // script. Only the fallback is hardcoded.
        public static string LiveVersion = "0.0.0";
        public static readonly long StartedAtMs = NowMs();

        public static LiveClient Client;
        public static LiveSettings Settings;

        public LiveMod(ModContentPack content) : base(content)
        {
            try
            {
                var version = content?.ModMetaData?.ModVersion;
                if (!string.IsNullOrEmpty(version)) LiveVersion = version;
                Settings = GetSettings<LiveSettings>();

                var harmony = new Harmony(Id);
                // Installs the chat-input keybinding gate and the GenSpawn
                // ledger patch (each skips itself if its target isn't found).
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

    // Persisted once-ever flags (RimWorld writes these to its mod-settings
    // config, so they survive restarts and updates).
    public class LiveSettings : ModSettings
    {
        public bool standaloneNudgeShown;

        public override void ExposeData()
        {
            base.ExposeData();
            Scribe_Values.Look(ref standaloneNudgeShown, "standaloneNudgeShown", false);
        }
    }

    internal sealed class LiveBehaviour : MonoBehaviour
    {
        // Long enough that an app-launched session has connected many times
        // over; only the standalone Workshop subscriber ever sees the nudge.
        private const long StandaloneNudgeDelayMs = 60_000;

        private void Update()
        {
            var client = LiveMod.Client;
            if (client == null) return;
            try
            {
                MaybeShowStandaloneNudge(client);
                JsonValue msg;
                while (client.Inbox.TryDequeue(out msg)) Dispatch(msg);
            }
            catch
            {
                // Never propagate exceptions back into the Unity update loop.
            }
        }

        // The mod is distributed on the Workshop, so people subscribe without
        // the app and would otherwise see a mod that silently does nothing.
        // One polite pointer, once per install, only when no app has ever
        // been seen this launch.
        private static void MaybeShowStandaloneNudge(LiveClient client)
        {
            var settings = LiveMod.Settings;
            if (settings == null || settings.standaloneNudgeShown) return;
            if (client.EverConnected || client.RejectedReason != null) return;
            if (Current.ProgramState != ProgramState.Playing) return;
            if (LiveMod.NowMs() - LiveMod.StartedAtMs < StandaloneNudgeDelayMs) return;
            Messages.Message(
                "Modmixer Live pairs with the free Modmixer desktop app — get it at modmixer.com, then click \"Launch Live Session\".",
                MessageTypeDefOf.SilentInput,
                historical: false);
            settings.standaloneNudgeShown = true;
            settings.Write();
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
                    // they get the main thread and a loading overlay; the
                    // player's time speed is left untouched.
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
