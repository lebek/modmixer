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
}) {
  // Pre-scaffold "new mod" chat: no mod yet, no Assets to browse.
  // Force panel='chat' and hide the Assets entry until a mod exists.
  const newModInProgress = !activeMod;

  return (
    <div className="flex min-h-0 flex-1">
      <ModBuildSidebar
        mod={activeMod}
        convo={activeConvo}
        panel={newModInProgress ? 'chat' : panel}
        onSelectPanel={onSelectPanel}
        onBack={onBack}
        showAssets={!newModInProgress}
        onNewChat={newModInProgress ? undefined : onNewChat}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        {activeMod && (
          <ModHeader
            mod={activeMod}
            busy={busy}
            onTest={onTest}
            hasAi={hasAi}
          />
        )}
        {!newModInProgress && panel === 'schematic' && activeMod && (
          <ModSchematicPanel mod={activeMod} />
        )}
        {!newModInProgress && panel === 'assets' && activeMod && (
          <AssetsView mod={activeMod} />
        )}
        {!newModInProgress && panel === 'deps' && activeMod && (
          <ModDepsPanel mod={activeMod} />
        )}
        {!newModInProgress && panel === 'saves' && activeMod && (
          <SavesView mod={activeMod} onRestored={onSavesRestored} />
        )}
        {!newModInProgress && panel === 'publish' && activeMod && (
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
            newModInProgress || panel === 'chat'
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
