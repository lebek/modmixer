import { useEffect, useState } from 'react';
import type { WorkspaceMod } from '../agent/workspace';
import type { SchematicData } from '../agent/schematic';
import type { DefEntry } from '../agent/defs-scan';
import { Markdown } from './markdown';
import { cn } from '@/lib/cn';
import { getGame, resolveGameId } from '../agent/games/registry';

export function ModSchematicPanel({ mod }: { mod: WorkspaceMod }) {
  const [schematic, setSchematic] = useState<SchematicData | null>(
    mod.schematic,
  );
  const [defs, setDefs] = useState<DefEntry[] | null>(null);
  const [scanning, setScanning] = useState(false);
  // The Definitions section scans for authored XML defs (RimWorld Defs/*.xml).
  // Games that keep data as JSON (Minecraft under src/main/resources) have no
  // such scan, so skip it and hide the section.
  const hasDefScan = getGame(resolveGameId(mod.prefs.game)).capabilities.defScan;

  useEffect(() => {
    setSchematic(mod.schematic);
  }, [mod.folder, mod.schematic]);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      if (!hasDefScan) {
        setDefs([]);
        return;
      }
      setScanning(true);
      try {
        const list = await window.modmixer.scanModDefs(mod.folder);
        if (!cancelled) setDefs(list);
      } finally {
        if (!cancelled) setScanning(false);
      }
    };
    void refresh();
    const offMod = window.modmixer.onModChanged(({ folder }) => {
      if (folder !== mod.folder) return;
      void refresh();
      void window.modmixer.readSchematic(folder).then((s) => {
        if (!cancelled) setSchematic(s);
      });
    });
    return () => {
      cancelled = true;
      offMod();
    };
  }, [mod.folder, hasDefScan]);

  const grouped = groupByType(defs ?? []);
  const hasShort = !!schematic?.shortDescription;
  const hasBody = !!schematic?.body.trim();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-1 overflow-auto px-6 py-5">
        <div className="max-w-3xl space-y-8">
          <section>
            {hasShort ? (
              <p className="rounded-md border border-line bg-surface/40 px-4 py-3 text-sm leading-relaxed text-ink">
                {schematic!.shortDescription}
              </p>
            ) : (
              <EmptyHint>
                The agent will write a one-line summary here once the mod
                has shape. For now, chat about what you're trying to build.
              </EmptyHint>
            )}
          </section>

          <section>
            <SectionHeading>Notes</SectionHeading>
            {hasBody ? (
              <div className="rounded-md border border-line bg-paper px-4 py-3">
                <Markdown>{schematic!.body}</Markdown>
              </div>
            ) : (
              <EmptyHint>
                The agent maintains running notes here — what it's added,
                how each piece works, balance choices, and anything worth
                remembering across conversations.
              </EmptyHint>
            )}
          </section>

          {/* RimWorld XML defs (Defs/*.xml). NeoForge mods store data as JSON
              under src/main/resources/data/<modid>/, so there's nothing to
              scan — hide the section for non-RimWorld games. */}
          {hasDefScan && (
          <section>
            <div className="mb-2 flex items-baseline justify-between">
              <SectionHeading>Definitions</SectionHeading>
              <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-subtle">
                {scanning && defs === null
                  ? 'scanning…'
                  : `${defs?.length ?? 0} total`}
              </span>
            </div>
            {grouped.length === 0 ? (
              <EmptyHint>
                No defs yet. Anything the mod adds in <code>Defs/</code> will
                appear here automatically.
              </EmptyHint>
            ) : (
              <div className="space-y-5">
                {grouped.map(([defType, entries]) => (
                  <DefTypeGroup
                    key={defType}
                    defType={defType}
                    entries={entries}
                  />
                ))}
              </div>
            )}
          </section>
          )}
        </div>
      </div>
    </div>
  );
}

function DefTypeGroup({
  defType,
  entries,
}: {
  defType: string;
  entries: DefEntry[];
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline gap-2">
        <h3 className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted">
          {defType}
        </h3>
        <span className="font-mono text-[10px] text-subtle">
          {entries.length}
        </span>
      </div>
      <div className="divide-y divide-line rounded-md border border-line bg-paper">
        {entries.map((e, i) => (
          <DefRow
            key={`${e.file}:${e.defName || e.inheritName || i}`}
            entry={e}
          />
        ))}
      </div>
    </div>
  );
}

function DefRow({ entry }: { entry: DefEntry }) {
  const title = entry.label || entry.defName || entry.inheritName || '(unnamed)';
  const id = entry.defName || (entry.inheritName ? `${entry.inheritName} (abstract)` : '');
  return (
    <details className="group px-3 py-2">
      <summary className="flex cursor-pointer items-baseline gap-3 text-sm text-ink marker:hidden">
        <span className="font-mono text-[10px] text-subtle transition-transform group-open:rotate-90">
          ›
        </span>
        <span className="flex-1 truncate">
          <span className="font-medium">{title}</span>
          {id && id !== title && (
            <span className="ml-2 font-mono text-[11px] text-muted">{id}</span>
          )}
          {entry.abstract && (
            <span className="ml-2 rounded bg-raised px-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
              abstract
            </span>
          )}
          {entry.parentName && (
            <span className="ml-2 font-mono text-[10px] text-subtle">
              ↳ {entry.parentName}
            </span>
          )}
        </span>
        <span className="hidden truncate font-mono text-[10px] text-subtle sm:inline">
          {entry.file}
        </span>
      </summary>
      <div className="mt-2 space-y-2 pl-5">
        {entry.description && (
          <p
            className={cn(
              'text-sm leading-relaxed text-muted',
              'whitespace-pre-wrap',
            )}
          >
            {entry.description}
          </p>
        )}
        <pre className="overflow-x-auto rounded border border-line bg-surface/40 px-3 py-2 font-mono text-[11px] leading-relaxed text-ink">
          {entry.xml}
        </pre>
      </div>
    </details>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-2 font-display text-sm font-medium tracking-tight text-ink">
      {children}
    </h2>
  );
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-md border border-dashed border-line bg-surface/30 px-4 py-3 text-xs text-muted">
      {children}
    </p>
  );
}

function groupByType(defs: DefEntry[]): Array<[string, DefEntry[]]> {
  const map = new Map<string, DefEntry[]>();
  for (const d of defs) {
    const arr = map.get(d.defType) ?? [];
    arr.push(d);
    map.set(d.defType, arr);
  }
  return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
}
