using System;
using HarmonyLib;
using UnityEngine;
using Verse;

namespace ModMixer.Bridge
{
    public class BridgeMod : Mod
    {
        public const string Id = "modmixer.bridge";
        public static readonly long StartedAtMs = NowMs();

        public static BridgeClient Client;

        public BridgeMod(ModContentPack content) : base(content)
        {
            try
            {
                Attribution.Initialize();

                var harmony = new Harmony(Id);
                // Patch Harmony's own ctor first — every subsequent
                // new Harmony(id) anywhere in the load order is captured.
                harmony.PatchAll();

                Client = new BridgeClient();
                ErrorsChannel.Bind(Client);
                Client.OnConnected += OnConnected;
                Client.Start();

                // Per-frame tick host — needs to live on a Unity GameObject so
                // Update() runs each frame.
                var go = new GameObject("ModmixerBridgeBehaviour");
                UnityEngine.Object.DontDestroyOnLoad(go);
                go.AddComponent<BridgeBehaviour>();

                Log.Message("[Modmixer Bridge] loaded — listening for Modmixer on 127.0.0.1:13371");
            }
            catch (Exception ex)
            {
                Log.Error("[Modmixer Bridge] init failed: " + ex);
            }
        }

        private static void OnConnected()
        {
            // Fire an immediate snapshot so the UI populates without waiting.
            try { ModsChannel.Snapshot(Client, NowMs()); } catch { }
        }

        public static long NowMs()
            => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    }

    internal sealed class BridgeBehaviour : MonoBehaviour
    {
        // One-shot: pause the sim the first moment a play session is ready if
        // the window is unfocused (user alt-tabbed back to Modmixer). After
        // firing or after the user is observably focused on RimWorld at load,
        // we disarm — the user is in charge of pause from that point on.
        private static bool autoPauseArmed = true;

        private void Update()
        {
            if (autoPauseArmed) TryAutoPauseOnStart();

            var client = BridgeMod.Client;
            if (client == null) return;
            if (!client.Connected) return;
            try
            {
                PerfChannel.Tick(client, Time.unscaledDeltaTime);
                ModsChannel.Tick(client, BridgeMod.NowMs());
            }
            catch
            {
                // Never propagate exceptions back into the Unity update loop.
            }
        }

        private static void TryAutoPauseOnStart()
        {
            try
            {
                if (Current.ProgramState != ProgramState.Playing) return;
                if (Find.TickManager == null) return;
                if (Application.isFocused)
                {
                    // User is looking at the game when it became playable —
                    // they intend to watch; don't surprise them with a pause.
                    autoPauseArmed = false;
                    return;
                }
                Find.TickManager.CurTimeSpeed = TimeSpeed.Paused;
                autoPauseArmed = false;
            }
            catch
            {
                // Don't propagate exceptions back into the Unity update loop.
            }
        }

        private void OnApplicationQuit()
        {
            BridgeMod.Client?.Stop();
        }
    }
}
