import type { ThinkingLevel } from '@mariozechner/pi-agent-core';
import {
  clearActiveForMod,
  getActiveForMod,
  listConversations,
  setActiveForMod,
  type ConversationScope,
} from '../../agent/conversations.js';
import type { ModelSelection } from '../../agent/settings.js';
import type { RouteContext } from './context.js';

/**
 * Agent send/interrupt/close + conversation index. send/create/open all gate
 * on `requireConsent` because they would otherwise let the agent run before
 * the user has accepted the consent screen.
 *
 * Every agent channel is keyed by `conversationId` — one open conversation
 * per mod tab, each with its own independently-running session.
 */
export function registerConversationRoutes(ctx: RouteContext): void {
  const { ipc, host, requireConsent } = ctx;

  ipc.handle(
    'modmixer:agent:send',
    async (_evt, conversationId: string, text: string) => {
      requireConsent();
      await host.send(conversationId, text);
    },
  );

  ipc.handle(
    'modmixer:agent:interrupt',
    async (_evt, conversationId: string) => {
      await host.interrupt(conversationId);
    },
  );

  ipc.handle('modmixer:agent:close', async (_evt, conversationId: string) => {
    await host.closeSession(conversationId);
  });

  ipc.handle(
    'modmixer:agent:get-context-usage',
    (_evt, conversationId: string) => host.getContextUsage(conversationId),
  );

  ipc.handle('modmixer:conversations:list', () => listConversations());

  ipc.handle(
    'modmixer:conversations:create',
    (_evt, scope: ConversationScope, title?: string) => {
      requireConsent();
      return host.createConversation(scope, title);
    },
  );

  ipc.handle('modmixer:conversations:delete', async (_evt, id: string) => {
    await host.deleteConversation(id);
  });

  // Per-chat model + reasoning effort. Persisted on the Conversation and
  // applied to the live session; other open chats are unaffected.
  ipc.handle(
    'modmixer:conversations:set-model',
    async (_evt, conversationId: string, selection: ModelSelection) => {
      await host.setConversationModel(conversationId, selection);
    },
  );

  ipc.handle(
    'modmixer:conversations:set-thinking-level',
    (_evt, conversationId: string, level: ThinkingLevel) => {
      host.setConversationThinkingLevel(conversationId, level);
    },
  );

  /**
   * Resolve the "active chat" for a mod to a Conversation — get-or-create in
   * the index only, NO session construction. This is the fast half of opening
   * a mod: the renderer shows the workspace immediately off this, then opens
   * the session in the background via `open-session`.
   */
  ipc.handle(
    'modmixer:conversations:resolve-for-mod',
    async (_evt, folder: string) => {
      requireConsent();
      const existing = getActiveForMod(folder);
      if (existing) return existing;
      const created = await host.createConversation({
        type: 'mod',
        modFolder: folder,
      });
      setActiveForMod(folder, created.id);
      return created;
    },
  );

  /**
   * Open a conversation's live agent session (constructs it if needed) and
   * return its hydrated transcript. The slow half of opening a mod — the
   * renderer runs it in the background once the workspace is already up.
   */
  ipc.handle(
    'modmixer:conversations:open-session',
    async (_evt, conversationId: string) => {
      requireConsent();
      await host.openSession(conversationId);
      return { messages: host.getMessages(conversationId) };
    },
  );

  /**
   * Replace the current chat for a mod with a fresh one and return its
   * Conversation. Like resolve-for-mod this does NOT construct the session —
   * the caller opens it via `open-session`. The previous chat stays on disk;
   * the caller closes its session (modmixer:agent:close).
   */
  ipc.handle(
    'modmixer:conversations:start-fresh-for-mod',
    async (_evt, folder: string) => {
      requireConsent();
      clearActiveForMod(folder);
      const created = await host.createConversation({
        type: 'mod',
        modFolder: folder,
      });
      setActiveForMod(folder, created.id);
      return created;
    },
  );
}
