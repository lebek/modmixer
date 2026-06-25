/**
 * Minecraft setup status for Settings → Games. Wraps the Minecraft source-index
 * state (which auto-provisions Java 21 + the Gradle toolchain on first build)
 * into the uniform GameSetupStatus, symmetric with RimWorld's.
 */
import {
  getMinecraftIndexStatus,
  getMinecraftIndexMeta,
  rebuildMinecraftIndex,
} from '../index/rebuild-minecraft.js';
import { emitSetupProgress } from '../index/setup-progress.js';
import { formatBytes } from '../index/format.js';
import { MINECRAFT_VERSION, NEOFORGE_VERSION, REQUIRED_JDK_MAJOR } from './versions.js';
import { findExistingJdk21 } from './jdk.js';
import { summarizeRequirements } from '../games/types.js';
import type { GameSetupAdapter } from '../adapters/types.js';
import type {
  GameSetupFact,
  GameSetupStatus,
  SetupRequirements,
} from '../games/types.js';

const DETAIL =
  'Modmixer auto-provisions Java 21 + the Gradle toolchain. Setup builds the ' +
  'Minecraft/NeoForge source index — a one-time decompile that can take a few minutes.';

function facts(): GameSetupFact[] {
  const out: GameSetupFact[] = [
    { label: 'Minecraft', value: MINECRAFT_VERSION },
    { label: 'NeoForge', value: NEOFORGE_VERSION },
  ];
  const meta = getMinecraftIndexMeta();
  if (meta) {
    out.push(
      { label: 'Java symbols', value: meta.symbolCount.toLocaleString() },
      { label: 'Data defs', value: meta.defCount.toLocaleString() },
      { label: 'Source size', value: formatBytes(meta.sourceBytes) },
      { label: 'Built', value: new Date(meta.builtAt).toLocaleString() },
    );
  }
  return out;
}

function buildStatus(): GameSetupStatus {
  switch (getMinecraftIndexStatus()) {
    case 'building':
      return {
        state: 'building',
        headline: 'Setting up the toolchain + source index (one-time decompile)…',
        detail: DETAIL,
        facts: [],
        canRebuild: false,
        rebuildLabel: 'Setting up…',
      };
    case 'absent':
      return {
        state: 'absent',
        headline: 'Not set up yet — provisions Java 21 and builds the source index.',
        detail: DETAIL,
        facts: facts(),
        canRebuild: true,
        rebuildLabel: 'Set up Minecraft',
      };
    case 'stale':
      return {
        state: 'stale',
        headline: 'Update available — the pinned toolchain changed. Rebuild to refresh.',
        detail: DETAIL,
        facts: facts(),
        canRebuild: true,
        rebuildLabel: 'Rebuild index',
      };
    default:
      return {
        state: 'fresh',
        headline: 'Index ready.',
        detail: DETAIL,
        facts: facts(),
        canRebuild: true,
        rebuildLabel: 'Rebuild index',
      };
  }
}

export const minecraftSetup: GameSetupAdapter = {
  async getStatus() {
    return buildStatus();
  },
  // The one host prerequisite is JDK 21, which ModMixer auto-provisions at the
  // first index build (Gradle + NeoForge/MC artifacts come from the build).
  // Surface it as an informational `auto` row — found-on-system vs will-install —
  // so the toolchain isn't invisible; it never blocks (the build provisions it).
  async checkRequirements(): Promise<SetupRequirements> {
    const jdk = await findExistingJdk21();
    return summarizeRequirements([
      {
        id: 'jdk',
        label: `Java ${REQUIRED_JDK_MAJOR} (JDK)`,
        severity: 'required',
        provisioning: 'auto',
        ok: jdk !== null,
        detail: jdk
          ? null
          : 'Installed automatically during setup — no manual install needed.',
        hint: jdk
          ? `${jdk.provisioned ? 'Provisioned by ModMixer' : 'Found on system'} · ${jdk.version}`
          : null,
      },
    ]);
  },
  async rebuild() {
    // Force a rebuild even when fresh (matches RimWorld's manual Rebuild), but
    // never start a second concurrent build. Progress is tagged onto the
    // unified game-setup channel so the onboarding step + pre-chat gate render
    // granular per-phase progress (the Settings card also polls getStatus()).
    if (getMinecraftIndexStatus() !== 'building') {
      void rebuildMinecraftIndex((e) => emitSetupProgress('minecraft', e)).catch(
        (err) => {
          console.error('[minecraft setup] rebuild failed:', err);
        },
      );
    }
    return buildStatus();
  },
};
