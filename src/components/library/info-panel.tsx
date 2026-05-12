import { useState } from 'react';
import type { ModIssue, ModSource, RegistryMod } from '@/agent/registry';
import { Badge, CORE_PACKAGE_ID, SourceBadge, shortIssue } from './badges';

function PreviewBanner({ source, folder }: { source: ModSource; folder: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <img
      src={`modmixer-asset://preview/${source}/${encodeURIComponent(folder)}`}
      alt=""
      decoding="async"
      onError={() => setFailed(true)}
      className="aspect-video w-full shrink-0 border-b border-line bg-raised/40 object-cover"
    />
  );
}

export function ModInfoPanel({
  selectedPid,
  mod,
  loadOrder,
  issues,
  allMods,
  onSelectPid,
  onClose,
}: {
  selectedPid: string | null;
  mod: RegistryMod | null;
  /** -1 if not active. */
  loadOrder: number;
  issues: ModIssue[];
  allMods: Map<string, RegistryMod>;
  onSelectPid: (pid: string) => void;
  onClose: () => void;
}) {
  if (!selectedPid) {
    return (
      <aside className="flex w-80 shrink-0 flex-col border-r border-line bg-surface/20">
        <div className="border-b border-line bg-surface/40 px-4 py-2">
          <div className="font-display text-sm font-medium text-ink">Details</div>
          <div className="text-[11px] text-muted">Select a mod to see info</div>
        </div>
        <div className="flex-1 overflow-auto p-6 text-center text-xs text-muted">
          No mod selected.
        </div>
      </aside>
    );
  }

  if (!mod) {
    return (
      <aside className="flex w-80 shrink-0 flex-col border-r border-line bg-surface/20">
        <PanelHeader
          title="Missing mod"
          subtitle="Active in ModsConfig.xml but not on disk"
          onClose={onClose}
        />
        <div className="flex-1 overflow-auto px-4 py-4 space-y-3">
          <div>
            <div className="font-mono text-xs text-ink break-all">
              {selectedPid}
            </div>
            <div className="mt-1 text-[11px] text-muted">
              Either install the mod or remove it from the active list.
            </div>
          </div>
          {loadOrder >= 0 && <Field label="Load order">#{loadOrder + 1}</Field>}
        </div>
      </aside>
    );
  }

  const isCore = mod.about.packageIdLc === CORE_PACKAGE_ID;
  const workshopUrl = mod.publishedFileId
    ? `https://steamcommunity.com/sharedfiles/filedetails/?id=${mod.publishedFileId}`
    : null;

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-line bg-surface/20">
      <PanelHeader
        title={mod.about.name || mod.folder}
        subtitle={mod.about.author || ' '}
        onClose={onClose}
      />
      <div className="flex-1 overflow-auto text-xs">
        <PreviewBanner source={mod.source} folder={mod.folder} />
        <div className="px-4 py-4 space-y-4">
        <div className="flex flex-wrap items-center gap-1.5">
          <SourceBadge source={mod.source} isCore={isCore} />
          {mod.hasDlls && <Badge tone="neutral">DLL</Badge>}
          {loadOrder >= 0 ? (
            <Badge tone="neutral">#{loadOrder + 1} active</Badge>
          ) : (
            <Badge tone="neutral">inactive</Badge>
          )}
          {mod.source === 'workspace' && (
            <Badge tone="neutral">
              {mod.workspaceSynced ? 'synced' : 'not synced'}
            </Badge>
          )}
        </div>

        {mod.about.packageId && (
          <Field label="Package ID">
            <span className="font-mono text-[11px] break-all">
              {mod.about.packageId}
            </span>
          </Field>
        )}

        {mod.about.supportedVersions.length > 0 && (
          <Field label="Supported versions">
            {mod.about.supportedVersions.join(', ')}
          </Field>
        )}

        <Field label="Folder">
          <button
            onClick={() => void window.modmixer.openFolder(mod.path)}
            className="font-mono text-[11px] text-ink hover:underline break-all text-left"
            title="Open in file manager"
          >
            {mod.folder}
          </button>
        </Field>

        {workshopUrl && (
          <Field label="Workshop">
            <button
              onClick={() => void window.modmixer.openExternal(workshopUrl)}
              className="text-ink hover:underline"
            >
              {mod.publishedFileId}
            </button>
          </Field>
        )}

        {mod.about.description && (
          <Field label="Description">
            <p className="whitespace-pre-line text-[11px] text-ink leading-relaxed">
              {mod.about.description}
            </p>
          </Field>
        )}

        {issues.length > 0 && (
          <Field label={`Issues (${issues.length})`}>
            <ul className="space-y-1">
              {issues.map((issue, i) => (
                <li key={i} className="flex items-start gap-1.5">
                  <Badge
                    tone={
                      issue.kind === 'incompatible-mod-active' ? 'error' : 'warn'
                    }
                  >
                    {shortIssue(issue.kind)}
                  </Badge>
                  <span className="text-[11px] text-ink leading-relaxed">
                    {issue.message}
                  </span>
                </li>
              ))}
            </ul>
          </Field>
        )}

        {mod.about.modDependencies.length > 0 && (
          <Field label="Required dependencies">
            <PidList
              pids={mod.about.modDependencies.map((d) => ({
                pid: d.packageIdLc,
                label: d.displayName || d.packageId,
              }))}
              allMods={allMods}
              onSelectPid={onSelectPid}
            />
          </Field>
        )}

        {mod.about.loadAfter.length > 0 && (
          <Field label="Load after">
            <PidList
              pids={mod.about.loadAfter.map((p) => ({ pid: p, label: p }))}
              allMods={allMods}
              onSelectPid={onSelectPid}
            />
          </Field>
        )}

        {mod.about.loadBefore.length > 0 && (
          <Field label="Load before">
            <PidList
              pids={mod.about.loadBefore.map((p) => ({ pid: p, label: p }))}
              allMods={allMods}
              onSelectPid={onSelectPid}
            />
          </Field>
        )}

        {mod.about.incompatibleWith.length > 0 && (
          <Field label="Incompatible with">
            <PidList
              pids={mod.about.incompatibleWith.map((p) => ({ pid: p, label: p }))}
              allMods={allMods}
              onSelectPid={onSelectPid}
            />
          </Field>
        )}
        </div>
      </div>
    </aside>
  );
}

function PanelHeader({
  title,
  subtitle,
  onClose,
}: {
  title: string;
  subtitle: string;
  onClose: () => void;
}) {
  return (
    <div className="flex items-start gap-2 border-b border-line bg-surface/40 px-4 py-2">
      <div className="min-w-0 flex-1">
        <div
          className="truncate font-display text-sm font-medium text-ink"
          title={title}
        >
          {title}
        </div>
        <div className="truncate text-[11px] text-muted" title={subtitle}>
          {subtitle}
        </div>
      </div>
      <button
        onClick={onClose}
        aria-label="Close details"
        title="Close"
        className="shrink-0 rounded-md border border-line px-1.5 text-xs text-muted hover:border-ink/40 hover:text-ink"
      >
        ×
      </button>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 font-mono text-[10px] uppercase tracking-wide text-subtle">
        {label}
      </div>
      <div className="text-[11px] text-ink">{children}</div>
    </div>
  );
}

function PidList({
  pids,
  allMods,
  onSelectPid,
}: {
  pids: { pid: string; label: string }[];
  allMods: Map<string, RegistryMod>;
  onSelectPid: (pid: string) => void;
}) {
  return (
    <ul className="space-y-1">
      {pids.map(({ pid, label }) => {
        const installed = allMods.has(pid);
        return (
          <li key={pid} className="flex items-center gap-1.5">
            {installed ? (
              <button
                onClick={() => onSelectPid(pid)}
                className="text-left text-ink hover:underline truncate"
                title={pid}
              >
                {label}
              </button>
            ) : (
              <span className="text-muted truncate" title={pid}>
                {label}
              </span>
            )}
            {!installed && (
              <Badge tone="warn" title="Not installed on this machine">
                missing
              </Badge>
            )}
          </li>
        );
      })}
    </ul>
  );
}
