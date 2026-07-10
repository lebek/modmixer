import {
  createSyntheticSourceInfo,
  type AgentEndEvent,
  type Extension,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { messageText } from '../lib/agent-utils.js';
import { commitTurn } from './snapshots.js';

const PREVIEW_MAX_CHARS = 140;

/**
 * Walk the turn's messages from the tail to find the last assistant
 * message that produced visible text. Tool-only turns (no text) return
 * null, and the saves UI falls back to the file-change summary.
 */
function extractPreview(messages: AgentEndEvent['messages']): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    const text = messageText(m).trim();
    if (!text) return null;
    const collapsed = text.replace(/\s+/g, ' ');
    if (collapsed.length <= PREVIEW_MAX_CHARS) return collapsed;
    return collapsed.slice(0, PREVIEW_MAX_CHARS - 1).trimEnd() + '…';
  }
  return null;
}

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
 * Returns null only when there's no associated mod folder — a defensive case,
 * since every session is bound to a mod before it's constructed (see
 * bindNewScopeToMod), so the extension always has a folder to snapshot.
 */
export function buildSnapshotExtension(args: {
  folder: string | null;
}): Extension | null {
  if (!args.folder) return null;
  const folder = args.folder;

  const path = '<modmixer:snapshot>';
  const handler = async (
    event: AgentEndEvent,
    _ctx: ExtensionContext,
  ): Promise<void> => {
    const preview = extractPreview(event.messages) ?? undefined;
    try {
      await commitTurn(folder, { kind: 'auto', preview });
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
