import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import {
  listInstalledMinecraftMods,
  type InstalledMinecraftMod,
} from '../minecraft/mods-registry.js';

const Params = Type.Object({
  query: Type.Optional(
    Type.String({
      description:
        'Substring filter (AND-matched across whitespace-separated tokens) against modId and display name. A modpack can have hundreds of mods; pass this to find the one you care about — the unfiltered list can be large.',
    }),
  ),
  instance: Type.Optional(
    Type.String({
      description:
        'Limit to one launcher instance by substring match on its name (e.g. "1.21.1 NeoForge") or launcher ("modrinth"/"prism"/"curseforge"/"vanilla").',
    }),
  ),
  enabledOnly: Type.Optional(
    Type.Boolean({
      description:
        'If true, omit launcher-disabled mods (the *.jar.disabled files). Defaults to false (lists both, marking disabled ones).',
    }),
  ),
});
type ParamsT = typeof Params;

export interface McListInstalledModsDetails {
  total: number;
  shown: number;
  instances: number;
  mods: InstalledMinecraftMod[];
}

function tokens(q: string | undefined): string[] {
  return (q ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

function matches(m: InstalledMinecraftMod, queryToks: string[]): boolean {
  if (queryToks.length === 0) return true;
  const hay = `${m.modId}\n${m.displayName}`.toLowerCase();
  return queryToks.every((t) => hay.includes(t));
}

function instanceMatches(m: InstalledMinecraftMod, q: string | undefined): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return (
    m.instance.name.toLowerCase().includes(needle) ||
    m.instance.launcher.toLowerCase().includes(needle)
  );
}

function depLine(m: InstalledMinecraftMod): string {
  const reqs = m.dependencies.filter((d) => d.type === 'required');
  if (reqs.length === 0) return 'requires: (none declared)';
  return (
    'requires: ' +
    reqs
      .map((d) => (d.versionRange ? `${d.modId} ${d.versionRange}` : d.modId))
      .join(', ')
  );
}

function formatSummary(
  shown: InstalledMinecraftMod[],
  total: number,
  instanceCount: number,
): string {
  if (shown.length === 0) {
    return total === 0
      ? 'No installed Minecraft mods found. Checked every detected launcher instance (Modrinth/Prism/CurseForge/vanilla); none had jars in its mods/ folder.'
      : `No installed mods matched the filter (of ${total} total). Loosen the query.`;
  }
  const disabledCount = shown.filter((m) => !m.enabled).length;
  const lines = shown.map((m) => {
    const flag = m.enabled ? '' : ' (disabled)';
    const loader = m.loader === 'unknown' ? '?' : m.loader;
    return `${m.modId}  ${m.version}  [${loader}]  ${m.instance.launcher}/${m.instance.name}  — ${m.displayName}${flag}`;
  });
  const head = `${total} installed Minecraft mod(s) across ${instanceCount} instance(s); showing ${shown.length}${
    disabledCount ? ` (${disabledCount} disabled)` : ''
  }.`;
  // When the filter narrows to a handful, surface description + required deps
  // so the agent can reason without a separate inspect_mod round-trip.
  const detail =
    shown.length <= 5
      ? '\n\n' +
        shown
          .map((m) => {
            const desc = m.description ? `\n  ${m.description.split('\n')[0]}` : '';
            return `• ${m.displayName} (${m.modId})${desc}\n  ${depLine(m)}`;
          })
          .join('\n')
      : '';
  return `${head}\n\n${lines.join('\n')}${detail}\n\nInspect one with inspect_mod(modId:"<id>") to decompile + read its sources.`;
}

export const mcListInstalledModsTool: AgentTool<ParamsT, McListInstalledModsDetails> = {
  name: 'list_installed_mods',
  label: 'List installed mods',
  description:
    "Survey the third-party Minecraft mods installed in the user's launchers (Modrinth App, Prism, CurseForge, vanilla .minecraft) by reading each jar's manifest (neoforge.mods.toml / mods.toml / fabric.mod.json). Returns mod id, name, version, loader, dependencies, and enabled state per instance. Use this to find an installed mod the user mentions, then call inspect_mod to decompile and read its code. A modpack can have hundreds of mods — pass `query` to narrow. This surveys INSTALLED mods, not vanilla content (use search_defs/search_source for vanilla).",
  parameters: Params,
  async execute(_id, params): Promise<AgentToolResult<McListInstalledModsDetails>> {
    const all = await listInstalledMinecraftMods();
    const instanceCount = new Set(
      all.map((m) => `${m.instance.launcher}/${m.instance.name}`),
    ).size;
    const queryToks = tokens(params.query);
    const shown = all
      .filter((m) => (params.enabledOnly ? m.enabled : true))
      .filter((m) => instanceMatches(m, params.instance))
      .filter((m) => matches(m, queryToks))
      .sort((a, b) => {
        if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
        return a.displayName.localeCompare(b.displayName);
      });

    const details: McListInstalledModsDetails = {
      total: all.length,
      shown: shown.length,
      instances: instanceCount,
      mods: shown,
    };
    return {
      content: [{ type: 'text', text: formatSummary(shown, all.length, instanceCount) }],
      details,
    };
  },
};
