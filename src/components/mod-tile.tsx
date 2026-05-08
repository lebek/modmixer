import type { WorkspaceMod } from '../agent/workspace';
import { useModPreview } from '@/lib/use-mod-preview';

export function ModTile({
  mod,
  onClick,
}: {
  mod: WorkspaceMod;
  onClick: () => void;
}) {
  const previewUrl = useModPreview(mod.folder);
  return (
    <button
      onClick={onClick}
      className="group flex gap-3 rounded-lg border border-line bg-surface/40 p-4 text-left transition-colors hover:border-ink/30"
    >
      {previewUrl && (
        <div className="aspect-video w-24 shrink-0 overflow-hidden rounded-md border border-line bg-surface/60">
          <img
            src={previewUrl}
            alt=""
            className="h-full w-full object-cover"
          />
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-baseline gap-3">
          <span className="truncate font-display text-base font-medium text-ink">
            {mod.about.name || mod.folder}
          </span>
        </div>
        {(mod.schematic?.shortDescription || mod.about.description) && (
          <p className="line-clamp-2 text-sm text-muted">
            {mod.schematic?.shortDescription || mod.about.description}
          </p>
        )}
        <div className="mt-1 flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.18em] text-subtle">
          {mod.hasCSharp && <span>C#</span>}
          {mod.hasDlls && <span>has dll</span>}
          {mod.about.supportedVersions.length > 0 && (
            <span>v={mod.about.supportedVersions.join(',')}</span>
          )}
        </div>
      </div>
    </button>
  );
}
