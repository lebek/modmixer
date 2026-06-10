using System;
using System.Collections.Generic;
using HarmonyLib;
using RimWorld;
using UnityEngine;
using Verse;

namespace ModMixer.Live
{
    // Shared UI state for the chat window. Everything here is touched only
    // from the main thread (LiveBehaviour.Update and window OnGUI), so no
    // locking is needed.
    public static class LiveWindowState
    {
        // Bounded so an hours-long session can't grow the transcript (and
        // its per-frame measuring cost) without limit.
        private const int MaxTranscript = 200;

        public sealed class Entry
        {
            public bool FromAgent;
            public string Text;
        }

        public static readonly List<Entry> Transcript = new List<Entry>();
        public static string StatusLine = "";
        public static bool Busy;

        public static void Append(bool fromAgent, string text)
        {
            if (string.IsNullOrEmpty(text)) return;
            Transcript.Add(new Entry { FromAgent = fromAgent, Text = text });
            if (Transcript.Count > MaxTranscript) Transcript.RemoveAt(0);
        }
    }

    // The in-game chat window. Deliberately toy-like: prefixed word-wrapped
    // labels, no markdown, no rich text — the agent keeps its prose short.
    public class LiveWindow : Window
    {
        private const string InputControlName = "ModmixerLiveInput";

        private static readonly Color DotConnected = new Color(0.35f, 0.85f, 0.35f);
        private static readonly Color DotRetrying = new Color(0.95f, 0.85f, 0.25f);
        private static readonly Color DotRejected = new Color(0.95f, 0.3f, 0.25f);
        private static readonly Color AgentColor = new Color(0.65f, 0.85f, 1f);

        private Vector2 scrollPos;
        private string inputText = "";
        private int lastTranscriptCount = -1;

        public override Vector2 InitialSize => new Vector2(520f, 420f);

        public LiveWindow()
        {
            doCloseX = true;
            draggable = true;
            absorbInputAroundWindow = false;
            preventCameraMotion = false;
            closeOnClickedOutside = false;
            // Enter submits the prompt; it must not close the window.
            closeOnAccept = false;
            forcePause = false;
        }

        public override void DoWindowContents(Rect inRect)
        {
            try
            {
                Draw(inRect);
            }
            catch (Exception ex)
            {
                // OnGUI runs several times per frame; a layout bug must not
                // spam the log or cascade into the window stack.
                Log.ErrorOnce("[Modmixer Live] window draw failed: " + ex, 192377591);
            }
        }

        private void Draw(Rect inRect)
        {
            Text.Font = GameFont.Small;
            var client = LiveMod.Client;
            bool connected = client != null && client.Connected;
            string rejected = client?.RejectedReason;

            // --- header: connection dot + one-line status ---
            Color dotColor;
            string headerText;
            if (!string.IsNullOrEmpty(rejected))
            {
                dotColor = DotRejected;
                headerText = rejected;
                connected = false; // rejected sockets never accept prompts
            }
            else if (connected)
            {
                dotColor = DotConnected;
                headerText = "Connected to Modmixer";
            }
            else
            {
                dotColor = DotRetrying;
                headerText = "Looking for Modmixer… Is the Modmixer app running?";
            }
            Widgets.DrawBoxSolid(new Rect(2f, 7f, 10f, 10f), dotColor);
            Widgets.Label(new Rect(18f, 0f, inRect.width - 18f, 24f), headerText);

            // --- layout ---
            const float inputH = 30f;
            float statusH = LiveWindowState.Busy ? 22f : 0f;
            var transcriptRect = new Rect(
                0f, 28f, inRect.width, inRect.height - 28f - statusH - inputH - 8f);

            DrawTranscript(transcriptRect);

            float y = transcriptRect.yMax + 4f;
            if (LiveWindowState.Busy)
            {
                var status = LiveWindowState.StatusLine;
                if (string.IsNullOrEmpty(status)) status = "Working";
                int dots = 1 + (int)(Time.realtimeSinceStartup * 2f) % 3;
                GUI.color = new Color(1f, 1f, 1f, 0.6f);
                Widgets.Label(
                    new Rect(0f, y, inRect.width, 22f),
                    status.TrimEnd('.', '…') + new string('.', dots));
                GUI.color = Color.white;
                y += statusH;
            }

            // --- input row ---
            // Enter check must run before the TextField below consumes the
            // KeyDown event (standard RimWorld pattern).
            bool submit = false;
            if (Event.current.type == EventType.KeyDown
                && (Event.current.keyCode == KeyCode.Return
                    || Event.current.keyCode == KeyCode.KeypadEnter)
                && GUI.GetNameOfFocusedControl() == InputControlName)
            {
                submit = true;
                Event.current.Use();
            }

            var inputRect = new Rect(0f, y, inRect.width - 70f, inputH);
            var sendRect = new Rect(inRect.width - 64f, y, 64f, inputH);
            GUI.SetNextControlName(InputControlName);
            inputText = Widgets.TextField(inputRect, inputText);
            if (Widgets.ButtonText(sendRect, "Send", true, true, connected)) submit = true;

            if (submit && connected) Submit(client);
        }

        private void DrawTranscript(Rect outRect)
        {
            var entries = LiveWindowState.Transcript;
            float width = outRect.width - 16f; // leave room for the scrollbar
            float textW = width - 8f;

            // Pass 1: measure. Cheap enough at the 200-entry cap.
            float totalH = 0f;
            for (int i = 0; i < entries.Count; i++)
                totalH += Text.CalcHeight(LineFor(entries[i]), textW) + 4f;

            if (entries.Count != lastTranscriptCount)
            {
                // New message — pin the view to the bottom. Unity clamps the
                // overshoot.
                lastTranscriptCount = entries.Count;
                scrollPos.y = totalH;
            }

            Widgets.DrawBoxSolid(outRect, new Color(0f, 0f, 0f, 0.2f));
            var viewRect = new Rect(0f, 0f, width, Mathf.Max(totalH, outRect.height));
            Widgets.BeginScrollView(outRect, ref scrollPos, viewRect);
            float curY = 0f;
            for (int i = 0; i < entries.Count; i++)
            {
                var e = entries[i];
                string line = LineFor(e);
                float h = Text.CalcHeight(line, textW);
                GUI.color = e.FromAgent ? AgentColor : Color.white;
                Widgets.Label(new Rect(4f, curY, textW, h), line);
                curY += h + 4f;
            }
            GUI.color = Color.white;
            Widgets.EndScrollView();
        }

        private static string LineFor(LiveWindowState.Entry e)
            => (e.FromAgent ? "Modmixer: " : "You: ") + e.Text;

        private void Submit(LiveClient client)
        {
            string text = (inputText ?? "").Trim();
            if (text.Length == 0) return;
            inputText = "";
            LiveWindowState.Append(false, text);
            try
            {
                var json = new Json()
                    .Obj()
                    .K("type").S("user_prompt")
                    .K("text").S(text)
                    .K("at").N(LiveMod.NowMs())
                    .EndObj()
                    .ToString();
                client.Send(json);
            }
            catch
            {
                // Socket trouble shows up on the connection dot; don't turn
                // the player's prompt into an exception.
            }
        }
    }

    // Toggle entry point: an icon in the bottom-right play-settings strip,
    // next to the vanilla toggles.
    [HarmonyPatch(typeof(PlaySettings), nameof(PlaySettings.DoPlaySettingsGlobalControls))]
    internal static class PlaySettingsTogglePatch
    {
        private static Texture2D icon;
        private static bool iconResolved;

        public static void Postfix(WidgetRow row, bool worldView)
        {
            try
            {
                if (row == null || worldView) return;

                bool isOpen = Find.WindowStack.IsOpen<LiveWindow>();
                bool toggled = isOpen;

                var tex = ResolveIcon();
                if (tex != null)
                {
                    row.ToggleableIcon(ref toggled, tex, "Modmixer Live");
                }
                else if (row.ButtonText("Live"))
                {
                    toggled = !toggled;
                }

                if (toggled == isOpen) return;
                if (toggled) Find.WindowStack.Add(new LiveWindow());
                else Find.WindowStack.TryRemove(typeof(LiveWindow));
            }
            catch
            {
                // Never break the play-settings strip for everyone else.
            }
        }

        private static Texture2D ResolveIcon()
        {
            if (iconResolved) return icon;
            iconResolved = true;
            try
            {
                // TexButton's namespace has moved between Verse and RimWorld
                // across versions; probe both rather than hard-referencing.
                // Runs on the main thread (texture access requires it).
                var t = AccessTools.TypeByName("Verse.TexButton")
                        ?? AccessTools.TypeByName("RimWorld.TexButton");
                var f = t == null ? null : AccessTools.Field(t, "Info");
                icon = f?.GetValue(null) as Texture2D;
            }
            catch
            {
                icon = null; // fall back to the text button
            }
            return icon;
        }
    }
}
