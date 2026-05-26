import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { WorkspaceMod } from '../agent/workspace';
import type {
  AssetKind,
  AssetRequirement,
  AssetScan,
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
          const total = requirementsByKind[k].length;
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
              {KIND_LABEL[k]}
              <span className="ml-2 text-[10px] opacity-70">{total}</span>
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
    const tagHint =
      kind === 'audio' ? '<clipPath>' : kind === 'icon' ? '<uiIconPath>' : '<texPath>';
    return (
      <div className="rounded-md border border-line bg-paper/70 px-4 py-6 text-sm text-muted">
        No {KIND_LABEL[kind].toLowerCase()} are referenced by this mod's defs yet.
        Add a def with a {tagHint} entry and it will appear here.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      {requirements.map((r) => (
        <Card key={r.id} folder={folder} req={r} onChanged={onChanged} />
      ))}
    </div>
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
        'rounded-md border bg-paper/70 p-3',
        req.status === 'invalid' ? 'border-failed/40' : 'border-line',
      )}
    >
      <Slot folder={folder} req={req} onChanged={onChanged} />
    </div>
  );
}

function Slot({
  folder,
  req,
  onChanged,
}: {
  folder: string;
  req: AssetRequirement;
  onChanged: () => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  // Preview shows the custom file when uploaded. Vanilla-resolved slots have
  // no previewable file (RimWorld bundles those into Unity asset archives) —
  // they render as an empty slot with a subline hint instead.
  useEffect(() => {
    let cancelled = false;
    if (req.status === 'present' || req.status === 'invalid') {
      void window.modmixer
        .readAssetDataUrl(folder, req.path)
        .then((url) => {
          if (!cancelled) setPreviewUrl(url);
        });
    } else {
      setPreviewUrl(null);
    }
    return () => {
      cancelled = true;
    };
  }, [folder, req.path, req.status]);

  const browse = async () => {
    const picked = await window.modmixer.pickAssetFile(req.kind);
    if (!picked) return;
    await submit(picked);
  };

  const submit = async (sourcePath: string) => {
    setBusy(true);
    try {
      await window.modmixer.addSlotFile(
        folder,
        {
          kind: req.kind,
          path: req.path,
          sourceFile: req.ref.sourceFile,
          tokenOffset: req.ref.tokenOffset,
        },
        sourcePath,
      );
      onChanged();
    } catch (err) {
      console.error(err);
      void appAlert(err instanceof Error ? err.message : 'Failed to add asset.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    const ok = await appConfirm('Remove this asset?', {
      okLabel: 'Remove',
      tone: 'danger',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await window.modmixer.removeAsset(folder, req.path);
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

  const userOwnsFile = req.status === 'present' || req.status === 'invalid';

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
      className={cn(
        'flex items-start gap-3 rounded-md border border-dashed p-3 transition-colors',
        dragOver
          ? 'border-accent bg-accent/5'
          : 'border-line/60 bg-surface/30',
      )}
    >
      <Preview kind={req.kind} url={previewUrl} />
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-sm font-semibold text-ink" title={req.path}>
          {humanizeAssetTitle(req)}
        </h3>
        {req.vanilla && req.status === 'missing' ? (
          <p className="mt-0.5 text-xs text-muted">
            uses vanilla {req.kind === 'audio' ? 'audio' : 'art'}
          </p>
        ) : (
          <>
            {'sizeHint' in req.spec && req.spec.sizeHint && (
              <p className="mt-0.5 text-xs text-muted">{req.spec.sizeHint}</p>
            )}
            {req.kind === 'audio' && (
              <p className="mt-0.5 text-xs text-muted">Ogg Vorbis</p>
            )}
          </>
        )}
        {req.status === 'invalid' && req.current?.issues.length ? (
          <ul className="mt-1 list-disc pl-4 text-xs text-failed">
            {req.current.issues.map((i, idx) => (
              <li key={idx}>{i}</li>
            ))}
          </ul>
        ) : null}
        <div className="mt-2 flex items-center gap-2">
          <button
            onClick={browse}
            disabled={busy}
            className="rounded-md border border-line bg-paper px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-muted transition-colors hover:border-ink/30 hover:text-ink disabled:opacity-40"
          >
            {userOwnsFile ? 'replace' : 'browse'}
          </button>
          {userOwnsFile && (
            <button
              onClick={remove}
              disabled={busy}
              className="font-mono text-[10px] uppercase tracking-[0.18em] text-subtle transition-colors hover:text-failed disabled:opacity-40"
            >
              remove
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Title for the slot card. Anchored on the def's own name (label > defName) so
 * vanilla-pathed items still read as "vine bow" rather than "BowShort". A
 * role suffix is appended for cases where the def has more than one slot
 * (directional sprites, icon vs main graphic) so siblings stay
 * distinguishable. Falls back to the path stem if no def name is available
 * (rare — only happens when scanner couldn't recover one).
 */
function humanizeAssetTitle(req: AssetRequirement): string {
  const base = req.ref.label?.trim() || req.ref.defName || stemTitleFallback(req);
  const suffix = roleSuffix(req);
  return suffix ? `${base} ${suffix}` : base;
}

function stemTitleFallback(req: AssetRequirement): string {
  const basename =
    req.path
      .split('/')
      .pop()
      ?.replace(/\.[^.]+$/, '') ?? req.stem;
  return basename;
}

function roleSuffix(req: AssetRequirement): string {
  const field = req.ref.field;
  if (field === 'uiIconPath') return '(icon)';
  // Graphic_Multi: field is "graphicData.texPath_north" etc.
  const multiDir = field.match(/^graphicData\.texPath_(north|south|east|west)$/i);
  if (multiDir) return `(${multiDir[1].toLowerCase()})`;
  // wornGraphicPath expansions: field is "wornGraphicPath_<suffix>" where the
  // suffix is the directional or body-typed token derived from on-disk files.
  const worn = field.match(/^wornGraphicPath_(.+)$/);
  if (worn) {
    const parts = worn[1].split('_');
    const dir = parts.pop();
    const body = parts.length ? parts.join('_') : undefined;
    if (dir) return body ? `(${body}, ${dir.toLowerCase()})` : `(${dir.toLowerCase()})`;
  }
  return '';
}

function Preview({ kind, url }: { kind: AssetKind; url: string | null }) {
  if (kind === 'audio') {
    return (
      <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded border border-line bg-paper">
        {url ? (
          <AudioPreview url={url} />
        ) : (
          <span className="font-mono text-[10px] text-subtle">·</span>
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
        <span className="font-mono text-[10px] text-subtle">·</span>
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
