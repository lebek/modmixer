import { loadSettings } from './settings.js';

/**
 * A short, passive reminder of the user's in-game launch policy, appended to
 * tool results that tend to sit right before a test decision (build_mod on
 * success, update_schematic). It re-asserts the policy at the moment it
 * matters most.
 *
 * Why a tool-result hint and not only the system prompt: weaker models (Kimi
 * was the observed case) honor a fresh, adjacent reminder far better than a
 * static rule buried up-context — and they relapse specifically on
 * *relaunches*, treating an earlier "yes" as standing authorization for the
 * next launch. Re-stating the policy every build/schematic cycle closes that
 * gap. Tool results aren't cached, so this is free to read the live setting
 * and vary per call (it even reflects a mid-chat toggle, unlike the frozen
 * per-conversation system-prompt block).
 *
 * Wording constraint: both host tools fire while the model is still
 * mid-change (compile-fix loops, schematic edits partway through a feature).
 * So this reads as a *policy* reminder, NOT "something is ready — go test
 * now". The "if and when you decide to test" / "when a change is ready"
 * framing hands the readiness judgment to the model rather than nudging it
 * to launch; it avoids imperatives ("do not", "only when") that would
 * over-suppress, and just covers HOW to launch once the model chooses to.
 */
export function launchModeHint(): string {
  const askFirst = !loadSettings().autoLaunch;
  const body = askFirst
    ? "Launch policy — ask first: if and when you decide to test in-game, confirm with the user before each run_test_cycle — including a relaunch after a change (an earlier OK doesn't carry over to the next launch). They can reply here or press the Launch button up top."
    : 'Launch policy — proactive: the user opted into automatic testing — when a change is ready to try, you can go straight to run_test_cycle without asking.';
  return `\n\n(${body})`;
}
