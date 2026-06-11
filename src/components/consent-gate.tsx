import { useEffect, useRef, useState } from 'react';
import { App } from '../App';
import type { ThemePreference } from '../agent/settings';
import { applyTheme, watchSystemTheme } from '../lib/theme';
import { anyConversationBusy } from '../conversations-store';
import { appConfirm, AppDialog } from './app-dialog';
import { ConfirmModal } from './confirm-modal';
import { OnboardingFlow } from './onboarding/onboarding-flow';

type Status = 'loading' | 'needs-onboarding' | 'ready';

/**
 * Gates the main app on first launch (or after a consent/onboarding version
 * bump). Shows the onboarding flow until the renderer confirms acceptance is
 * recorded; the agent is also gated server-side (`requireConsent` in
 * main.ts) — this component just keeps the UI coherent so the user can't
 * see a half-loaded chat panel.
 *
 * Kept as `ConsentGate` for naming continuity in renderer.tsx — it now
 * covers both consent and the broader onboarding flow.
 */
export function ConsentGate() {
  const [status, setStatus] = useState<Status>('loading');
  const themePrefRef = useRef<ThemePreference>('dark');

  useEffect(() => {
    let cancelled = false;
    void window.modmixer.getOnboardingStatus().then((s) => {
      if (cancelled) return;
      setStatus(s.shouldShow ? 'needs-onboarding' : 'ready');
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Sync the theme with persisted settings on launch and re-apply when the
  // OS toggles light/dark (only meaningful for the "auto" pref). The boot
  // script already painted the right colours from localStorage; this catches
  // the case where settings.json and localStorage drift.
  useEffect(() => {
    void window.modmixer.getSettings().then((s) => {
      themePrefRef.current = s.theme;
      applyTheme(s.theme);
    });
    return watchSystemTheme(() => themePrefRef.current);
  }, []);

  // Confirm a quit only while an agent turn is in flight — closing the window
  // aborts it. Main hands the close to us; with nothing running we let it go
  // through immediately so idle quits aren't nagged. The ref keeps repeated
  // window-close attempts from stacking duplicate dialogs.
  const quitPromptOpen = useRef(false);
  useEffect(() => {
    return window.modmixer.onQuitRequested(() => {
      if (!anyConversationBusy()) {
        window.modmixer.confirmQuit();
        return;
      }
      if (quitPromptOpen.current) return;
      quitPromptOpen.current = true;
      void appConfirm(
        'An agent is still responding. Quitting now will end any responses in progress.',
        {
          title: 'Quit Modmixer?',
          okLabel: 'Quit',
          cancelLabel: 'Keep working',
          tone: 'danger',
        },
      ).then((ok) => {
        quitPromptOpen.current = false;
        if (ok) window.modmixer.confirmQuit();
      });
    });
  }, []);

  if (status === 'loading') {
    // Don't flash an empty paper-coloured screen — paper matches the body
    // background so this is effectively the splash.
    return <div className="fixed inset-0 bg-paper" />;
  }

  if (status === 'needs-onboarding') {
    return <OnboardingFlow onComplete={() => setStatus('ready')} />;
  }

  return (
    <>
      <App />
      <ConfirmModal />
      <AppDialog />
    </>
  );
}
