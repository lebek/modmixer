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
                var go = new GameObject("ModMixerBridgeBehaviour");
                UnityEngine.Object.DontDestroyOnLoad(go);
                go.AddComponent<BridgeBehaviour>();

                Log.Message("[ModMixerBridge] loaded — listening for ModMixer on 127.0.0.1:13371");
            }
            catch (Exception ex)
            {
                Log.Error("[ModMixerBridge] init failed: " + ex);
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
        private void Update()
        {
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

        private void OnApplicationQuit()
        {
            BridgeMod.Client?.Stop();
        }
    }
}
