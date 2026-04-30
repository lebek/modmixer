import { useState } from 'react';
import { GridMark } from './grid-mark';

export function ConsentScreen({ onAccepted }: { onAccepted: () => void }) {
  const [analyticsChecked, setAnalyticsChecked] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accept = async () => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await window.modmixer.acceptConsent({ analyticsOptIn: analyticsChecked });
      onAccepted();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex flex-col bg-paper">
      <header className="flex items-center gap-2.5 border-b border-line px-6 py-4">
        <GridMark />
        <span className="font-display text-lg font-medium tracking-tight text-ink">
          modmixer
        </span>
        <span className="ml-3 font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
          Welcome
        </span>
      </header>

      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col overflow-y-auto px-6 py-12 sm:px-10">
        <h1 className="font-display text-3xl font-bold uppercase tracking-[-0.02em] text-ink sm:text-4xl">
          Before you start
        </h1>
        <p className="mt-6 max-w-[60ch] text-sm leading-relaxed text-ink">
          Modmixer is an AI agent that reads and writes files on your computer
          to help you build RimWorld mods. AI can make mistakes, so back up
          your work and keep version control — you're using the agent at your
          own risk.
        </p>

        <div className="mt-10 space-y-3">
          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              checked={analyticsChecked}
              onChange={(e) => setAnalyticsChecked(e.target.checked)}
              className="mt-1"
            />
            <span className="text-sm text-ink">
              Help fix crashes and improve Modmixer
              <span className="mt-0.5 block text-xs text-muted">
                Send anonymous crash reports and basic usage events so we can
                spot bugs and prioritize fixes. No prompts, model output, file
                contents, or account info are sent. Crash reports may include
                stack traces with mod folder names; local home directory paths
                are scrubbed. You can change this any time in Settings.
              </span>
            </span>
          </label>
        </div>

        {error && (
          <p className="mt-4 max-w-[60ch] text-sm text-failed">{error}</p>
        )}

        <div className="mt-8 flex justify-end">
          <button
            type="button"
            onClick={() => void accept()}
            disabled={submitting}
            className="rounded-md bg-accent px-5 py-2 font-mono text-[11px] uppercase tracking-[0.18em] text-accent-foreground transition-opacity hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting ? 'Accepting…' : 'Accept & continue'}
          </button>
        </div>
      </main>
    </div>
  );
}
