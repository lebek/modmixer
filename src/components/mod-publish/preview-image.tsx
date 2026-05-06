import { useEffect, useState } from 'react';
import { useAsyncAction } from '@/lib/use-async-action';
import { ErrorBanner, Field } from './ui';

/**
 * About/Preview.png viewer + browse/regenerate buttons. Loads the image
 * via readAssetDataUrl (so we don't need a custom file:// scheme handler)
 * and re-fetches when the asset watcher fires.
 */
export function PreviewImage({
  modFolder,
  hasAi,
  onGeneratePreview,
}: {
  modFolder: string;
  hasAi: boolean;
  onGeneratePreview: () => void;
}) {
  const [previewDataUrl, setPreviewDataUrl] = useState<string | null>(null);
  const browse = useAsyncAction(async () => {
    const sourceAbs = await window.modmixer.pickAssetFile('texture');
    if (!sourceAbs) return;
    // Run through setPreviewImage (not addAsset) so the file is normalized
    // to fit Steam's 1 MiB preview cap before it lands on disk.
    await window.modmixer.setPreviewImage(modFolder, sourceAbs);
    const url = await window.modmixer.readAssetDataUrl(modFolder, 'About/Preview.png');
    setPreviewDataUrl(url);
  });

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const url = await window.modmixer.readAssetDataUrl(modFolder, 'About/Preview.png');
      if (!cancelled) setPreviewDataUrl(url);
    };
    void refresh();
    // scanAssets primes the watcher so onAssetsChanged fires for this folder.
    void window.modmixer.scanAssets(modFolder).catch(() => undefined);
    const offAssets = window.modmixer.onAssetsChanged(({ folder }) => {
      if (folder === modFolder) void refresh();
    });
    return () => {
      cancelled = true;
      offAssets();
    };
  }, [modFolder]);

  return (
    <Field
      label="Preview image"
      hint="Shown on the Workshop page and in the in-game browser. 1280×720 recommended."
    >
      <div className="flex items-start gap-3">
        <div className="aspect-video w-40 shrink-0 overflow-hidden rounded-md border border-line bg-surface/60">
          {previewDataUrl ? (
            <img src={previewDataUrl} alt="Preview" className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-[10px] uppercase tracking-[0.18em] text-muted">
              no image
            </div>
          )}
        </div>
        <div className="flex flex-1 flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => void browse.run()}
              disabled={browse.busy}
              className="rounded-md border border-line bg-paper px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-ink transition-colors hover:border-ink/40 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {browse.busy ? 'Copying…' : previewDataUrl ? 'Replace…' : 'Browse…'}
            </button>
            <button
              onClick={onGeneratePreview}
              disabled={!hasAi || browse.busy}
              title={!hasAi ? 'Connect an AI provider in Settings to generate.' : undefined}
              className="rounded-md bg-accent px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-accent-foreground transition-opacity hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-40"
            >
              {previewDataUrl ? 'Regenerate' : 'Generate'}
            </button>
          </div>
          {browse.error && <ErrorBanner>{browse.error}</ErrorBanner>}
        </div>
      </div>
    </Field>
  );
}
