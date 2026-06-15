import { useEffect, useState } from 'react';

// UgcItemVisibility values from steamworks.js (numeric literals — the enum
// can't be imported into the renderer because steamworks.js is externalized).
const VISIBILITY_PUBLIC = 0;

const VISIBILITY_OPTIONS = [
  { value: 0, label: 'Public', hint: 'Anyone can find and download it.' },
  { value: 1, label: 'Friends only', hint: 'Only your Steam friends can see it.' },
  { value: 2, label: 'Private', hint: 'Only you can see it — good for a test upload first.' },
  { value: 3, label: 'Unlisted', hint: 'Hidden from search; anyone with the link can view it.' },
] as const;

/**
 * Final gate before pushing a mod to the Steam Workshop. For a brand-new item
 * it doubles as the visibility chooser (Steam fixes visibility at create time,
 * and Modmixer deliberately leaves it untouched on later updates — so there's
 * nothing to persist and nothing to choose when updating). For an existing
 * item it's a plain are-you-sure confirm.
 */
export function PublishConfirmDialog({
  open,
  isUpdate,
  modName,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  isUpdate: boolean;
  modName: string;
  onCancel: () => void;
  onConfirm: (result: { visibility: number; changeNote: string }) => void;
}) {
  const [visibility, setVisibility] = useState<number>(VISIBILITY_PUBLIC);
  const [changeNote, setChangeNote] = useState('');

  // We don't persist the choice; every fresh publish starts from Public so the
  // default nudges people toward shipping their work publicly. Notes are
  // per-update, so they always start blank.
  useEffect(() => {
    if (open) {
      setVisibility(VISIBILITY_PUBLIC);
      setChangeNote('');
    }
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-md border border-line bg-paper shadow-lg">
        <div className="border-b border-line px-4 py-3">
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
            modmixer · steam workshop
          </div>
          <div className="mt-1 text-sm font-medium text-ink">
            {isUpdate ? 'Publish update?' : 'Publish to Steam Workshop?'}
          </div>
        </div>

        <div className="space-y-3 px-4 py-3 text-sm text-ink">
          {isUpdate ? (
            <>
              <p>
                Push your latest changes as an update to the existing Workshop
                item for <span className="font-medium">{modName}</span>. Its
                visibility and any Steam-side edits are left unchanged.
              </p>
              <label className="block space-y-1.5">
                <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
                  Change notes
                </span>
                <textarea
                  value={changeNote}
                  onChange={(e) => setChangeNote(e.target.value)}
                  rows={4}
                  className="w-full resize-y rounded-md border border-line bg-paper px-2.5 py-1.5 text-sm text-ink focus:border-accent focus:outline-none"
                  placeholder="What changed in this update?"
                />
                <span className="block text-xs text-muted">
                  Posted to the item's Workshop change history. Leave blank to
                  record a timestamp instead.
                </span>
              </label>
            </>
          ) : (
            <>
              <p>
                <span className="font-medium">{modName}</span> will be created on
                the Steam Workshop and go live immediately.
              </p>
              <fieldset className="space-y-1.5">
                <legend className="mb-1 font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
                  Who can see it
                </legend>
                {VISIBILITY_OPTIONS.map((opt) => (
                  <label
                    key={opt.value}
                    className={`flex cursor-pointer items-start gap-2 rounded-md border px-2.5 py-1.5 transition-colors ${
                      visibility === opt.value
                        ? 'border-accent bg-accent/5'
                        : 'border-line hover:border-ink/40'
                    }`}
                  >
                    <input
                      type="radio"
                      name="visibility"
                      checked={visibility === opt.value}
                      onChange={() => setVisibility(opt.value)}
                      className="mt-0.5 h-3 w-3"
                    />
                    <span>
                      <span className="text-ink">{opt.label}</span>
                      <span className="block text-xs text-muted">{opt.hint}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
              <p className="text-xs text-muted">
                You can change this later on the Steam Workshop page.
              </p>
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-3">
          <button
            onClick={onCancel}
            className="rounded-md border border-line bg-paper px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-ink transition-colors hover:border-ink/40"
          >
            Cancel
          </button>
          <button
            onClick={() => onConfirm({ visibility, changeNote })}
            className="rounded-md bg-ink px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-paper shadow-sm transition-opacity hover:opacity-90"
          >
            {isUpdate ? 'Publish update' : 'Publish'}
          </button>
        </div>
      </div>
    </div>
  );
}
