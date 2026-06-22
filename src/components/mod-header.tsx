import { useEffect, useRef, useState } from 'react';
import type { WorkspaceMod } from '../agent/workspace';
import { getGame } from '../agent/games/registry';
import { cn } from '@/lib/cn';

export function ModHeader({
  mod,
  conversationId,
  busy,
  onTest,
  hasAi,
}: {
  mod: WorkspaceMod;
  conversationId: string;
  busy: boolean;
  onTest: () => void;
  hasAi: boolean;
}) {
  const game = mod.prefs.game;
  const isRimWorld = game === 'rimworld';
  // The "close rimworld" affordance only applies to RimWorld; for other games
  // we just show the test/launch button (the test flow itself is game-aware).
  const running = useRimWorldRunning(isRimWorld);
  const [closing, setClosing] = useState(false);

  const onClose = async () => {
    if (closing) return;
    setClosing(true);
    try {
      await window.modmixer.quitRimWorld();
    } catch (err) {
      console.error(err);
    } finally {
      setClosing(false);
    }
  };

  return (
    <div className="flex items-center justify-between border-b border-line px-5 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-3">
          <h1 className="truncate font-display text-base font-medium text-ink">
            {mod.about.name || mod.folder}
          </h1>
          {mod.about.packageId && (
            <span className="truncate font-mono text-[10px] uppercase tracking-[0.18em] text-subtle">
              {mod.about.packageId}
            </span>
          )}
        </div>
        {(mod.schematic?.shortDescription || mod.about.description) && (
          <p className="mt-0.5 truncate text-xs text-muted">
            {mod.schematic?.shortDescription || mod.about.description}
          </p>
        )}
      </div>
      <div className="ml-4 flex items-center gap-2">
        {isRimWorld && running ? (
          <button
            onClick={onClose}
            disabled={closing}
            className={cn(
              'group inline-flex items-center gap-2 rounded-md border border-line bg-paper px-4 py-2 font-mono text-[11px] uppercase tracking-[0.18em] text-muted shadow-sm transition-colors hover:border-ink/30 hover:text-ink active:translate-y-px disabled:cursor-not-allowed disabled:opacity-40',
            )}
          >
            <CloseIcon />
            close rimworld
          </button>
        ) : (
          <button
            data-demo="launch"
            onClick={onTest}
            disabled={busy || !hasAi}
            title={!hasAi ? 'Connect an AI provider to run tests' : undefined}
            className={cn(
              'group inline-flex items-center gap-2 rounded-md border border-accent bg-accent px-4 py-2 font-mono text-[11px] uppercase tracking-[0.18em] text-accent-foreground shadow-sm transition-all hover:bg-accent-soft hover:shadow-md active:translate-y-px disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none',
            )}
          >
            <LaunchIcon />
            {isRimWorld
              ? 'launch in rimworld'
              : `test in ${getGame(game).displayName.toLowerCase()}`}
          </button>
        )}
        <SessionMenu conversationId={conversationId} />
      </div>
    </div>
  );
}

/**
 * Discrete overflow menu for rarely-used, per-chat troubleshooting actions.
 * Today its only entry copies this chat's raw session transcript (.jsonl) to
 * the clipboard so a tester can paste it into a bug report. Closes on
 * outside-click and flips the item to a confirmation for a beat after copying.
 */
function SessionMenu({ conversationId }: { conversationId: string }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (target && menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  const copyLog = async () => {
    let ok = false;
    try {
      const res = await window.modmixer.copySessionLog(conversationId);
      ok = res.ok;
    } catch {
      // Clipboard/read failures aren't actionable here — just don't confirm.
    }
    if (!ok) {
      setOpen(false);
      return;
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setCopied(false);
      setOpen(false);
    }, 1200);
  };

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Troubleshooting"
        aria-label="Troubleshooting"
        className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-line text-muted shadow-sm transition-colors hover:border-ink/30 hover:text-ink"
      >
        <KebabIcon />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-56 overflow-hidden rounded-md border border-line bg-paper shadow-xl">
          <button
            type="button"
            onClick={() => void copyLog()}
            className="block w-full px-3 py-2 text-left text-[12px] text-ink hover:bg-surface"
          >
            {copied ? 'Copied session log ✓' : 'Copy session log'}
          </button>
        </div>
      )}
    </div>
  );
}

function KebabIcon() {
  return (
    <svg aria-hidden className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="12" cy="5" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="12" cy="19" r="1.5" />
    </svg>
  );
}

function useRimWorldRunning(enabled: boolean): boolean {
  const [running, setRunning] = useState(false);
  useEffect(() => {
    if (!enabled) {
      setRunning(false);
      return;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await window.modmixer.isRimWorldRunning();
        if (!cancelled) setRunning(r);
      } catch {
        if (!cancelled) setRunning(false);
      }
    };
    void tick();
    const id = window.setInterval(tick, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [enabled]);
  return running;
}

function LaunchIcon() {
  return (
    <svg
      aria-hidden
      className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5 group-active:translate-x-0"
      viewBox="0 0 24 24"
      fill="currentColor"
    >
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      aria-hidden
      className="h-3.5 w-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

