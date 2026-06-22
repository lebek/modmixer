import { useEffect, useState } from 'react';

/**
 * Final gate before pushing a Minecraft mod to Modrinth. Collects the
 * per-version fields — version number and changelog — that start fresh on every
 * publish, the way RimWorld's PublishConfirmDialog collects change notes. The
 * project-level metadata (slug, title, description, …) stays in the panel.
 */
export function MinecraftPublishConfirmDialog({
  open,
  isUpdate,
  modName,
  defaultVersion,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  isUpdate: boolean;
  modName: string;
  defaultVersion: string;
  onCancel: () => void;
  onConfirm: (result: { versionNumber: string; changelog: string }) => void;
}) {
  const [versionNumber, setVersionNumber] = useState(defaultVersion);
  const [changelog, setChangelog] = useState('');

  // Both fields are per-version, so they reset every time the dialog opens.
  useEffect(() => {
    if (open) {
      setVersionNumber(defaultVersion);
      setChangelog('');
    }
  }, [open, defaultVersion]);

  if (!open) return null;

  const canConfirm = versionNumber.trim().length > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-md border border-line bg-paper shadow-lg">
        <div className="border-b border-line px-4 py-3">
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
            modmixer · modrinth
          </div>
          <div className="mt-1 text-sm font-medium text-ink">
            {isUpdate ? 'Publish update?' : 'Publish to Modrinth?'}
          </div>
        </div>

        <div className="space-y-3 px-4 py-3 text-sm text-ink">
          <p>
            {isUpdate ? (
              <>
                Upload a new version of{' '}
                <span className="font-medium">{modName}</span> to its existing
                Modrinth project.
              </>
            ) : (
              <>
                <span className="font-medium">{modName}</span> will be created on
                Modrinth as a draft, pending moderation review before it's
                public.
              </>
            )}
          </p>

          <label className="block space-y-1.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
              Version number
            </span>
            <input
              type="text"
              value={versionNumber}
              onChange={(e) => setVersionNumber(e.target.value)}
              className="w-full rounded-md border border-line bg-paper px-2.5 py-1.5 text-sm text-ink focus:border-accent focus:outline-none"
              placeholder="1.0.0"
            />
            <span className="block text-xs text-muted">
              Semver, unique per upload. Targets Minecraft 1.21.1 / NeoForge.
            </span>
          </label>

          <label className="block space-y-1.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
              Changelog
            </span>
            <textarea
              value={changelog}
              onChange={(e) => setChangelog(e.target.value)}
              rows={4}
              className="w-full resize-y rounded-md border border-line bg-paper px-2.5 py-1.5 text-sm text-ink focus:border-accent focus:outline-none"
              placeholder="What changed in this version?"
            />
            <span className="block text-xs text-muted">
              Shown on the version's Modrinth page. Leave blank to skip.
            </span>
          </label>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-3">
          <button
            onClick={onCancel}
            className="rounded-md border border-line bg-paper px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-ink transition-colors hover:border-ink/40"
          >
            Cancel
          </button>
          <button
            onClick={() =>
              onConfirm({ versionNumber: versionNumber.trim(), changelog })
            }
            disabled={!canConfirm}
            className="rounded-md bg-ink px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-paper shadow-sm transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isUpdate ? 'Publish update' : 'Publish'}
          </button>
        </div>
      </div>
    </div>
  );
}
