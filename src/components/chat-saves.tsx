import { useEffect, useRef, useState } from 'react';
import type { SaveRecord } from '../agent/snapshots';
import { cn } from '@/lib/cn';

/**
 * Saves panel: a popover anchored above the chat input. Shows the save
 * history for the active mod with a "Save now" action, inline rename, and
 * per-row Restore (files + chat) plus a kebab for rename / delete / rewind
 * chat only.
 *
 * The "Save" action depends on the active session being this conversation
 * (since the host pulls scope + leaf id from `this.active`). The chat panel
 * only renders this for mod-scoped chats it's currently viewing, so that
 * invariant holds in practice.
 */
export function ChatSavesButton({ folder }: { folder: string }) {
  const [open, setOpen] = useState(false);
  const [saves, setSaves] = useState<SaveRecord[]>([]);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // Initial load + subscribe to push events. The push event is mod-scoped,
  // so filter by folder before applying.
  useEffect(() => {
    let cancelled = false;
    window.modmixer
      .listSnapshots(folder)
      .then((list) => {
        if (!cancelled) setSaves(list);
      })
      .catch(() => {
        // Empty list is the right fallback — git missing or first-run race.
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

  // Click-outside closes the popover.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (target && wrapperRef.current?.contains(target)) return;
      setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <div className="relative" ref={wrapperRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-md border border-line bg-paper px-3 py-2 font-mono text-[11px] uppercase tracking-[0.18em] text-muted shadow-sm transition-colors hover:bg-surface hover:text-ink"
        title="Saves for this mod"
      >
        <SaveIcon />
        Saves
        {saves.length > 0 && (
          <span className="ml-0.5 text-subtle">({saves.length})</span>
        )}
      </button>
      {open && (
        <SavesPopover
          folder={folder}
          saves={saves}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

function SavesPopover({
  folder,
  saves,
  onClose,
}: {
  folder: string;
  saves: SaveRecord[];
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renamingSha, setRenamingSha] = useState<string | null>(null);
  // null = not creating; '' = creating with empty draft
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
    <div
      className="absolute bottom-full right-0 z-20 mb-2 w-[420px] max-w-[80vw] rounded-md border border-line bg-paper shadow-xl"
      role="dialog"
    >
      <div className="flex items-center justify-between border-b border-line px-3 py-2">
        <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
          Saves
        </div>
        {newLabel === null ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => setNewLabel('')}
            className="inline-flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-accent-foreground transition-opacity hover:bg-accent-soft disabled:opacity-50"
          >
            + Save now
          </button>
        ) : (
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
        )}
      </div>
      {error && (
        <div className="border-b border-failed/40 bg-failed/5 px-3 py-1.5 text-[11px] text-failed">
          {error}
        </div>
      )}
      <div className="max-h-[50vh] overflow-auto">
        {saves.length === 0 ? (
          <div className="px-3 py-6 text-center text-[12px] text-subtle">
            No saves yet. Saves auto-create after the AI replies, or hit
            “Save now” to make one yourself.
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
                  run(async () => {
                    await window.modmixer.restoreSnapshot(folder, s.sha);
                    onClose();
                  })
                }
                onRewindChat={() =>
                  run(async () => {
                    await window.modmixer.rewindChatToSnapshot(folder, s.sha);
                    onClose();
                  })
                }
                onDelete={() =>
                  run(async () => {
                    await window.modmixer.deleteSnapshot(folder, s.sha);
                  })
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

  const displayLabel = save.label?.trim() || (save.kind === 'manual' ? 'manual save' : 'auto-save');

  return (
    <li className="group flex items-center gap-2 px-3 py-2">
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
            className="block w-full truncate text-left text-[13px] text-ink hover:underline"
            title="Click to rename"
          >
            <span className={cn(!save.label && 'text-muted italic')}>
              {displayLabel}
            </span>
          </button>
        )}
        <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-subtle">
          {formatRelativeTime(save.timestamp)}
        </div>
      </div>
      <button
        type="button"
        onClick={onRestore}
        disabled={busy}
        className="inline-flex items-center gap-1 rounded-md border border-line bg-paper px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-ink shadow-sm transition-colors hover:bg-surface disabled:opacity-50"
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
          <div className="absolute right-0 top-full z-30 mt-1 w-44 overflow-hidden rounded-md border border-line bg-paper shadow-xl">
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
  if (diff < 3_600_000) {
    const m = Math.round(diff / 60_000);
    return `${m}m ago`;
  }
  if (diff < 86_400_000) {
    const h = Math.round(diff / 3_600_000);
    return `${h}h ago`;
  }
  const d = Math.round(diff / 86_400_000);
  if (d < 7) return `${d}d ago`;
  return new Date(ms).toLocaleDateString();
}

function SaveIcon() {
  return (
    <svg
      aria-hidden
      className="h-3.5 w-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
      <polyline points="17 21 17 13 7 13 7 21" />
      <polyline points="7 3 7 8 15 8" />
    </svg>
  );
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
