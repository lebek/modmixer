import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { WorkspaceMod } from '../agent/workspace';
import type {
  AssetKind,
  AssetRequirement,
  AssetScan,
  TextureSpec,
} from '../agent/assets/types';
import { cn } from '@/lib/cn';
import { appAlert, appConfirm } from './app-dialog';

const KIND_LABEL: Record<AssetKind, string> = {
  texture: 'Textures',
  audio: 'Audio',
  icon: 'Icons',
};
const KIND_ORDER: AssetKind[] = ['texture', 'audio', 'icon'];

export function AssetsView({ mod }: { mod: WorkspaceMod }) {
  const [scan, setScan] = useState<AssetScan | null>(null);
  const [activeKind, setActiveKind] = useState<AssetKind>('texture');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await window.modmixer.scanAssets(mod.folder);
      setScan(s);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [mod.folder]);

  useEffect(() => {
    void refresh();
    const off = window.modmixer.onAssetsChanged(({ folder }) => {
      if (folder === mod.folder) void refresh();
    });
    return off;
  }, [mod.folder, refresh]);

  const requirementsByKind = useMemo(() => {
    const map: Record<AssetKind, AssetRequirement[]> = {
      texture: [],
      audio: [],
      icon: [],
    };
    if (scan) for (const r of scan.requirements) map[r.kind].push(r);
    return map;
  }, [scan]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b border-line px-5 py-2">
        {KIND_ORDER.map((k) => {
          const items = requirementsByKind[k];
          const counts = scan?.countsByKind[k];
          const label = KIND_LABEL[k];
          const total = items.length;
          const done = counts ? counts.present : 0;
          return (
            <button
              key={k}
              onClick={() => setActiveKind(k)}
              className={cn(
                'rounded-md px-3 py-1 font-mono text-[11px] uppercase tracking-[0.18em] transition-colors',
                activeKind === k
                  ? 'bg-ink text-paper'
                  : 'text-muted hover:bg-raised/60 hover:text-ink',
              )}
            >
              {label}
              <span className="ml-2 text-[10px] opacity-70">
                {done}/{total}
              </span>
            </button>
          );
        })}
      </div>

      <div className="flex-1 overflow-auto px-5 py-4">
        {error && (
          <div className="mb-3 rounded-md border border-failed/40 bg-failed/5 px-3 py-2 text-xs text-failed">
            {error}
          </div>
        )}
        <KindPane
          folder={mod.folder}
          kind={activeKind}
          requirements={requirementsByKind[activeKind]}
          loaded={scan != null}
          onChanged={refresh}
        />
      </div>
    </div>
  );
}

function KindPane({
  folder,
  kind,
  requirements,
  loaded,
  onChanged,
}: {
  folder: string;
  kind: AssetKind;
  requirements: AssetRequirement[];
  loaded: boolean;
  onChanged: () => void;
}) {
  if (!loaded) {
    return (
      <div className="text-sm text-subtle">Scanning mod for asset references…</div>
    );
  }
  if (requirements.length === 0) {
    return (
      <div className="rounded-md border border-line bg-paper/70 px-4 py-6 text-sm text-muted">
        No {KIND_LABEL[kind].toLowerCase()} are referenced by this mod's defs yet.
        Add a def with a {kind === 'audio' ? '<clipPath>' : kind === 'icon' ? '<uiIconPath>' : '<texPath>'} entry
        and it will appear here.
      </div>
    );
  }

  const missing = requirements.filter((r) => r.status === 'missing');
  const invalid = requirements.filter((r) => r.status === 'invalid');
  const present = requirements.filter((r) => r.status === 'present');

  return (
    <div className="space-y-6">
      <Section title={`Missing (${missing.length})`} accent>
        {missing.map((r) => (
          <Card key={r.id} folder={folder} req={r} onChanged={onChanged} />
        ))}
        {missing.length === 0 && (
          <p className="text-xs text-subtle">Nothing missing here.</p>
        )}
      </Section>

      {invalid.length > 0 && (
        <Section title={`Invalid (${invalid.length})`} warn>
          {invalid.map((r) => (
            <Card key={r.id} folder={folder} req={r} onChanged={onChanged} />
          ))}
        </Section>
      )}

      <Section title={`Present (${present.length})`}>
        {present.map((r) => (
          <Card key={r.id} folder={folder} req={r} onChanged={onChanged} />
        ))}
        {present.length === 0 && (
          <p className="text-xs text-subtle">No assets in place yet.</p>
        )}
      </Section>
    </div>
  );
}

function Section({
  title,
  children,
  accent,
  warn,
}: {
  title: string;
  children: React.ReactNode;
  accent?: boolean;
  warn?: boolean;
}) {
  return (
    <section>
      <h2
        className={cn(
          'mb-2 font-mono text-[11px] uppercase tracking-[0.18em]',
          accent ? 'text-accent' : warn ? 'text-failed' : 'text-muted',
        )}
      >
        {title}
      </h2>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function Card({
  folder,
  req,
  onChanged,
}: {
  folder: string;
  req: AssetRequirement;
  onChanged: () => void;
}) {
  return (
    <div
      className={cn(
        'rounded-md border bg-paper/70 p-4',
        req.status === 'invalid'
          ? 'border-failed/40'
          : req.status === 'missing'
            ? 'border-line'
            : 'border-ready/30',
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <code className="truncate font-mono text-sm text-ink">{req.path}</code>
            <StatusPill status={req.status} />
            {req.stubbed && (
              <span
                title="modmixer wrote a placeholder here so RimWorld won't error. Drop your real file in to replace it."
                className="inline-flex items-center rounded-full border border-line bg-surface px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em] text-subtle"
              >
                placeholder
              </span>
            )}
          </div>
          {req.notes.length > 0 ? (
            <p className="mt-1 text-sm text-ink">{req.notes[0]}</p>
          ) : (
            <p className="mt-1 text-xs italic text-subtle">
              No description in the def — ask modmixer to annotate this reference.
            </p>
          )}
          {req.notes.slice(1).map((n, i) => (
            <p key={i} className="mt-1 text-xs text-muted">
              {n}
            </p>
          ))}
          <p className="mt-1 text-xs text-muted">{req.spec.description}</p>
          {'sizeHint' in req.spec && req.spec.sizeHint && (
            <p className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.18em] text-subtle">
              {req.spec.sizeHint}
            </p>
          )}
          <ReferencedBy req={req} />
        </div>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <DropSlot
          folder={folder}
          relPath={req.path}
          kind={req.kind}
          present={req.status === 'present' || req.status === 'invalid'}
          issues={req.current?.issues ?? []}
          meta={req.current?.meta}
          onChanged={onChanged}
          label="Main file"
        />
        {req.kind === 'texture' &&
          (req.spec as TextureSpec).acceptsMask &&
          req.mask && (
            <DropSlot
              folder={folder}
              relPath={req.mask.path}
              kind="texture"
              present={req.mask.status === 'present'}
              issues={req.mask.current?.issues ?? []}
              meta={req.mask.current?.meta}
              onChanged={onChanged}
              label="Team-color mask"
              optional
              hint="Optional — only used if you want team-color tinting (apparel, faction items). Skip if not needed."
            />
          )}
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: AssetRequirement['status'] }) {
  const label =
    status === 'present' ? 'present' : status === 'invalid' ? 'invalid' : 'missing';
  const cls =
    status === 'present'
      ? 'border-ready/40 bg-ready/10 text-ready'
      : status === 'invalid'
        ? 'border-failed/40 bg-failed/10 text-failed'
        : 'border-line bg-surface text-muted';
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em]',
        cls,
      )}
    >
      {label}
    </span>
  );
}

function ReferencedBy({ req }: { req: AssetRequirement }) {
  if (req.referencedBy.length === 0) return null;
  return (
    <div className="mt-2 space-y-1 text-[11px] text-subtle">
      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
        Required by
      </div>
      {req.referencedBy.slice(0, 4).map((r, i) => (
        <div key={i}>
          <div className="truncate font-mono text-[10px]">
            <span className="text-ink/70">{r.defType}</span>.
            <span className="text-ink">{r.defName}</span>
            <span className="ml-1 text-subtle">· {r.field}</span>
            <span className="ml-1 text-subtle">· {r.sourceFile}</span>
          </div>
          {r.note && (
            <div className="pl-3 text-[11px] text-muted">↳ {r.note}</div>
          )}
        </div>
      ))}
      {req.referencedBy.length > 4 && (
        <div className="font-mono text-[10px]">
          +{req.referencedBy.length - 4} more
        </div>
      )}
    </div>
  );
}

function DropSlot({
  folder,
  relPath,
  kind,
  present,
  issues,
  meta,
  onChanged,
  label,
  optional,
  hint,
}: {
  folder: string;
  relPath: string;
  kind: AssetKind;
  present: boolean;
  issues: string[];
  meta?: { width?: number; height?: number; size: number; detectedFormat?: string };
  onChanged: () => void;
  label: string;
  optional?: boolean;
  hint?: string;
}) {
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!present) {
      setPreviewUrl(null);
      return;
    }
    void window.modmixer.readAssetDataUrl(folder, relPath).then((url) => {
      if (!cancelled) setPreviewUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [folder, relPath, present]);

  const submit = async (sourcePath: string) => {
    setBusy(true);
    try {
      await window.modmixer.addAsset(folder, relPath, sourcePath);
      onChanged();
    } catch (err) {
      console.error(err);
      void appAlert(err instanceof Error ? err.message : 'Failed to add asset.');
    } finally {
      setBusy(false);
    }
  };

  const browse = async () => {
    const picked = await window.modmixer.pickAssetFile(kind);
    if (picked) await submit(picked);
  };

  const remove = async () => {
    const ok = await appConfirm(`Remove ${relPath}?`, {
      okLabel: 'Remove',
      tone: 'danger',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await window.modmixer.removeAsset(folder, relPath);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (!f) return;
    const p = window.modmixer.getPathForFile(f);
    if (!p) {
      void appAlert('Could not read file path. Drag the file from Finder/Explorer.');
      return;
    }
    void submit(p);
  };

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
      className={cn(
        'rounded-md border p-3 transition-colors',
        optional ? 'border-dashed' : 'border-solid',
        dragOver
          ? 'border-accent bg-accent/5'
          : present
            ? 'border-line bg-surface/40'
            : 'border-line bg-surface/20',
        optional && !present && 'opacity-75',
      )}
    >
      <div className="mb-2 flex items-center justify-between">
        <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
          {label}
          {optional && (
            <span className="ml-2 text-[9px] text-subtle">optional</span>
          )}
        </div>
        {present && (
          <button
            onClick={remove}
            disabled={busy}
            className="font-mono text-[10px] uppercase tracking-[0.18em] text-subtle transition-colors hover:text-failed disabled:opacity-40"
          >
            remove
          </button>
        )}
      </div>

      {present ? (
        <div className="flex items-center gap-3">
          <Preview kind={kind} url={previewUrl} />
          <div className="min-w-0 text-xs">
            {meta?.width && meta?.height && (
              <div className="font-mono text-ink">
                {meta.width} × {meta.height}
              </div>
            )}
            <div className="font-mono text-[10px] text-subtle">
              {formatSize(meta?.size ?? 0)}
              {meta?.detectedFormat && ` · ${meta.detectedFormat}`}
            </div>
            {issues.length > 0 && (
              <ul className="mt-1 list-disc pl-4 text-failed">
                {issues.map((i, idx) => (
                  <li key={idx}>{i}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-start gap-2">
          {hint && <p className="text-[11px] leading-snug text-muted">{hint}</p>}
          <p className="text-xs text-muted">
            {dragOver
              ? 'Release to add file'
              : `Drag a ${kind === 'audio' ? '.ogg' : '.png'} here or:`}
          </p>
          <button
            onClick={browse}
            disabled={busy}
            className="rounded-md border border-line bg-paper px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-muted transition-colors hover:border-ink/30 hover:text-ink disabled:opacity-40"
          >
            browse
          </button>
        </div>
      )}
    </div>
  );
}

function Preview({ kind, url }: { kind: AssetKind; url: string | null }) {
  if (kind === 'audio') {
    return (
      <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded border border-line bg-paper">
        {url ? (
          <AudioPreview url={url} />
        ) : (
          <span className="font-mono text-[10px] text-subtle">…</span>
        )}
      </div>
    );
  }
  return (
    <div
      className="flex h-16 w-16 shrink-0 items-center justify-center rounded border border-line bg-[length:8px_8px] [background-image:linear-gradient(45deg,#0001_25%,transparent_25%,transparent_75%,#0001_75%),linear-gradient(45deg,#0001_25%,transparent_25%,transparent_75%,#0001_75%)] [background-position:0_0,4px_4px]"
    >
      {url ? (
        <img src={url} alt="preview" className="max-h-full max-w-full object-contain" />
      ) : (
        <span className="font-mono text-[10px] text-subtle">…</span>
      )}
    </div>
  );
}

function AudioPreview({ url }: { url: string }) {
  const ref = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  return (
    <button
      onClick={() => {
        const el = ref.current;
        if (!el) return;
        if (playing) {
          el.pause();
          el.currentTime = 0;
        } else {
          void el.play();
        }
      }}
      className="font-mono text-[18px] text-ink"
      title={playing ? 'Stop' : 'Play'}
    >
      {playing ? '■' : '▶'}
      <audio
        ref={ref}
        src={url}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
      />
    </button>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
