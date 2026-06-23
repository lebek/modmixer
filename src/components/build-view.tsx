import type { Conversation } from '../agent/conversations';
import type { WorkspaceMod } from '../agent/workspace';
import type { ModelOption } from '../agent/models';
import { ChatPanel } from './chat-panel';
import { ModHeader } from './mod-header';
import { AssetsView } from './assets-view';
import { ModSchematicPanel } from './mod-schematic-panel';
import { ModPublishPanel } from './mod-publish-panel';
import { ModDepsPanel } from './mod-deps-panel';
import { ModBuildSidebar, type BuildPanel } from './mod-build-sidebar';
import { SavesView, type RestoreResult } from './saves-view';
import { getGame, resolveGameId } from '../agent/games/registry';

export function BuildView({
  activeMod,
  activeConvo,
  panel,
  onSelectPanel,
  onBack,
  onTest,
  onGeneratePreview,
  onNewChat,
  onSavesRestored,
  onModDeleted,
  busy,
  hasAi,
  availableModels,
  onConnect,
  multiChat,
  chatListRev,
  onSelectChat,
  onNewChatMulti,
  onArchiveChat,
  onUnarchiveChat,
}: {
  activeMod: WorkspaceMod | null;
  activeConvo: Conversation;
  panel: BuildPanel;
  onSelectPanel: (panel: BuildPanel) => void;
  onBack: () => void;
  onTest: () => void;
  onGeneratePreview: () => void;
  onNewChat: () => void;
  onSavesRestored: (result: RestoreResult) => void;
  onModDeleted?: (folder: string) => void;
  busy: boolean;
  hasAi: boolean;
  availableModels: ModelOption[];
  onConnect: () => void;
  multiChat: boolean;
  chatListRev: number;
  onSelectChat: (convo: Conversation) => void;
  onNewChatMulti: () => void;
  onArchiveChat: (id: string) => void;
  onUnarchiveChat: (id: string) => void;
}) {
  // Pre-scaffold "new mod" chat: no mod yet, no Assets to browse.
  // Force panel='chat' and hide the Assets entry until a mod exists.
  const newModInProgress = !activeMod;

  // Per-game UI gating: the Assets (Textures/Sounds) and Deps (About.xml
  // dependencies) panels are RimWorld-specific. Gate them on the mod's game
  // capabilities so a Minecraft mod doesn't get RimWorld's content panels.
  const caps = activeMod
    ? getGame(resolveGameId(activeMod.prefs.game)).capabilities
    : null;
  const showAssetPanel = !newModInProgress && !!caps?.assetPanel;
  const showDepsPanel = !newModInProgress && !!caps?.depsPanel;
  // Publish target drives the row label (and hides the row for a game that
  // can't publish). RimWorld → Steam Workshop, Minecraft → Modrinth.
  const publishSubtitle =
    caps?.publish === 'modrinth'
      ? 'Send to Modrinth'
      : caps?.publish === 'steam-workshop'
        ? 'Send to Steam Workshop'
        : undefined;
  // Coerce an unavailable panel back to chat (e.g. a Minecraft mod whose stored
  // panel is a RimWorld-only one) so the content area never renders blank.
  const effectivePanel: BuildPanel =
    newModInProgress ||
    (panel === 'assets' && !showAssetPanel) ||
    (panel === 'deps' && !showDepsPanel)
      ? 'chat'
      : panel;

  return (
    <div className="flex min-h-0 flex-1">
      <ModBuildSidebar
        mod={activeMod}
        convo={activeConvo}
        panel={effectivePanel}
        onSelectPanel={onSelectPanel}
        onBack={onBack}
        showAssets={!newModInProgress}
        showAssetPanel={showAssetPanel}
        showDepsPanel={showDepsPanel}
        publishSubtitle={publishSubtitle}
        onNewChat={newModInProgress ? undefined : onNewChat}
        multiChat={multiChat}
        chatListRev={chatListRev}
        onSelectChat={onSelectChat}
        onNewChatMulti={onNewChatMulti}
        onArchiveChat={onArchiveChat}
        onUnarchiveChat={onUnarchiveChat}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        {activeMod && (
          <ModHeader
            mod={activeMod}
            conversationId={activeConvo.id}
            busy={busy}
            onTest={onTest}
            hasAi={hasAi}
          />
        )}
        {effectivePanel === 'schematic' && activeMod && (
          <ModSchematicPanel mod={activeMod} />
        )}
        {effectivePanel === 'assets' && activeMod && (
          <AssetsView mod={activeMod} />
        )}
        {effectivePanel === 'deps' && activeMod && (
          <ModDepsPanel mod={activeMod} />
        )}
        {effectivePanel === 'saves' && activeMod && (
          <SavesView mod={activeMod} onRestored={onSavesRestored} />
        )}
        {effectivePanel === 'publish' && activeMod && (
          <ModPublishPanel
            mod={activeMod}
            hasAi={hasAi}
            onGeneratePreview={onGeneratePreview}
            onDeleted={
              onModDeleted ? () => onModDeleted(activeMod.folder) : undefined
            }
          />
        )}
        <div
          className={
            effectivePanel === 'chat'
              ? 'flex min-h-0 flex-1 flex-col'
              : 'hidden'
          }
        >
          <ChatPanel
            key={activeConvo.id}
            conversation={activeConvo}
            activeMod={activeMod}
            hasAi={hasAi}
            availableModels={availableModels}
            onConnect={onConnect}
          />
        </div>
      </div>
    </div>
  );
}
