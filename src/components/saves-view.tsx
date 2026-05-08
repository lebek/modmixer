import { useEffect, useRef, useState } from 'react';
import type { SaveRecord } from '../agent/snapshots';
import type { WorkspaceMod } from '../agent/workspace';
import { cn } from '@/lib/cn';

/**
 * Subscribe to a mod's save list. Returns the live list — initial fetch
 * plus any push updates from the main process. Used by both the sidebar
 * (for the count badge) and the SavesView (for the full list).
 */
export function useSnapshots(folder: string | null): SaveRecord[] {
  const [saves, setSaves] = useState<SaveRecord[]>([]);
  useEffect(() => {
    if (!folder) {
      setSaves([]);
      return;
    }
    let cancelled = false;
    window.modmixer
      .listSnapshots(folder)
      .then((list) => {
        if (!cancelled) setSaves(list);
      })
      .catch(() => {
        // First run / git missing — empty list is the right fallback.
      });
    const off = window.modmixer.onSnapshotsChanged((event) => {
      if (event.folder !== folder) return;
      setSaves(event.saves);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [folder]);
  return saves;
}

/**
 * Saves panel for the active mod. Lives in the build sidebar's panel slot
 * (same level as Schematic / Assets / Deps / Publish). The "Save now"
 * button calls host.commitManualSave, which anchors the save to the
 * currently-active conversation's leaf entry id — so a later Restore can
 * also rewind chat to this point. If the user is viewing a mod whose chat
 * isn't the active conversation (rare in normal flows), the save still
 * captures the file state but skips the chat-rewind on restore.
 */
export function SavesView({ mod }: { mod: WorkspaceMod }) {
  const folder = mod.folder;
  const saves = useSnapshots(folder);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renamingSha, setRenamingSha] = useState<string | null>(null);
  // null = not creating; '' = creating with empty draft.
  const [newLabel, setNewLabel] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-line px-6 py-3">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
            Saves
          </div>
          <div className="text-sm text-ink">
            Roll the mod back to an earlier state
          </div>
        </div>
        {newLabel === null ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => setNewLabel('')}
            className="inline-flex items-center gap-1 rounded-md bg-accent px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.18em] text-accent-foreground transition-opacity hover:bg-accent-soft disabled:opacity-50"
          >
            + Save now
          </button>
        ) : (
          <div className="w-64">
            <NameDraft
              placeholder="Name this save…"
              initial={newLabel}
              onCancel={() => setNewLabel(null)}
              onCommit={(label) =>
                run(async () => {
                  await window.modmixer.saveSnapshot(label || null);
                  setNewLabel(null);
                })
              }
              disabled={busy}
            />
          </div>
        )}
      </div>
      {error && (
        <div className="border-b border-failed/40 bg-failed/5 px-6 py-2 text-[12px] text-failed">
          {error}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        {saves.length === 0 ? (
          <div className="px-6 py-12 text-center text-sm text-subtle">
            <div className="mx-auto max-w-sm">
              No saves yet. The agent auto-saves after every reply, or hit{' '}
              <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted">
                + Save now
              </span>{' '}
              to mark a checkpoint you can restore later.
            </div>
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {saves.map((s) => (
              <SaveRow
                key={s.sha}
                save={s}
                folder={folder}
                busy={busy}
                renaming={renamingSha === s.sha}
                onStartRename={() => setRenamingSha(s.sha)}
                onCancelRename={() => setRenamingSha(null)}
                onCommitRename={(label) =>
                  run(async () => {
                    await window.modmixer.renameSnapshot(
                      folder,
                      s.sha,
                      label || null,
                    );
                    setRenamingSha(null);
                  })
                }
                onRestore={() =>
                  run(() => window.modmixer.restoreSnapshot(folder, s.sha))
                }
                onRewindChat={() =>
                  run(() =>
                    window.modmixer.rewindChatToSnapshot(folder, s.sha),
                  )
                }
                onDelete={() =>
                  run(() => window.modmixer.deleteSnapshot(folder, s.sha))
                }
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function SaveRow({
  save,
  busy,
  renaming,
  onStartRename,
  onCancelRename,
  onCommitRename,
  onRestore,
  onRewindChat,
  onDelete,
}: {
  save: SaveRecord;
  folder: string;
  busy: boolean;
  renaming: boolean;
  onStartRename: () => void;
  onCancelRename: () => void;
  onCommitRename: (label: string) => void;
  onRestore: () => void;
  onRewindChat: () => void;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (target && menuRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  const displayLabel =
    save.label?.trim() ||
    (save.kind === 'manual' ? 'manual save' : 'auto-save');

  return (
    <li className="flex items-center gap-3 px-6 py-3">
      <div className="min-w-0 flex-1">
        {renaming ? (
          <NameDraft
            initial={save.label ?? ''}
            placeholder="Name this save…"
            onCancel={onCancelRename}
            onCommit={onCommitRename}
            disabled={busy}
          />
        ) : (
          <button
            type="button"
            onClick={onStartRename}
            className="block w-full truncate text-left text-sm text-ink hover:underline"
            title="Click to rename"
          >
            <span className={cn(!save.label && 'italic text-muted')}>
              {displayLabel}
            </span>
          </button>
        )}
        <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-subtle">
          {formatRelativeTime(save.timestamp)}
          {save.kind === 'manual' && save.label && (
            <span className="ml-2 text-muted">manual</span>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={onRestore}
        disabled={busy}
        className="inline-flex items-center gap-1 rounded-md border border-line bg-paper px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-ink shadow-sm transition-colors hover:bg-surface disabled:opacity-50"
        title="Restore files and rewind chat to this save"
      >
        Restore
      </button>
      <div className="relative" ref={menuRef}>
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          disabled={busy}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-surface hover:text-ink disabled:opacity-50"
          title="More"
        >
          <KebabIcon />
        </button>
        {menuOpen && (
          <div className="absolute right-0 top-full z-30 mt-1 w-48 overflow-hidden rounded-md border border-line bg-paper shadow-xl">
            <MenuItem
              label="Rename"
              onClick={() => {
                setMenuOpen(false);
                onStartRename();
              }}
            />
            <MenuItem
              label="Rewind chat only"
              onClick={() => {
                setMenuOpen(false);
                onRewindChat();
              }}
            />
            <MenuItem
              label="Delete"
              variant="danger"
              onClick={() => {
                setMenuOpen(false);
                onDelete();
              }}
            />
          </div>
        )}
      </div>
    </li>
  );
}

function MenuItem({
  label,
  onClick,
  variant,
}: {
  label: string;
  onClick: () => void;
  variant?: 'danger';
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'block w-full px-3 py-1.5 text-left text-[12px] hover:bg-surface',
        variant === 'danger' ? 'text-failed hover:bg-failed/10' : 'text-ink',
      )}
    >
      {label}
    </button>
  );
}

function NameDraft({
  initial,
  placeholder,
  onCancel,
  onCommit,
  disabled,
}: {
  initial: string;
  placeholder: string;
  onCancel: () => void;
  onCommit: (label: string) => void;
  disabled?: boolean;
}) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  return (
    <input
      ref={inputRef}
      type="text"
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onCommit(value.trim());
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }}
      onBlur={() => onCommit(value.trim())}
      className="w-full rounded-sm border border-line bg-surface px-2 py-1 text-[13px] text-ink focus:border-accent focus:outline-none"
    />
  );
}

function formatRelativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  const d = Math.round(diff / 86_400_000);
  if (d < 7) return `${d}d ago`;
  return new Date(ms).toLocaleDateString();
}

function KebabIcon() {
  return (
    <svg
      aria-hidden
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="currentColor"
    >
      <circle cx="12" cy="5" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="12" cy="19" r="1.5" />
    </svg>
  );
}
