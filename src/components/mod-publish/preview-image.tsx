import { useEffect, useState, type DragEvent } from 'react';
import { useAsyncAction } from '@/lib/use-async-action';
import { ErrorBanner, Field } from './ui';

/**
 * About/Preview.png viewer + browse/regenerate buttons. Loads the image
 * via readAssetDataUrl (so we don't need a custom file:// scheme handler)
 * and re-fetches when the asset watcher fires.
 *
 * Also exposes a "Background" drop zone for an optional user-supplied image
 * (typically a game screenshot) that the agent will use as the BG layer when
 * regenerating. The source is stored in a workspace sidecar dir
 * (`.modmixer/preview-bg/<folder>/source.png`) so it doesn't ship with the
 * published mod, only with the rendered preview.
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
  const [bgDataUrl, setBgDataUrl] = useState<string | null>(null);

  const browse = useAsyncAction(async () => {
    const sourceAbs = await window.modmixer.pickAssetFile('texture');
    if (!sourceAbs) return;
    // Run through setPreviewImage (not addAsset) so the file is normalized
    // to fit Steam's 1 MiB preview cap before it lands on disk.
    await window.modmixer.setPreviewImage(modFolder, sourceAbs);
    const url = await window.modmixer.readAssetDataUrl(modFolder, 'About/Preview.png');
    setPreviewDataUrl(url);
  });

  const refreshBg = async () => {
    const bg = await window.modmixer.getPreviewBg(modFolder);
    setBgDataUrl(bg ? bg.dataUrl : null);
  };

  const setBgFromPath = async (sourceAbs: string) => {
    await window.modmixer.setPreviewBg(modFolder, sourceAbs);
    await refreshBg();
  };

  const browseBg = useAsyncAction(async () => {
    const sourceAbs = await window.modmixer.pickPreviewBg();
    if (!sourceAbs) return;
    await setBgFromPath(sourceAbs);
  });

  const dropBg = useAsyncAction(async (file: File) => {
    const sourceAbs = window.modmixer.getPathForFile(file);
    if (!sourceAbs) {
      throw new Error('Could not resolve dropped file path. Try Browse instead.');
    }
    await setBgFromPath(sourceAbs);
  });

  const clearBg = useAsyncAction(async () => {
    await window.modmixer.clearPreviewBg(modFolder);
    await refreshBg();
  });

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const url = await window.modmixer.readAssetDataUrl(modFolder, 'About/Preview.png');
      if (!cancelled) setPreviewDataUrl(url);
    };
    void refresh();
    void refreshBg();
    // scanAssets primes the watcher so onAssetsChanged fires for this folder.
    void window.modmixer.scanAssets(modFolder).catch(() => undefined);
    const offAssets = window.modmixer.onAssetsChanged(({ folder }) => {
      if (folder === modFolder) void refresh();
    });
    return () => {
      cancelled = true;
      offAssets();
    };
    // refreshBg is intentionally omitted — it captures modFolder via closure
    // and we want it re-bound on folder change, which the dep array handles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modFolder]);

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (Array.from(e.dataTransfer.items).some((i) => i.kind === 'file')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (!file) return;
    void dropBg.run(file);
  };

  const bgError = browseBg.error || dropBg.error || clearBg.error;

  return (
    <>
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

      <Field
        label="Background image (optional)"
        hint="Drop a screenshot here (PNG/JPG) and the agent will use it as the background when you Generate. Otherwise it picks a color or gradient."
        action={
          bgDataUrl ? (
            <button
              onClick={() => void clearBg.run()}
              disabled={clearBg.busy}
              className="text-[10px] uppercase tracking-[0.18em] text-muted transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
            >
              remove
            </button>
          ) : null
        }
      >
        <div className="flex items-start gap-3">
          <div
            onDragOver={onDragOver}
            onDrop={onDrop}
            className={`aspect-video w-40 shrink-0 overflow-hidden rounded-md border border-dashed bg-surface/60 transition-colors ${
              dropBg.busy
                ? 'border-accent/60'
                : 'border-line hover:border-ink/40'
            }`}
          >
            {bgDataUrl ? (
              <img
                src={bgDataUrl}
                alt="Background"
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center px-2 text-center text-[10px] uppercase tracking-[0.18em] text-muted">
                drop image here
              </div>
            )}
          </div>
          <div className="flex flex-1 flex-col gap-2">
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => void browseBg.run()}
                disabled={browseBg.busy || dropBg.busy}
                className="rounded-md border border-line bg-paper px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-ink transition-colors hover:border-ink/40 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {browseBg.busy || dropBg.busy
                  ? 'Copying…'
                  : bgDataUrl
                  ? 'Replace…'
                  : 'Browse…'}
              </button>
            </div>
            {bgError && <ErrorBanner>{bgError}</ErrorBanner>}
          </div>
        </div>
      </Field>
    </>
  );
}
