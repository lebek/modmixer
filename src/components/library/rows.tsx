import { useState } from 'react';
import { cn } from '@/lib/cn';
import type { ModIssue, RegistryMod, ModSource } from '@/agent/registry';
import { Badge, CORE_PACKAGE_ID, IconButton, SourceBadge, shortIssue } from './badges';

function previewUrl(source: ModSource, folder: string): string {
  return `modmixer-asset://preview/${source}/${encodeURIComponent(folder)}`;
}

const THUMB_SIZE = 'h-9 w-16'; // 36x64 — 16:9, matches row content height

function ModThumb({ source, folder }: { source: ModSource; folder: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div
        className={cn(
          THUMB_SIZE,
          'shrink-0 rounded-sm border border-line bg-raised/40',
        )}
      />
    );
  }
  return (
    <img
      src={previewUrl(source, folder)}
      alt=""
      decoding="async"
      onError={() => setFailed(true)}
      className={cn(
        THUMB_SIZE,
        'shrink-0 rounded-sm bg-raised/40 object-cover',
      )}
    />
  );
}

export function ModRow({
  mod,
  loadOrder,
  issues,
  onPrimary,
  primaryLabel,
  onMoveUp,
  onMoveDown,
  disabled,
  hidePrimary,
  onResolveDeps,
  selected,
  onSelect,
}: {
  mod: RegistryMod;
  loadOrder: number | null;
  issues: ModIssue[];
  onPrimary: () => void;
  primaryLabel: string;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  disabled?: boolean;
  hidePrimary?: boolean;
  onResolveDeps?: () => void;
  selected?: boolean;
  onSelect?: () => void;
}) {
  const isCore = mod.about.packageIdLc === CORE_PACKAGE_ID;
  return (
    <div
      onClick={onSelect}
      className={cn(
        'group relative flex cursor-pointer items-start gap-3 px-4 py-2 hover:bg-raised/40',
        selected && 'bg-accent/10 hover:bg-accent/10',
      )}
    >
      {loadOrder !== null && (
        <div className="w-7 shrink-0 pt-1 text-right font-mono text-[11px] text-muted">
          #{loadOrder}
        </div>
      )}
      <ModThumb source={mod.source} folder={mod.folder} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm text-ink" title={mod.about.name}>
            {mod.about.name || mod.folder}
          </span>
          <SourceBadge source={mod.source} isCore={isCore} />
          {mod.hasDlls && <Badge tone="neutral">DLL</Badge>}
          {issues.map((issue, i) => (
            <Badge
              key={i}
              tone={issue.kind === 'incompatible-mod-active' ? 'error' : 'warn'}
              title={issue.message}
            >
              {shortIssue(issue.kind)}
            </Badge>
          ))}
        </div>
        <div className="truncate text-[11px] text-muted">
          {mod.about.packageId || mod.folder}
          {mod.about.author && <> — {mod.about.author}</>}
        </div>
      </div>
      <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center gap-1 bg-gradient-to-l from-paper via-paper/95 to-transparent pl-10 pr-4 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
        {onMoveUp && (
          <IconButton onClick={onMoveUp} disabled={disabled} label="Move up">
            ↑
          </IconButton>
        )}
        {onMoveDown && (
          <IconButton onClick={onMoveDown} disabled={disabled} label="Move down">
            ↓
          </IconButton>
        )}
        {onResolveDeps && (
          <button
            onClick={onResolveDeps}
            disabled={disabled}
            title="Enable installed dependencies"
            className="rounded-md border border-amber-500/50 bg-paper px-2 py-0.5 text-[11px] uppercase tracking-wide text-amber-700 hover:bg-amber-500/10 disabled:opacity-50"
          >
            +deps
          </button>
        )}
        {!hidePrimary && (
          <button
            onClick={onPrimary}
            disabled={disabled}
            className="rounded-md border border-line bg-paper px-2 py-0.5 text-[11px] uppercase tracking-wide text-muted hover:border-ink/40 hover:text-ink disabled:opacity-50"
          >
            {primaryLabel}
          </button>
        )}
      </div>
    </div>
  );
}

export function MissingRow({
  packageId,
  loadOrder,
  onRemove,
  disabled,
  selected,
  onSelect,
}: {
  packageId: string;
  loadOrder: number;
  onRemove: () => void;
  disabled?: boolean;
  selected?: boolean;
  onSelect?: () => void;
}) {
  return (
    <div
      onClick={onSelect}
      className={cn(
        'flex cursor-pointer items-start gap-3 px-4 py-2 hover:bg-raised/40',
        selected && 'bg-accent/10 hover:bg-accent/10',
      )}
    >
      <div className="w-7 shrink-0 pt-1 text-right font-mono text-[11px] text-muted">
        #{loadOrder}
      </div>
      <div className="h-9 w-16 shrink-0 rounded-sm border border-line bg-raised/40" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm italic text-muted">{packageId}</span>
          <Badge tone="error" title="Active in ModsConfig.xml but no folder found on disk">
            missing
          </Badge>
        </div>
        <div className="text-[11px] text-muted">
          Active but not installed. Either install the mod or remove it from the list.
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          onClick={onRemove}
          disabled={disabled}
          className="rounded-md border border-line px-2 py-0.5 text-[11px] uppercase tracking-wide text-muted hover:border-ink/40 hover:text-ink disabled:opacity-50"
        >
          Remove
        </button>
      </div>
    </div>
  );
}
