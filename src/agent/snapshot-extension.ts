import {
  createSyntheticSourceInfo,
  type AgentEndEvent,
  type Extension,
  type ExtensionContext,
} from '@mariozechner/pi-coding-agent';
import { commitTurn } from './snapshots.js';

/**
 * Pi extension that auto-saves the mod folder once each agent loop ends.
 *
 * agent_end fires after the agent stops calling tools and emits its final
 * response — i.e. once per "the AI did its thing and the user has the
 * controls back." Per-turn (per-tool) snapshots would be noisier without
 * adding meaningful checkpoints; per-loop matches the gamer mental model.
 *
 * The leaf entry id at that moment is recorded with the save so a later
 * Restore can rewind chat to the same point. If the conversation is later
 * deleted, the file restore still works — the chat-rewind is best-effort.
 *
 * Returns null for chats with no associated mod folder ("new" scope before
 * scaffold_mod runs). The host re-builds this extension after scope upgrade,
 * so the first agent_end after scaffolding lands the initial save.
 */
export function buildSnapshotExtension(args: {
  folder: string | null;
  conversationId: string;
}): Extension | null {
  if (!args.folder) return null;
  const folder = args.folder;
  const conversationId = args.conversationId;

  const path = '<modmixer:snapshot>';
  const handler = async (
    _event: AgentEndEvent,
    ctx: ExtensionContext,
  ): Promise<void> => {
    const leaf = ctx.sessionManager.getLeafEntry();
    try {
      await commitTurn(folder, {
        kind: 'auto',
        conversationId,
        entryId: leaf?.id ?? null,
      });
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
