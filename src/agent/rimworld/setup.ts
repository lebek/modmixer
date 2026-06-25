/**
 * RimWorld setup status for Settings → Games. Wraps the existing RimWorld index
 * snapshot (install detection + def/C# index) into the uniform GameSetupStatus
 * the generic per-game card renders. This is the content that used to live in
 * the privileged top-level "RimWorld index" settings tab.
 */
import { getIndexSnapshot, startRebuild } from '../index/main-bridge.js';
import { formatBytes } from '../index/format.js';
import { detectEnv } from '../env-detect.js';
import { findExistingDotnet } from '../dotnet-provision.js';
import { summarizeRequirements } from '../games/types.js';
import type { IndexMeta } from '../index/meta.js';
import type { GameSetupAdapter } from '../adapters/types.js';
import type {
  GameSetupFact,
  GameSetupStatus,
  SetupRequirement,
  SetupRequirements,
} from '../games/types.js';

const DETAIL =
  "The RimWorld index powers the agent's def lookups and C# source search. " +
  "It's built from your local install and rebuilt automatically when RimWorld updates.";

function factsFromMeta(meta: IndexMeta): GameSetupFact[] {
  return [
    { label: 'RimWorld', value: meta.rimworldVersion },
    {
      label: 'DLC packs',
      value: meta.dlcs.length > 0 ? meta.dlcs.join(', ') : '(none)',
    },
    { label: 'Defs', value: meta.defCount.toLocaleString() },
    { label: 'C# symbols', value: meta.symbolCount.toLocaleString() },
    { label: 'Source size', value: formatBytes(meta.sourceBytes) },
    { label: 'Built', value: new Date(meta.builtAt).toLocaleString() },
  ];
}

function buildStatus(): GameSetupStatus {
  const snap = getIndexSnapshot();
  const status = snap.status;
  const building = snap.rebuilding || status.type === 'building';

  if (building) {
    return {
      state: 'building',
      headline: 'Building the index (~30–90s on first run)…',
      detail: DETAIL,
      facts: [],
      canRebuild: false,
      rebuildLabel: 'Building…',
    };
  }
  if (status.type === 'no-rimworld') {
    return {
      state: 'blocked',
      headline: "RimWorld install not detected — the index can't be built.",
      blockedReason:
        'Install RimWorld via Steam (or point Modmixer at the install folder during onboarding), then reopen this page.',
      detail: DETAIL,
      facts: [],
      canRebuild: false,
      rebuildLabel: 'Rebuild',
    };
  }
  if (status.type === 'absent') {
    return {
      state: 'absent',
      headline: 'No index yet — build it to enable def lookups and C# search.',
      detail: DETAIL,
      facts: [],
      canRebuild: true,
      rebuildLabel: 'Build index',
    };
  }
  if (status.type === 'stale') {
    return {
      state: 'stale',
      headline: `Index is out of date — ${status.reason}. Rebuild to refresh.`,
      detail: DETAIL,
      facts: factsFromMeta(status.meta),
      canRebuild: true,
      rebuildLabel: 'Rebuild',
    };
  }
  return {
    state: 'fresh',
    headline: 'Index ready.',
    detail: DETAIL,
    facts: factsFromMeta(status.meta),
    canRebuild: true,
    rebuildLabel: 'Rebuild',
  };
}

/**
 * Map the aggregate env snapshot onto the uniform requirement rows. Install +
 * writable Mods folder are `required` (the index can't build without them);
 * config files + toolchain are `recommended` — they self-heal (ModsConfig
 * appears on first launch) or only bite at C# build time (.NET / ilspycmd, the
 * latter vendored in prod). Both tiers gate the pre-chat overlay; onboarding
 * lets the recommended ones be deferred.
 */
async function checkRequirements(): Promise<SetupRequirements> {
  const env = await detectEnv();
  const dotnet = await findExistingDotnet();
  const items: SetupRequirement[] = [
    {
      id: 'install',
      label:
        env.rimworld.ok && env.rimworld.version
          ? `RimWorld ${env.rimworld.version}`
          : 'RimWorld install',
      severity: 'required',
      ok: env.rimworld.ok,
      detail: env.rimworld.ok ? null : env.rimworld.detail,
      hint: env.rimworld.path,
      action: {
        kind: 'browse-install',
        label: env.rimworld.ok ? 'Change…' : 'Browse…',
      },
    },
    {
      id: 'mods-writable',
      label: 'Mods folder writable',
      severity: 'required',
      ok: env.modsDirWritable.ok,
      detail: env.modsDirWritable.ok ? null : env.modsDirWritable.detail,
      hint: env.modsDirWritable.path,
    },
    {
      id: 'mods-config',
      label: 'ModsConfig.xml',
      severity: 'recommended',
      ok: env.modsConfig.ok,
      detail: env.modsConfig.ok ? null : env.modsConfig.detail,
      hint: env.modsConfig.path,
      action: env.modsConfig.ok
        ? null
        : { kind: 'launch-game', label: 'Launch RimWorld' },
    },
    {
      id: 'dotnet',
      label: '.NET SDK',
      severity: 'recommended',
      provisioning: 'auto',
      ok: dotnet !== null,
      detail: dotnet
        ? null
        : 'Set up automatically the first time you build a C# mod — no manual install needed.',
      hint: dotnet
        ? `${dotnet.provisioned ? 'Provisioned by ModMixer' : 'Found on system'} · ${dotnet.version}`
        : null,
    },
    {
      // ilspycmd is load-bearing for the index itself (decompile → C# symbols),
      // so it's `required`, not advisory. Shipped vendored in production builds;
      // a dev build without it must install it before the index can build.
      id: 'ilspycmd',
      label: 'ilspycmd (decompiler)',
      severity: 'required',
      ok: env.ilspycmd.ok,
      detail: env.ilspycmd.ok ? null : env.ilspycmd.detail,
      hint: env.ilspycmd.path,
    },
  ];
  return summarizeRequirements(items);
}

export const rimworldSetup: GameSetupAdapter = {
  async getStatus() {
    return buildStatus();
  },
  checkRequirements,
  async rebuild(opts) {
    // startRebuild fires in the background (progress streams to the index
    // modal) and no-ops if already building; we return the now-building status.
    await startRebuild({ force: opts?.force ?? true });
    return buildStatus();
  },
};
