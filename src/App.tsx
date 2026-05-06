import { useCallback, useEffect, useState } from 'react';
import type { AgentMessage, ThinkingLevel } from '@mariozechner/pi-agent-core';
import type { Conversation } from './agent/conversations';
import type { WorkspaceMod } from './agent/workspace';
import type { ModelOption } from './agent/models';
import type { ModelSelection } from './agent/settings';
import type { ActiveSession } from './agent/registry';
import type { RegistryEnvelope } from './preload';
import { GridMark } from './components/grid-mark';
import { ModelPicker } from './components/model-picker';
import { ThinkingPicker } from './components/thinking-picker';
import { AppSettingsDialog, type SettingsSection } from './components/app-settings-dialog';
import { IndexProgressModal } from './components/index-progress-modal';
import { TabNav, type Tab } from './components/tab-nav';
import { BuildView } from './components/build-view';
import { ModsView } from './components/mods-view';
import { LibraryView } from './components/library-view';
import { SessionRecoveryDialog } from './components/session-recovery-dialog';
import { appAlert } from './components/app-dialog';

import type { BuildPanel } from './components/mod-build-sidebar';

export function App() {
  const [tab, setTab] = useState<Tab>('mods');
  const [mods, setMods] = useState<WorkspaceMod[]>([]);
  const [activeModFolder, setActiveModFolder] = useState<string | null>(null);
  const [activeConvo, setActiveConvo] = useState<Conversation | null>(null);
  const [activeMessages, setActiveMessages] = useState<AgentMessage[]>([]);
  const [buildPanel, setBuildPanel] = useState<BuildPanel>('chat');
  const [busy, setBusy] = useState(false);
  const [availableModels, setAvailableModels] = useState<ModelOption[]>([]);
  const [currentModel, setCurrentModel] = useState<ModelSelection | null>(null);
  const [thinkingLevel, setThinkingLevelState] = useState<ThinkingLevel>('medium');
  const [settingsSection, setSettingsSection] = useState<SettingsSection | null>(
    null,
  );
  const [appVersion, setAppVersion] = useState<string>('');
  const [registryEnvelope, setRegistryEnvelope] = useState<RegistryEnvelope | null>(null);
  const [session, setSession] = useState<ActiveSession | null>(null);
  const [recoveryShown, setRecoveryShown] = useState(false);

  const hasAi = availableModels.length > 0;

  const refreshModels = useCallback(async () => {
    const list = await window.modmixer.listModels();
    setAvailableModels(list);
  }, []);

  const openSettings = useCallback((section: SettingsSection = 'providers') => {
    setSettingsSection(section);
  }, []);

  useEffect(() => {
    void window.modmixer.getAppVersion().then(setAppVersion);
  }, []);

  useEffect(() => {
    void refreshModels();
    void window.modmixer.getSettings().then((s) => {
      setCurrentModel(s.model);
      setThinkingLevelState(s.thinkingLevel);
    });
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

  // Mod registry: subscribe to live updates + bootstrap snapshot.
  useEffect(() => {
    void window.modmixer.getRegistry().then(setRegistryEnvelope);
    return window.modmixer.onRegistryChanged(setRegistryEnvelope);
  }, []);

  // Active session: bootstrap + live updates. If we boot with an active
  // session it's a crash-orphan from a previous run — show the recovery
  // dialog one time per launch.
  useEffect(() => {
    void window.modmixer.getActiveSession().then((s) => {
      setSession(s);
      if (s) setRecoveryShown(true);
    });
    return window.modmixer.onSessionChanged(setSession);
  }, []);

  const refreshRegistry = useCallback(async () => {
    const env = await window.modmixer.refreshRegistry();
    setRegistryEnvelope(env);
  }, []);
  const setActiveMods = useCallback(async (packageIds: string[]) => {
    const env = await window.modmixer.setActiveMods(packageIds);
    setRegistryEnvelope(env);
  }, []);
  const applyAutosort = useCallback(async () => {
    const { envelope } = await window.modmixer.applyAutosort();
    setRegistryEnvelope(envelope);
  }, []);
  const startFix = useCallback(async () => {
    const res = await window.modmixer.startFixSession();
    setSession(res.session);
    setRegistryEnvelope(res.envelope);
  }, []);
  const applySession = useCallback(async () => {
    const { envelope } = await window.modmixer.applySession();
    setRegistryEnvelope(envelope);
    setSession(null);
  }, []);
  const revertSession = useCallback(async () => {
    const { envelope } = await window.modmixer.revertSession();
    setRegistryEnvelope(envelope);
    setSession(null);
  }, []);
  const enableWithDeps = useCallback(
    async (packageId: string) => {
      const res = await window.modmixer.enableWithDeps(packageId);
      setRegistryEnvelope(res.envelope);
      return res;
    },
    [],
  );

  const setModel = useCallback(async (selection: ModelSelection) => {
    setCurrentModel(selection);
    await window.modmixer.setModel(selection);
  }, []);

  const setThinkingLevel = useCallback(async (level: ThinkingLevel) => {
    setThinkingLevelState(level);
    await window.modmixer.setThinkingLevel(level);
  }, []);

  const openMod = useCallback(
    async (folder: string) => {
      setBuildPanel('chat');
      setTab('build');
      // Same mod = no-op past the tab switch. Re-hydrating would reset
      // ChatPanel and drop in-flight streaming + tool state.
      if (folder === activeModFolder && activeConvo) return;
      const hydrated = await window.modmixer.openConversationForMod(folder);
      setActiveModFolder(folder);
      setActiveConvo(hydrated.conversation);
      setActiveMessages(hydrated.messages);
    },
    [activeModFolder, activeConvo],
  );

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

  // "Enable" for a workspace mod has to be atomic: create the symlink AND
  // add the packageId to <activeMods>. If we did only one, RimWorld either
  // can't find the packageId on disk (no symlink) or finds the folder but
  // ignores it (not in active list). Same constraint for disable.
  const sync = async (folder: string) => {
    try {
      const next = await window.modmixer.syncModToGame(folder);
      setMods(next);
      const m = next.find((x) => x.folder === folder);
      const packageId = m?.about.packageId;
      if (!packageId) {
        const env = await window.modmixer.refreshRegistry();
        setRegistryEnvelope(env);
        void appAlert(
          'Mod synced, but About.xml has no packageId, so it was not added to the active list.',
        );
        return;
      }
      try {
        const res = await enableWithDeps(packageId);
        if (res.missing.length > 0) {
          void appAlert(
            `Enabled ${m?.about.name || folder}. Declared deps not installed (mod will fail to load until installed): ${res.missing.join(', ')}.`,
          );
        }
      } catch (err) {
        console.error(err);
        void appAlert(
          err instanceof Error
            ? err.message
            : 'Mod synced, but adding to ModsConfig.xml failed.',
        );
      }
    } catch (err) {
      console.error(err);
      void appAlert(
        err instanceof Error ? err.message : 'Failed to sync mod to game.',
      );
    }
  };

  // Disable = remove from <activeMods> only. The symlink stays so the mod
  // remains in RimWorld's installed-mod list as "inactive" — same behavior
  // as a Workshop or local mod when disabled. Removing the symlink would
  // make the mod disappear from RimWorld entirely, which is asymmetric and
  // surprising.
  const unsync = async (folder: string) => {
    try {
      await window.modmixer.disableModInGame(folder);
      const next = await window.modmixer.listWorkspaceMods();
      setMods(next);
      const env = await window.modmixer.refreshRegistry();
      setRegistryEnvelope(env);
    } catch (err) {
      console.error(err);
      void appAlert(
        err instanceof Error ? err.message : 'Failed to disable mod.',
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
      void appAlert(
        err instanceof Error ? err.message : 'Failed to start test.',
      );
    }
  };

  // "Generate Preview Image" hands off to the chat panel: switch the build
  // sub-panel from publish → chat so the user can watch the agent compose
  // the image, then auto-submit a request. The agent's system prompt
  // teaches it to write to {folder}/About/Preview.png at 1280×720.
  const generatePreview = async () => {
    if (!activeConvo || !activeModFolder || !hasAi) return;
    const mod = mods.find((m) => m.folder === activeModFolder);
    const displayName = mod?.about.name || activeModFolder;
    setBuildPanel('chat');
    try {
      await window.modmixer.send(
        `Generate a Steam Workshop preview image for "${displayName}" and save it to ${activeModFolder}/About/Preview.png. Use render_preview — pick a template, choose a sprite from Textures/ if any exist, and pick a background and title treatment that fits the mod's tone.`,
      );
    } catch (err) {
      console.error(err);
      void appAlert(
        err instanceof Error
          ? err.message
          : 'Failed to start preview generation.',
      );
    }
  };

  const newMod = async () => {
    if (!hasAi) {
      openSettings('providers');
      return;
    }
    // Create the mod folder up front (placeholder About.xml, standard
    // subdirs) so the chat is bound to a real on-disk mod from message
    // zero. If the user bails before the agent fills in metadata, the mod
    // is still recoverable from the Mods view instead of orphaned.
    try {
      const { folder, mods: nextMods } = await window.modmixer.createUntitledMod();
      setMods(nextMods);
      await openMod(folder);
    } catch (err) {
      console.error(err);
      void appAlert(
        err instanceof Error ? err.message : 'Failed to create new mod.',
      );
    }
  };

  const importMod = async () => {
    try {
      const imported = await window.modmixer.importModFromFolder();
      if (!imported) return;
      setMods(imported.mods);
      await openMod(imported.result.folder);
    } catch (err) {
      console.error(err);
      void appAlert(
        err instanceof Error ? err.message : 'Failed to import mod folder.',
      );
    }
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
            sessionActive={!!session}
          />
        </div>
        <div className="flex items-center gap-3">
          <ModelPicker
            models={availableModels}
            current={currentModel}
            onChange={setModel}
            onConnect={() => openSettings('providers')}
          />
          {hasAi && (
            <ThinkingPicker current={thinkingLevel} onChange={setThinkingLevel} />
          )}
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
          activeOrder={registryEnvelope?.snapshot.activeOrder ?? []}
          onOpen={openMod}
          onNewMod={newMod}
          onSync={sync}
          onUnsync={unsync}
        />
      )}
      {tab === 'library' && (
        <LibraryView
          envelope={registryEnvelope}
          session={session}
          onRefresh={refreshRegistry}
          onAutosort={applyAutosort}
          onSetActive={setActiveMods}
          onEnableWithDeps={enableWithDeps}
          onStartFix={startFix}
          onApplySession={applySession}
          onRevertSession={revertSession}
        />
      )}
      {/* Stays mounted across tab switches so ChatPanel's state and event
          subscription survive — otherwise in-flight streaming and the
          user's just-sent message vanish on the way back. */}
      <div
        className={
          tab === 'build' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'
        }
      >
        <BuildView
          mods={mods}
          activeMod={activeMod}
          activeConvo={activeConvo}
          activeMessages={activeMessages}
          panel={buildPanel}
          onSelectPanel={setBuildPanel}
          onOpenMod={openMod}
          onNewMod={newMod}
          onImportMod={importMod}
          onBack={exitMod}
          onTest={test}
          onGeneratePreview={generatePreview}
          onNewChat={startFreshChat}
          onModDeleted={async () => {
            exitMod();
            await refreshMods();
            await refreshRegistry();
            setTab('mods');
          }}
          busy={busy}
          hasAi={hasAi}
          onConnect={() => openSettings('providers')}
        />
      </div>
      {settingsSection && (
        <AppSettingsDialog
          initialSection={settingsSection}
          onClose={() => setSettingsSection(null)}
        />
      )}

      <IndexProgressModal />

      {recoveryShown && session && (
        <SessionRecoveryDialog
          session={session}
          onApply={async () => {
            try {
              await applySession();
            } finally {
              setRecoveryShown(false);
            }
          }}
          onRevert={async () => {
            try {
              await revertSession();
            } finally {
              setRecoveryShown(false);
            }
          }}
          onDismiss={() => {
            setRecoveryShown(false);
            setTab('library');
          }}
        />
      )}
    </div>
  );
}
