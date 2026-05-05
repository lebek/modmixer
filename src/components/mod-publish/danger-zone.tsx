import { useState } from 'react';
import { useAsyncAction } from '@/lib/use-async-action';

/**
 * Confirmation-gated mod deletion. The user must type the mod's display
 * name to confirm — same shape as GitHub's repo-delete dialog. Calls
 * `onDeleted` only after the IPC succeeds.
 */
export function DangerZone({
  modFolder,
  expectedConfirmText,
  hasWorkshopItem,
  onDeleted,
}: {
  modFolder: string;
  expectedConfirmText: string;
  hasWorkshopItem: boolean;
  onDeleted?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const del = useAsyncAction(async () => {
    await window.modmixer.deleteMod(modFolder);
    onDeleted?.();
  });

  const matches =
    confirmText.trim() === expectedConfirmText.trim() &&
    expectedConfirmText.trim() !== '';

  return (
    <section className="space-y-3 border-t border-failed/30 pt-6">
      <header>
        <h2 className="font-display text-sm font-medium text-failed">
          Danger zone
        </h2>
        <p className="mt-0.5 text-xs text-muted">
          Deleting removes the mod folder from disk, the symlink in
          RimWorld's Mods/ directory, the entry in ModsConfig.xml, and any
          agent chats for this mod. This cannot be undone.
          {hasWorkshopItem && (
            <>
              {' '}The Steam Workshop item is <em>not</em> removed — delete
              it from the Workshop page yourself if you want it gone.
            </>
          )}
        </p>
      </header>

      {!open ? (
        <div className="flex items-center justify-end pt-1">
          <button
            onClick={() => setOpen(true)}
            className="rounded-md border border-failed/50 bg-paper px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-failed transition-colors hover:bg-failed/5"
          >
            Delete this mod…
          </button>
        </div>
      ) : (
        <div className="space-y-3 rounded-md border border-failed/40 bg-failed/5 px-3 py-3">
          <p className="text-xs text-ink">
            Type{' '}
            <span className="rounded bg-paper px-1 py-0.5 font-mono text-[11px] text-failed">
              {expectedConfirmText}
            </span>{' '}
            to confirm.
          </p>
          <input
            type="text"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            disabled={del.busy}
            autoFocus
            className="w-full rounded-md border border-line bg-paper px-2.5 py-1.5 text-sm text-ink focus:border-failed focus:outline-none"
            placeholder={expectedConfirmText}
          />
          {del.error && (
            <div className="rounded-md border border-failed/40 bg-paper px-3 py-2 text-xs text-failed">
              {del.error}
            </div>
          )}
          <div className="flex items-center justify-end gap-2">
            <button
              onClick={() => {
                setOpen(false);
                setConfirmText('');
                del.reset();
              }}
              disabled={del.busy}
              className="rounded-md border border-line bg-paper px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-muted transition-colors hover:border-ink/40 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              onClick={() => matches && void del.run()}
              disabled={!matches || del.busy}
              className="rounded-md bg-failed px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-paper transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {del.busy ? 'Deleting…' : 'Delete permanently'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
