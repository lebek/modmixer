using System.Collections.Generic;
using System.Globalization;
using Verse;

namespace ModMixer.Live
{
    // Keyed string store scribed with the save. Hot-loaded assemblies must
    // never define their own scribed types: a save written against
    // generation N of a hot-loaded class can't load once generation N+1
    // replaces it (or after the live session ends and the assembly is gone).
    // Instead, live code persists through this string-keyed bag, owned by
    // this stable assembly.
    //
    // RimWorld instantiates one per Game automatically — every GameComponent
    // subclass with a (Game) ctor is picked up by Game.FillComponents.
    public class LiveState : GameComponent
    {
        private Dictionary<string, string> store = new Dictionary<string, string>();

        public LiveState(Game game)
        {
        }

        public override void ExposeData()
        {
            Scribe_Collections.Look(ref store, "modmixerLiveState", LookMode.Value, LookMode.Value);
            // Loading a save that predates this mod leaves the dict null.
            if (store == null) store = new Dictionary<string, string>();
        }

        private static LiveState Instance
        {
            get
            {
                try
                {
                    return Current.Game?.GetComponent<LiveState>();
                }
                catch
                {
                    return null; // no game yet, or mid-teardown
                }
            }
        }

        // All accessors are null-safe: with no game loaded, Get returns the
        // fallback and Set is a no-op, so hot-loaded code can call them from
        // anywhere without guarding.
        public static string Get(string key, string fallback)
        {
            var inst = Instance;
            if (inst == null || key == null) return fallback;
            string v;
            return inst.store.TryGetValue(key, out v) ? v : fallback;
        }

        public static void Set(string key, string value)
        {
            var inst = Instance;
            if (inst == null || key == null) return;
            inst.store[key] = value;
        }

        public static float GetFloat(string key, float fallback)
        {
            var s = Get(key, null);
            float v;
            if (s != null && float.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out v))
                return v;
            return fallback;
        }

        public static void SetFloat(string key, float value)
            => Set(key, value.ToString("R", CultureInfo.InvariantCulture));

        public static int GetInt(string key, int fallback)
        {
            var s = Get(key, null);
            int v;
            if (s != null && int.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out v))
                return v;
            return fallback;
        }

        public static void SetInt(string key, int value)
            => Set(key, value.ToString(CultureInfo.InvariantCulture));
    }
}
