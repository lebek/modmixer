import { useEffect, useState } from 'react';

/**
 * Load About/Preview.png as a data URL and refresh on asset changes for that
 * folder. Returns null until loaded, or when the file doesn't exist.
 */
export function useModPreview(folder: string): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    const refresh = async () => {
      const next = await window.modmixer.readAssetDataUrl(
        folder,
        'About/Preview.png',
      );
      if (!cancelled) setUrl(next);
    };
    void refresh();
    const off = window.modmixer.onAssetsChanged((env) => {
      if (env.folder === folder) void refresh();
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [folder]);
  return url;
}
