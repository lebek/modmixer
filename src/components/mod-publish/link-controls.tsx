import { useState } from 'react';
import { useAsyncAction } from '@/lib/use-async-action';
import { formatRelative } from '@/lib/format-date';
import { ErrorBanner } from './ui';

/**
 * "Link" panel for mods that aren't yet associated with a Workshop ID.
 * Lets the user paste an existing PublishedFileId so the next publish
 * pushes an update instead of creating a fresh item.
 */
export function LinkExistingControl({
  modFolder,
  onLinked,
}: {
  modFolder: string;
  onLinked: (workshopId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const link = useAsyncAction(async (workshopId: string) => {
    await window.modmixer.linkWorkshopItem(modFolder, workshopId);
    onLinked(workshopId);
    setOpen(false);
    setInput('');
  });

  return (
    <div className="space-y-2 rounded-md border border-line bg-surface/60 px-3 py-2 text-xs text-ink">
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
            Workshop item
          </div>
          <div className="mt-0.5 text-[11px] text-muted">
            Not linked. Publishing will create a new Workshop item.
          </div>
        </div>
        {!open && (
          <button
            onClick={() => {
              setOpen(true);
              link.reset();
            }}
            className="shrink-0 text-[10px] uppercase tracking-[0.18em] text-muted transition-colors hover:text-ink"
          >
            link existing
          </button>
        )}
      </div>

      {open && (
        <div className="space-y-2 rounded-md border border-line bg-paper px-2.5 py-2">
          <p className="text-[11px] text-muted">
            Paste the Workshop ID to associate this mod with an existing item. Find it in the Steam Workshop URL after
            <span className="font-mono"> ?id=</span>.
          </p>
          <input
            type="text"
            inputMode="numeric"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={link.busy}
            autoFocus
            placeholder="1234567890"
            className="w-full rounded-md border border-line bg-paper px-2.5 py-1.5 font-mono text-[11px] text-ink focus:border-accent focus:outline-none"
          />
          {link.error && <ErrorBanner>{link.error}</ErrorBanner>}
          <div className="flex items-center justify-end gap-2">
            <button
              onClick={() => {
                setOpen(false);
                setInput('');
                link.reset();
              }}
              disabled={link.busy}
              className="text-[10px] uppercase tracking-[0.18em] text-muted hover:text-ink disabled:opacity-40"
            >
              cancel
            </button>
            <button
              onClick={() => void link.run(input.trim())}
              disabled={link.busy || !input.trim()}
              className="rounded-md bg-ink px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] text-paper transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {link.busy ? 'Linking…' : 'Link'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * "Disconnect" panel for mods already linked to a Workshop item. Drops
 * About/PublishedFileId.txt so the next publish creates a fresh item.
 */
export function UnlinkExistingControl({
  modFolder,
  publishedFileId,
  publishedUrl,
  lastPublishedAt,
  onUnlinked,
}: {
  modFolder: string;
  publishedFileId: string;
  publishedUrl: string | null;
  lastPublishedAt: number | null;
  onUnlinked: () => void;
}) {
  const [open, setOpen] = useState(false);
  const unlink = useAsyncAction(async () => {
    await window.modmixer.unlinkWorkshopItem(modFolder);
    onUnlinked();
    setOpen(false);
  });

  return (
    <div className="space-y-2 rounded-md border border-line bg-surface/60 px-3 py-2 text-xs text-ink">
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
            Workshop item
          </div>
          <div className="mt-0.5 font-mono text-[11px] text-muted">
            ID {publishedFileId}
          </div>
          {publishedUrl && (
            <button
              onClick={() => void window.modmixer.openExternal(publishedUrl)}
              className="mt-0.5 block w-full truncate text-left text-accent hover:underline"
            >
              {publishedUrl}
            </button>
          )}
          {lastPublishedAt && (
            <div
              className="mt-0.5 text-[11px] text-muted"
              title={new Date(lastPublishedAt).toLocaleString()}
            >
              Last published {formatRelative(lastPublishedAt)}
            </div>
          )}
        </div>
        {!open && (
          <button
            onClick={() => {
              setOpen(true);
              unlink.reset();
            }}
            className="shrink-0 text-[10px] uppercase tracking-[0.18em] text-muted transition-colors hover:text-failed"
          >
            disconnect
          </button>
        )}
      </div>

      {open && (
        <div className="space-y-2 rounded-md border border-failed/40 bg-failed/5 px-2.5 py-2">
          <p className="text-[11px] text-ink">
            Disconnecting clears the Workshop link locally so the next publish creates a new item. The existing Workshop item is not deleted.
          </p>
          {unlink.error && (
            <div className="rounded-md border border-failed/40 bg-paper px-2.5 py-1.5 text-[11px] text-failed">
              {unlink.error}
            </div>
          )}
          <div className="flex items-center justify-end gap-2">
            <button
              onClick={() => {
                setOpen(false);
                unlink.reset();
              }}
              disabled={unlink.busy}
              className="text-[10px] uppercase tracking-[0.18em] text-muted hover:text-ink disabled:opacity-40"
            >
              cancel
            </button>
            <button
              onClick={() => void unlink.run()}
              disabled={unlink.busy}
              className="rounded-md border border-failed/50 bg-paper px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] text-failed transition-colors hover:bg-failed/10 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {unlink.busy ? 'Disconnecting…' : 'Disconnect'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
