import { useCallback, useEffect, useState } from 'react';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { Conversation } from './agent/conversations';
import type { WorkspaceMod } from './agent/workspace';
import type { MonitorConnectionState } from './agent/monitor/protocol';
import type { ModelOption } from './agent/models';
import type { ModelSelection } from './agent/settings';
import { GridMark } from './components/grid-mark';
import { ModelPicker } from './components/model-picker';
import { AppSettingsDialog, type SettingsSection } from './components/app-settings-dialog';
import { IndexProgressModal } from './components/index-progress-modal';
import { TabNav, type Tab } from './components/tab-nav';
import { BuildView } from './components/build-view';
import { ModsView } from './components/mods-view';
import { MonitorView } from './components/monitor-view';

type BuildPanel = 'chat' | 'schematic' | 'assets' | 'publish';

export function App() {
  const [tab, setTab] = useState<Tab>('mods');
  const [mods, setMods] = useState<WorkspaceMod[]>([]);
  const [activeModFolder, setActiveModFolder] = useState<string | null>(null);
  const [activeConvo, setActiveConvo] = useState<Conversation | null>(null);
  const [activeMessages, setActiveMessages] = useState<AgentMessage[]>([]);
  const [buildPanel, setBuildPanel] = useState<BuildPanel>('chat');
  const [busy, setBusy] = useState(false);
  const [monitorState, setMonitorState] = useState<MonitorConnectionState>({
    kind: 'idle',
  });
  const [availableModels, setAvailableModels] = useState<ModelOption[]>([]);
  const [currentModel, setCurrentModel] = useState<ModelSelection | null>(null);
  const [settingsSection, setSettingsSection] = useState<SettingsSection | null>(
    null,
  );
  const [appVersion, setAppVersion] = useState<string>('');

  const hasAi = availableModels.length > 0;

  const refreshModels = useCallback(async () => {
    const list = await window.modmixer.listModels();
    setAvailableModels(list);
  }, []);

  const openSettings = useCallback((section: SettingsSection = 'providers') => {
    setSettingsSection(section);
  }, []);

  useEffect(() => {
    void window.modmixer.getMonitorState().then(setMonitorState);
    return window.modmixer.onMonitorState(setMonitorState);
  }, []);

  useEffect(() => {
    void window.modmixer.getAppVersion().then(setAppVersion);
  }, []);

  useEffect(() => {
    void refreshModels();
    void window.modmixer.getSettings().then((s) => setCurrentModel(s.model));
    // links-changed and login-success/logout all imply the available-model
    // list may have changed.
    return window.modmixer.onOAuthEvent((event) => {
      if (
        event.type === 'links-changed' ||
        event.type === 'login-success' ||
        event.type === 'logout'
      ) {
        void refreshModels();
      }
    });
  }, [refreshModels]);

  const refreshMods = useCallback(async () => {
    const list = await window.modmixer.listWorkspaceMods();
    setMods(list);
  }, []);

  useEffect(() => {
    void refreshMods();
    const offEvent = window.modmixer.onEvent((env) => {
      switch (env.event.type) {
        case 'agent_start':
          setBusy(true);
          break;
        case 'agent_end':
          setBusy(false);
          void refreshMods();
          break;
      }
    });
    const offModChanged = window.modmixer.onModChanged(() => {
      void refreshMods();
    });
    const offScope = window.modmixer.onScopeUpgraded((env) => {
      if (env.scope.type !== 'mod') return;
      void (async () => {
        await refreshMods();
        setActiveModFolder(env.scope.type === 'mod' ? env.scope.modFolder : null);
        setActiveConvo((prev) =>
          prev && prev.id === env.conversationId
            ? { ...prev, scope: env.scope }
            : prev,
        );
      })();
    });
    return () => {
      offEvent();
      offModChanged();
      offScope();
    };
  }, [refreshMods]);

  const setModel = useCallback(async (selection: ModelSelection) => {
    setCurrentModel(selection);
    await window.modmixer.setModel(selection);
  }, []);

  const openMod = useCallback(async (folder: string) => {
    const hydrated = await window.modmixer.openConversationForMod(folder);
    setActiveModFolder(folder);
    setActiveConvo(hydrated.conversation);
    setActiveMessages(hydrated.messages);
    setBuildPanel('chat');
    setTab('build');
  }, []);

  const exitMod = useCallback(() => {
    setActiveModFolder(null);
    setActiveConvo(null);
    setActiveMessages([]);
    setBuildPanel('chat');
  }, []);

  const startFreshChat = useCallback(async () => {
    if (!activeModFolder) return;
    const hydrated = await window.modmixer.startFreshChatForMod(activeModFolder);
    setActiveConvo(hydrated.conversation);
    setActiveMessages(hydrated.messages);
    setBuildPanel('chat');
  }, [activeModFolder]);

  const sync = async (folder: string) => {
    try {
      const next = await window.modmixer.syncModToGame(folder);
      setMods(next);
    } catch (err) {
      console.error(err);
      window.alert(
        err instanceof Error ? err.message : 'Failed to sync mod to game.',
      );
    }
  };

  const unsync = async (folder: string) => {
    try {
      const next = await window.modmixer.unsyncModFromGame(folder);
      setMods(next);
    } catch (err) {
      console.error(err);
      window.alert(
        err instanceof Error
          ? err.message
          : 'Failed to unsync mod from game.',
      );
    }
  };

  const test = async () => {
    if (!activeConvo || !activeModFolder || !hasAi) return;
    const mod = mods.find((m) => m.folder === activeModFolder);
    const displayName = mod?.about.name || activeModFolder;
    try {
      await window.modmixer.send(
        `Test "${displayName}" in RimWorld now. Run the full test-in-game flow including monitoring the log for errors.`,
      );
    } catch (err) {
      console.error(err);
      window.alert(
        err instanceof Error ? err.message : 'Failed to start test.',
      );
    }
  };

  const newMod = async () => {
    if (!hasAi) {
      openSettings('providers');
      return;
    }
    // "New mod" is a chat-driven flow: spin up a fresh mod-scope-less
    // conversation, switch to it, leave the user on the build tab to talk
    // through the scaffold. After scaffold_mod runs the conversation
    // rescopes to the new mod automatically.
    const convo = await window.modmixer.createConversation({ type: 'new' });
    const hydrated = await window.modmixer.switchConversation(convo.id);
    setActiveModFolder(null);
    setActiveConvo(hydrated.conversation);
    setActiveMessages(hydrated.messages);
    setBuildPanel('chat');
    setTab('build');
  };

  const activeMod =
    activeModFolder
      ? mods.find((m) => m.folder === activeModFolder) ?? null
      : null;

  return (
    <div className="flex h-full flex-col bg-paper text-ink">
      <header className="flex items-center justify-between border-b border-line px-5 py-3">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2.5">
            <GridMark loading={busy} />
            <span className="font-display text-sm font-medium tracking-tight">
              modmixer
            </span>
            {appVersion && (
              <span className="ml-1 font-mono text-[10px] uppercase tracking-[0.18em] text-subtle">
                v{appVersion}
              </span>
            )}
          </div>
          <TabNav
            active={tab}
            onChange={setTab}
            monitorConnected={monitorState.kind === 'connected'}
          />
        </div>
        <div className="flex items-center gap-3">
          <ModelPicker
            models={availableModels}
            current={currentModel}
            onChange={setModel}
            onConnect={() => openSettings('providers')}
          />
          <button
            onClick={() =>
              void window.modmixer.openExternal(
                'https://discord.gg/54QhJeNvFy',
              )
            }
            title="Join the modmixer Discord"
            aria-label="Join the modmixer Discord"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-line bg-paper text-muted transition-colors hover:border-ink/40 hover:text-ink"
          >
            <svg
              aria-hidden
              viewBox="0 0 24 24"
              fill="currentColor"
              className="h-3.5 w-3.5"
            >
              <path d="M20.317 4.369A19.79 19.79 0 0 0 16.558 3.2a.074.074 0 0 0-.079.037c-.34.6-.717 1.385-.98 2.005a18.27 18.27 0 0 0-5.487 0 12.683 12.683 0 0 0-.995-2.005.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 5.179 4.37a.07.07 0 0 0-.032.027C1.533 9.838.554 15.144 1.04 20.384a.082.082 0 0 0 .031.056 19.9 19.9 0 0 0 5.993 3.04.078.078 0 0 0 .084-.028 14.21 14.21 0 0 0 1.226-1.994.076.076 0 0 0-.041-.105 13.107 13.107 0 0 1-1.872-.893.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.292a.074.074 0 0 1 .077-.01c3.927 1.793 8.18 1.793 12.061 0a.074.074 0 0 1 .078.009c.12.099.246.198.373.293a.077.077 0 0 1-.006.128 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.106c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.029 19.84 19.84 0 0 0 6.002-3.04.077.077 0 0 0 .032-.054c.5-6.057-.838-11.32-3.548-15.988a.061.061 0 0 0-.031-.028zM8.02 17.331c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
            </svg>
          </button>
          <button
            onClick={() => openSettings('general')}
            title="Settings"
            aria-label="Settings"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-line bg-paper text-muted transition-colors hover:border-ink/40 hover:text-ink"
          >
            <svg
              aria-hidden
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-3.5 w-3.5"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </div>
      </header>

      {tab === 'mods' && (
        <ModsView
          mods={mods}
          onOpen={openMod}
          onNewMod={newMod}
          onSync={sync}
          onUnsync={unsync}
        />
      )}
      {tab === 'build' && (
        <BuildView
          mods={mods}
          activeMod={activeMod}
          activeConvo={activeConvo}
          activeMessages={activeMessages}
          panel={buildPanel}
          onSelectPanel={setBuildPanel}
          onOpenMod={openMod}
          onNewMod={newMod}
          onBack={exitMod}
          onTest={test}
          onNewChat={startFreshChat}
          busy={busy}
          hasAi={hasAi}
          onConnect={() => openSettings('providers')}
        />
      )}
      {tab === 'monitor' && <MonitorView connection={monitorState} />}

      {settingsSection && (
        <AppSettingsDialog
          initialSection={settingsSection}
          onClose={() => setSettingsSection(null)}
        />
      )}

      <IndexProgressModal />
    </div>
  );
}
