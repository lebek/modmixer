import { useEffect, useRef, useState } from 'react';
import { App } from '../App';
import type { ThemePreference } from '../agent/settings';
import { applyTheme, watchSystemTheme } from '../lib/theme';
import { ConfirmModal } from './confirm-modal';
import { ConsentScreen } from './consent-screen';

type Status = 'loading' | 'needs-consent' | 'ready';

/**
 * Mounts the consent screen on first launch (or after a consent version
 * bump) and only renders <App /> once the main process confirms acceptance
 * is recorded. The agent is also gated server-side (`requireConsent` in
 * main.ts) — this component just keeps the UI coherent so the user can't
 * see a half-loaded chat panel.
 */
export function ConsentGate() {
  const [status, setStatus] = useState<Status>('loading');
  const themePrefRef = useRef<ThemePreference>('dark');

  useEffect(() => {
    let cancelled = false;
    void window.modmixer.getConsentStatus().then((s) => {
      if (cancelled) return;
      const accepted =
        s.accepted !== null && s.accepted.version === s.required;
      setStatus(accepted ? 'ready' : 'needs-consent');
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

  if (status === 'loading') {
    // Don't flash an empty paper-coloured screen — paper matches the body
    // background so this is effectively the splash.
    return <div className="fixed inset-0 bg-paper" />;
  }

  if (status === 'needs-consent') {
    return <ConsentScreen onAccepted={() => setStatus('ready')} />;
  }

  return (
    <>
      <App />
      <ConfirmModal />
    </>
  );
}
