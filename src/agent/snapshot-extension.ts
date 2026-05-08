import {
  createSyntheticSourceInfo,
  type AgentEndEvent,
  type Extension,
  type ExtensionContext,
} from '@mariozechner/pi-coding-agent';
import { commitTurn } from './snapshots.js';

/**
 * Pi extension that auto-saves the mod's full state once each agent loop
 * ends. The save captures both the mod folder AND the chat slice (every
 * conversation scoped to this mod plus which one is active), so a later
 * Restore winds the entire world back, not just the files.
 *
 * agent_end fires after the agent stops calling tools and emits its final
 * response — once per "the AI did its thing and the user has the controls
 * back." Per-tool snapshots would be noisier without adding meaningful
 * checkpoints; per-loop matches the gamer mental model.
 *
 * Returns null for chats with no associated mod folder ("new" scope before
 * scaffold_mod runs). The host re-builds this extension after scope
 * upgrade, so the first agent_end after scaffolding lands the initial save.
 */
export function buildSnapshotExtension(args: {
  folder: string | null;
}): Extension | null {
  if (!args.folder) return null;
  const folder = args.folder;

  const path = '<modmixer:snapshot>';
  const handler = async (
    _event: AgentEndEvent,
    _ctx: ExtensionContext,
  ): Promise<void> => {
    try {
      await commitTurn(folder, { kind: 'auto' });
    } catch (err) {
      // Snapshots are an aside to the chat — don't let a git failure
      // surface as a turn error.
      console.error('[snapshots] auto-save failed:', err);
    }
  };

  return {
    path,
    resolvedPath: path,
    sourceInfo: createSyntheticSourceInfo(path, {
      source: 'modmixer',
      scope: 'temporary',
      origin: 'top-level',
    }),
    handlers: new Map([['agent_end', [handler as never]]]),
    tools: new Map(),
    messageRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
  };
}
