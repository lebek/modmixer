using System;
using System.Collections.Generic;
using System.Reflection;
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

        // True while the chat input holds IMGUI keyboard focus. Read by
        // SearchWidgetFocusedPatch so the game treats the chat box like a
        // vanilla search widget: keybindings (WASD camera dolly, time
        // controls, hotkeys) stay quiet while typing and work again the
        // moment focus is released. Static because the keybinding gate has
        // no window instance in hand; onlyOneOfTypeAllowed keeps a single
        // LiveWindow.
        public static bool InputFocused;

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

            // Focus release, mirroring QuickSearchWidget: Escape hands the
            // keyboard back to the game (the window stays open — its own
            // close-on-cancel never sees the used event), and so does a
            // click anywhere that isn't the input row. Clicks outside the
            // window are covered by Notify_ClickOutsideWindow.
            bool focused = GUI.GetNameOfFocusedControl() == InputControlName;
            if (focused && Event.current.type == EventType.KeyDown
                && Event.current.keyCode == KeyCode.Escape)
            {
                UI.UnfocusCurrentControl();
                Event.current.Use();
            }
            else if (focused && OriginalEventUtility.EventType == EventType.MouseDown
                && !inputRect.Contains(Event.current.mousePosition)
                && !sendRect.Contains(Event.current.mousePosition))
            {
                UI.UnfocusCurrentControl();
            }

            GUI.SetNextControlName(InputControlName);
            inputText = Widgets.TextField(inputRect, inputText);
            if (Widgets.ButtonText(sendRect, "Send", true, true, connected)) submit = true;

            InputFocused = GUI.GetNameOfFocusedControl() == InputControlName;

            if (submit && connected) Submit(client);
        }

        public override void Notify_ClickOutsideWindow()
        {
            base.Notify_ClickOutsideWindow();
            // Clicking the map (or another window) releases the keyboard,
            // like vanilla search boxes.
            if (GUI.GetNameOfFocusedControl() == InputControlName)
                UI.UnfocusCurrentControl();
            InputFocused = false;
        }

        public override void PostClose()
        {
            base.PostClose();
            InputFocused = false; // never leave keybindings suppressed
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

    // Toggle entry point: a minimized main button on the bottom bar (the
    // Modmixer logo, sitting with History/Factions/Menu). The def lives in
    // Defs/MainButtonDefs/MainButtons.xml.
    public class MainButtonWorker_ToggleLiveWindow : MainButtonWorker
    {
        public override void Activate()
        {
            if (Find.WindowStack.IsOpen<LiveWindow>())
                Find.WindowStack.TryRemove(typeof(LiveWindow));
            else
                Find.WindowStack.Add(new LiveWindow());
        }
    }

    // While the chat input is focused, every keypress belongs to the
    // player's prose: report it through the same WindowStack switch the
    // vanilla QuickSearchWidget uses, which silences all KeyBindingDef
    // checks (WASD camera dolly, time controls, hotkeys). A real
    // QuickSearchWidget can't be used here because Window auto-draws
    // CommonSearchWidget into the title bar, magnifier icon and all.
    [HarmonyPatch]
    internal static class SearchWidgetFocusedPatch
    {
        private static MethodBase Target()
            => AccessTools.PropertyGetter(typeof(WindowStack), "AnySearchWidgetFocused");

        // False makes Harmony skip this class if the property ever moves.
        public static bool Prepare() => Target() != null;

        public static IEnumerable<MethodBase> TargetMethods()
        {
            var m = Target();
            if (m != null) yield return m;
        }

        public static void Postfix(ref bool __result)
        {
            if (!__result) __result = LiveWindow.InputFocused;
        }
    }
}
