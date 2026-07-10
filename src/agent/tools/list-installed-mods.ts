import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { detectRimWorldPaths } from '../paths.js';
import {
  getRegistry,
  analyzeSnapshot,
  type ModIssue,
  type RegistryMod,
} from '../registry/index.js';

const Params = Type.Object({
  scope: Type.Optional(
    Type.Union(
      [
        Type.Literal('all'),
        Type.Literal('local'),
        Type.Literal('workshop'),
        Type.Literal('official'),
        Type.Literal('workspace'),
      ],
      {
        description:
          'Which mods to include by source. "local" = user Mods/, "workshop" = Steam subscriptions, "official" = Core/DLCs, "workspace" = modmixer-managed mods, "all" = everything. Default "all".',
      },
    ),
  ),
  activeOnly: Type.Optional(
    Type.Boolean({
      description:
        "If true, only return mods that are currently active in RimWorld's mod list (read from ModsConfig.xml), sorted by load order. Default false.",
    }),
  ),
  includeIssues: Type.Optional(
    Type.Boolean({
      description:
        'If true, attach derived issue flags (missing-dependency, incompatible-mod-active, load-order-violation, version-incompat) to each mod entry. Default true.',
    }),
  ),
  query: Type.Optional(
    Type.String({
      description:
        'Case-insensitive substring filter — only return mods whose name, packageId, or folder contains every whitespace-separated token in this string. Use this when you just want to locate a specific mod; a full list is ~50 KB and almost never the right tool for that. Multi-word queries AND-match per token so "Priority Master" finds "PriorityMaster" and "vanilla expanded fishing" finds "VanillaFishingExpanded". Combines with scope/activeOnly.',
    }),
  ),
});

interface InstalledMod {
  source: 'official' | 'local' | 'workshop' | 'workspace';
  folder: string;
  path: string;
  name: string;
  packageId: string;
  author: string;
  description: string;
  supportedVersions: string[];
  hasDlls: boolean;
  active: boolean;
  /** 1-based load order if active, null otherwise. */
  loadOrder: number | null;
  /** Hard deps from About.xml. */
  modDependencies: { packageId: string; displayName: string }[];
  loadAfter: string[];
  loadBefore: string[];
  incompatibleWith: string[];
  /** Empty when includeIssues=false. */
  issues: ModIssue[];
}

export interface ListInstalledModsDetails {
  total: number;
  official: number;
  local: number;
  workshop: number;
  workspace: number;
  activeMatched: number;
  activeUnmatched: number;
  modsDir: string;
  workshopDir: string | null;
  modsConfig: string | null;
  /** packageIds in ModsConfig.xml that we couldn't locate on disk. */
  unmatchedPackageIds: string[];
  gameVersion: string;
  gameVersionMajorMinor: string | null;
  mods: InstalledMod[];
}

export const listInstalledModsTool: AgentTool<
  typeof Params,
  ListInstalledModsDetails
> = {
  name: 'list_installed_mods',
  label: 'List installed mods',
  description:
    "Survey every RimWorld mod on the machine — official Core/DLCs, local mods, Steam Workshop subscriptions, and modmixer workspace mods — cross-referenced with ModsConfig.xml to mark active state, load order, and the registry's derived issue flags (missing dependency, incompatible mod active, load-order violation, version-incompat). Pass activeOnly=true to limit to the running modlist in load order — that's the right view for diagnosing the running game. To locate one specific mod, pass `query` (substring match against name/packageId/folder) — the unfiltered list is ~50 KB. The mod registry is the single source of truth; this tool reads its current snapshot.",
  parameters: Params,
  async execute(_id, params): Promise<AgentToolResult<ListInstalledModsDetails>> {
    const scope = params.scope ?? 'all';
    const includeIssues = params.includeIssues ?? true;
    const paths = detectRimWorldPaths();
    const registry = getRegistry();
    await registry.start();
    await registry.refresh();
    const snapshot = registry.getSnapshot();
    const analysis = includeIssues ? analyzeSnapshot(snapshot) : null;

    const orderByPackageId = new Map<string, number>();
    snapshot.activeOrder.forEach((id, i) => orderByPackageId.set(id, i + 1));

    const allMods: InstalledMod[] = snapshot.mods.map((m) =>
      buildEntry(m, orderByPackageId, analysis),
    );

    // AND-match across whitespace-separated tokens so "Priority Master"
    // matches "PriorityMaster" — the user's natural phrasing usually has
    // spaces that the actual packageId/name doesn't.
    const queryTokens = params.query
      ?.toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 0);
    const filtered = allMods.filter((m) => {
      if (scope !== 'all' && m.source !== scope) return false;
      if (params.activeOnly && !m.active) return false;
      if (queryTokens && queryTokens.length > 0) {
        const haystack = `${m.name}\n${m.packageId}\n${m.folder}`.toLowerCase();
        for (const tok of queryTokens) {
          if (!haystack.includes(tok)) return false;
        }
      }
      return true;
    });

    if (params.activeOnly) {
      filtered.sort((a, b) => (a.loadOrder ?? 0) - (b.loadOrder ?? 0));
    } else {
      filtered.sort((a, b) => {
        if (a.active !== b.active) return a.active ? -1 : 1;
        if (a.active && b.active)
          return (a.loadOrder ?? 0) - (b.loadOrder ?? 0);
        return a.name.localeCompare(b.name);
      });
    }

    const details: ListInstalledModsDetails = {
      total: filtered.length,
      official: filtered.filter((m) => m.source === 'official').length,
      local: filtered.filter((m) => m.source === 'local').length,
      workshop: filtered.filter((m) => m.source === 'workshop').length,
      workspace: filtered.filter((m) => m.source === 'workspace').length,
      activeMatched: snapshot.active.filter((a) => a.mod).length,
      activeUnmatched: snapshot.missingActive.length,
      modsDir: paths.modsDir,
      workshopDir: paths.workshopDir,
      modsConfig: paths.modsConfig,
      unmatchedPackageIds: snapshot.missingActive,
      gameVersion: snapshot.gameVersion,
      gameVersionMajorMinor: snapshot.gameVersionMajorMinor,
      mods: filtered,
    };

    return {
      content: [{ type: 'text', text: formatSummary(details, params) }],
      details,
    };
  },
};

function buildEntry(
  m: RegistryMod,
  orderByPackageId: Map<string, number>,
  analysis: { byPackageId: Map<string, ModIssue[]> } | null,
): InstalledMod {
  const lc = m.about.packageIdLc;
  const loadOrder = lc ? (orderByPackageId.get(lc) ?? null) : null;
  return {
    source: m.source,
    folder: m.folder,
    path: m.path,
    name: m.about.name || m.folder,
    packageId: m.about.packageId,
    author: m.about.author,
    description: trunc(m.about.description, 280),
    supportedVersions: m.about.supportedVersions,
    hasDlls: m.hasDlls,
    active: loadOrder !== null,
    loadOrder,
    modDependencies: m.about.modDependencies.map((d) => ({
      packageId: d.packageId,
      displayName: d.displayName,
    })),
    loadAfter: m.about.loadAfter,
    loadBefore: m.about.loadBefore,
    incompatibleWith: m.about.incompatibleWith,
    issues: analysis ? (analysis.byPackageId.get(lc) ?? []) : [],
  };
}

function formatSummary(
  d: ListInstalledModsDetails,
  params: { scope?: string; activeOnly?: boolean; query?: string },
): string {
  const lines: string[] = [];
  const scopeLabel = params.scope ?? 'all';
  const filterLabel = params.activeOnly ? 'active only' : 'all';
  const queryLabel = params.query ? `, query=${JSON.stringify(params.query)}` : '';
  lines.push(
    `# ${d.total} mod${d.total === 1 ? '' : 's'} (${d.official} official, ${d.local} local, ${d.workshop} workshop, ${d.workspace} workspace) — scope=${scopeLabel}, filter=${filterLabel}${queryLabel}`,
  );
  if (d.modsConfig) {
    lines.push(
      `# ModsConfig.xml: ${d.activeMatched} active matched on disk, ${d.activeUnmatched} active without a matching folder${d.gameVersionMajorMinor ? `, game version ${d.gameVersionMajorMinor}` : ''}`,
    );
    if (d.unmatchedPackageIds.length > 0) {
      lines.push(`# Unmatched: ${d.unmatchedPackageIds.join(', ')}`);
    }
  } else {
    lines.push(
      `# ModsConfig.xml not found — active flags and load order unavailable.`,
    );
  }
  lines.push(`# Mods/: ${d.modsDir}`);
  if (d.workshopDir) lines.push(`# Workshop: ${d.workshopDir}`);
  lines.push(
    '# legend: [src] [✓=active, ·=inactive] [◼=has dll, ·=no dll] #LO Name packageId v=versions  ⚠=issues',
  );
  lines.push('');
  for (const m of d.mods) {
    const tag = sourceTag(m.source);
    const active = m.active ? '✓' : '·';
    const dll = m.hasDlls ? '◼' : '·';
    const lo = m.loadOrder !== null ? `#${String(m.loadOrder).padStart(3, ' ')}` : '#   ';
    const versions = m.supportedVersions.length
      ? ` v=${m.supportedVersions.join(',')}`
      : '';
    const id = m.packageId ? ` ${m.packageId}` : '';
    const flag = m.issues.length > 0 ? ` ⚠${m.issues.length}` : '';
    lines.push(`${tag} ${active} ${dll} ${lo} ${m.name}${id}${versions}${flag}`);
    lines.push(`              · path: ${m.path}`);
    if (m.issues.length > 0) {
      for (const issue of m.issues) {
        lines.push(`              · ${issue.kind}: ${issue.message}`);
      }
    }
  }
  return lines.join('\n');
}

function sourceTag(source: InstalledMod['source']): string {
  switch (source) {
    case 'official':
      return '[off]  ';
    case 'local':
      return '[local]';
    case 'workshop':
      return '[ws]   ';
    case 'workspace':
      return '[work] ';
  }
}

function trunc(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 3) + '...';
}
