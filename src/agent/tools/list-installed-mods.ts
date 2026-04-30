import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { detectRimWorldPaths } from '../paths.js';

const Params = Type.Object({
  scope: Type.Optional(
    Type.Union(
      [
        Type.Literal('all'),
        Type.Literal('local'),
        Type.Literal('workshop'),
      ],
      {
        description:
          'Which mods to include by origin. "local" = user Mods/ (writable, your projects), "workshop" = Steam Workshop subscriptions (read-only), "all" = both. Default "all".',
      },
    ),
  ),
  activeOnly: Type.Optional(
    Type.Boolean({
      description:
        "If true, only return mods that are currently active in RimWorld's mod list (read from ModsConfig.xml), sorted by load order. Default false.",
    }),
  ),
});

interface InstalledMod {
  origin: 'local' | 'workshop';
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
}

export interface ListInstalledModsDetails {
  total: number;
  local: number;
  workshop: number;
  activeMatched: number;
  activeUnmatched: number;
  modsDir: string;
  workshopDir: string | null;
  modsConfig: string | null;
  /** packageIds in ModsConfig.xml that we couldn't locate on disk (typically the built-in DLCs: ludeon.rimworld.royalty, .ideology, .biotech, .anomaly, plus the Core game). */
  unmatchedPackageIds: string[];
  mods: InstalledMod[];
}

const SKIP = new Set(['.git', '.DS_Store', '.vs', 'bin', 'obj', 'node_modules']);

export const listInstalledModsTool: AgentTool<
  typeof Params,
  ListInstalledModsDetails
> = {
  name: 'list_installed_mods',
  label: 'List installed mods',
  description:
    "Survey every RimWorld mod on the machine — local mods (under user Mods/) and Steam Workshop subscriptions — and cross-reference with ModsConfig.xml to mark which ones are active and what their load order is. Returns each mod's About.xml metadata, whether it ships DLLs, its active flag, and 1-based load order. Pass activeOnly=true to limit to the active set in load order — that's the right view for diagnosing the running game. Built-in DLCs (Royalty/Ideology/Biotech/Anomaly/Core) live inside the install and are surfaced under unmatchedPackageIds rather than as full entries.",
  parameters: Params,
  async execute(_id, params): Promise<AgentToolResult<ListInstalledModsDetails>> {
    const scope = params.scope ?? 'all';
    const paths = detectRimWorldPaths();

    const activeOrder = await readActiveMods(paths.modsConfig);
    const orderByPackageId = new Map<string, number>();
    activeOrder.forEach((id, i) => orderByPackageId.set(id, i + 1));

    const mods: InstalledMod[] = [];
    if (scope !== 'workshop' && fs.existsSync(paths.modsDir)) {
      mods.push(
        ...(await readModRoot(paths.modsDir, 'local', orderByPackageId)),
      );
    }
    if (
      scope !== 'local' &&
      paths.workshopDir &&
      fs.existsSync(paths.workshopDir)
    ) {
      mods.push(
        ...(await readModRoot(
          paths.workshopDir,
          'workshop',
          orderByPackageId,
        )),
      );
    }

    const matchedPackageIds = new Set(
      mods
        .filter((m) => m.active && m.packageId)
        .map((m) => m.packageId.toLowerCase()),
    );
    const unmatchedPackageIds = activeOrder.filter(
      (id) => !matchedPackageIds.has(id),
    );

    const filtered = params.activeOnly
      ? mods.filter((m) => m.active)
      : mods;

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
      local: filtered.filter((m) => m.origin === 'local').length,
      workshop: filtered.filter((m) => m.origin === 'workshop').length,
      activeMatched: mods.filter((m) => m.active).length,
      activeUnmatched: unmatchedPackageIds.length,
      modsDir: paths.modsDir,
      workshopDir: paths.workshopDir,
      modsConfig: paths.modsConfig,
      unmatchedPackageIds,
      mods: filtered,
    };

    return {
      content: [{ type: 'text', text: formatSummary(details, params) }],
      details,
    };
  },
};

async function readActiveMods(modsConfig: string | null): Promise<string[]> {
  if (!modsConfig) return [];
  try {
    const xml = await fsp.readFile(modsConfig, 'utf8');
    const wrap = xml.match(/<activeMods>([\s\S]*?)<\/activeMods>/);
    if (!wrap) return [];
    const items: string[] = [];
    const re = /<li>([\s\S]*?)<\/li>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(wrap[1])) !== null) {
      items.push(m[1].trim().toLowerCase());
    }
    return items;
  } catch {
    return [];
  }
}

async function readModRoot(
  root: string,
  origin: 'local' | 'workshop',
  orderByPackageId: Map<string, number>,
): Promise<InstalledMod[]> {
  const entries = await fsp.readdir(root, { withFileTypes: true });
  const result: InstalledMod[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP.has(entry.name)) continue;
    const modPath = path.join(root, entry.name);
    const aboutPath = path.join(modPath, 'About', 'About.xml');

    let about = {
      name: entry.name,
      packageId: '',
      description: '',
      author: '',
      supportedVersions: [] as string[],
    };
    if (fs.existsSync(aboutPath)) {
      try {
        const xml = await fsp.readFile(aboutPath, 'utf8');
        about = {
          name: extractTag(xml, 'name') || entry.name,
          packageId: extractTag(xml, 'packageId'),
          description: trunc(extractTag(xml, 'description'), 280),
          author: extractTag(xml, 'author'),
          supportedVersions: extractList(xml, 'supportedVersions'),
        };
      } catch {
        // ignore parse failures, keep folder name as fallback
      }
    }

    let hasDlls = false;
    const assembliesPath = path.join(modPath, 'Assemblies');
    if (fs.existsSync(assembliesPath)) {
      try {
        const files = await fsp.readdir(assembliesPath);
        hasDlls = files.some((f) => f.toLowerCase().endsWith('.dll'));
      } catch {
        // ignore
      }
    }

    const loadOrder = about.packageId
      ? (orderByPackageId.get(about.packageId.toLowerCase()) ?? null)
      : null;

    result.push({
      origin,
      folder: entry.name,
      path: modPath,
      ...about,
      hasDlls,
      active: loadOrder !== null,
      loadOrder,
    });
  }
  return result;
}

function formatSummary(
  d: ListInstalledModsDetails,
  params: { scope?: string; activeOnly?: boolean },
): string {
  const lines: string[] = [];
  const scopeLabel = params.scope ?? 'all';
  const filterLabel = params.activeOnly ? 'active only' : 'all';
  lines.push(
    `# ${d.total} mod${d.total === 1 ? '' : 's'} (${d.local} local, ${d.workshop} workshop) — scope=${scopeLabel}, filter=${filterLabel}`,
  );
  if (d.modsConfig) {
    lines.push(
      `# ModsConfig.xml: ${d.activeMatched} active matched on disk, ${d.activeUnmatched} active without a matching folder (likely RimWorld DLCs/Core)`,
    );
    if (d.unmatchedPackageIds.length > 0) {
      lines.push(`# Unmatched: ${d.unmatchedPackageIds.join(', ')}`);
    }
  } else {
    lines.push(
      `# ModsConfig.xml not found — active flags and load order unavailable.`,
    );
  }
  lines.push(`# Local: ${d.modsDir}`);
  if (d.workshopDir) lines.push(`# Workshop: ${d.workshopDir}`);
  lines.push(
    '# legend: [local|ws] [✓=active, ·=inactive] [◼=has dll, ·=no dll] #LO Name packageId v=versions',
  );
  lines.push('');
  for (const m of d.mods) {
    const tag = m.origin === 'local' ? '[local]' : '[ws]   ';
    const active = m.active ? '✓' : '·';
    const dll = m.hasDlls ? '◼' : '·';
    const lo = m.loadOrder !== null ? `#${String(m.loadOrder).padStart(3, ' ')}` : '#   ';
    const versions = m.supportedVersions.length
      ? ` v=${m.supportedVersions.join(',')}`
      : '';
    const id = m.packageId ? ` ${m.packageId}` : '';
    lines.push(`${tag} ${active} ${dll} ${lo} ${m.name}${id}${versions}`);
    lines.push(`              ${m.path}`);
  }
  return lines.join('\n');
}

function trunc(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 3) + '...';
}

function extractTag(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return (m?.[1] ?? '').trim();
}

function extractList(xml: string, parentTag: string): string[] {
  const wrap = xml.match(
    new RegExp(`<${parentTag}>([\\s\\S]*?)</${parentTag}>`),
  );
  if (!wrap) return [];
  const items: string[] = [];
  const re = /<li>([\s\S]*?)<\/li>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(wrap[1])) !== null) {
    items.push(match[1].trim());
  }
  return items;
}
