import {
  clearActiveForMod,
  getActiveForMod,
  listConversations,
  setActiveForMod,
  type ConversationScope,
} from '../../agent/conversations.js';
import type { RouteContext } from './context.js';

/**
 * Agent send/interrupt + conversation index. send/create/switch all gate
 * on `requireConsent` because they would otherwise let the agent run before
 * the user has accepted the consent screen.
 */
export function registerConversationRoutes(ctx: RouteContext): void {
  const { ipc, host, requireConsent } = ctx;

  ipc.handle('modmixer:agent:send', async (_evt, text: string) => {
    requireConsent();
    await host.send(text);
  });

  ipc.handle('modmixer:agent:interrupt', async () => {
    await host.interrupt();
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

  ipc.handle('modmixer:conversations:switch', async (_evt, id: string) => {
    requireConsent();
    const convo = await host.switchTo(id);
    // If this conversation is mod-scoped, mark it active for that mod so the
    // sidebar can recover the right chat on app restart.
    if (convo.scope.type === 'mod') {
      setActiveForMod(convo.scope.modFolder, convo.id);
    }
    return {
      conversation: convo,
      messages: host.getActiveMessages(),
    };
  });

  ipc.handle('modmixer:conversations:delete', async (_evt, id: string) => {
    await host.deleteConversation(id);
  });

  ipc.handle('modmixer:conversations:get-active', () => host.getCurrentId());

  ipc.handle('modmixer:conversations:get-active-messages', () =>
    host.getActiveMessages(),
  );

  /**
   * Get-or-create the "active chat" for a mod. If one exists in the index,
   * switch to it; otherwise create a fresh mod-scoped conversation, mark it
   * active, and return its first hydrated state.
   */
  ipc.handle(
    'modmixer:conversations:open-for-mod',
    async (_evt, folder: string) => {
      requireConsent();
      const existing = getActiveForMod(folder);
      const convo = existing
        ? await host.switchTo(existing.id)
        : await (async () => {
            const created = await host.createConversation({
              type: 'mod',
              modFolder: folder,
            });
            await host.switchTo(created.id);
            setActiveForMod(folder, created.id);
            return created;
          })();
      return {
        conversation: convo,
        messages: host.getActiveMessages(),
      };
    },
  );

  /**
   * Replace the current chat for a mod with a fresh one. The previous chat
   * stays on disk in the session log, just no longer surfaced as the active
   * chat for this mod.
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
      await host.switchTo(created.id);
      setActiveForMod(folder, created.id);
      return {
        conversation: created,
        messages: host.getActiveMessages(),
      };
    },
  );
}
