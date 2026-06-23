/**
 * RimWorld setup status for Settings → Games. Wraps the existing RimWorld index
 * snapshot (install detection + def/C# index) into the uniform GameSetupStatus
 * the generic per-game card renders. This is the content that used to live in
 * the privileged top-level "RimWorld index" settings tab.
 */
import { getIndexSnapshot, startRebuild } from '../index/main-bridge.js';
import { formatBytes } from '../index/format.js';
import type { IndexMeta } from '../index/meta.js';
import type { GameSetupAdapter } from '../adapters/types.js';
import type { GameSetupFact, GameSetupStatus } from '../games/types.js';

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

export const rimworldSetup: GameSetupAdapter = {
  async getStatus() {
    return buildStatus();
  },
  async rebuild(opts) {
    // startRebuild fires in the background (progress streams to the index
    // modal) and no-ops if already building; we return the now-building status.
    await startRebuild({ force: opts?.force ?? true });
    return buildStatus();
  },
};
