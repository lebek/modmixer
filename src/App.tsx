import { useCallback, useEffect, useState } from 'react';
import type { Conversation } from './agent/conversations';
import type { WorkspaceMod } from './agent/workspace';
import type { ModelOption } from './agent/models';
import type { ActiveSession } from './agent/registry';
import type { RegistryEnvelope } from './preload';
import { GridMark } from './components/grid-mark';
import { AppSettingsDialog, type SettingsSection } from './components/app-settings-dialog';
import { IndexProgressModal } from './components/index-progress-modal';
import { TabNav, type AppView, type ModTabDescriptor } from './components/tab-nav';
import { BuildView } from './components/build-view';
import { ModsView } from './components/mods-view';
import { LibraryView } from './components/library-view';
import type { RestoreResult } from './components/saves-view';
import { SessionRecoveryDialog } from './components/session-recovery-dialog';
import { appAlert } from './components/app-dialog';
import type { BuildPanel } from './components/mod-build-sidebar';
import {
  dropConversation,
  isConversationBusy,
  isConversationEmpty,
  markConversationLoading,
  resetPanelState,
  seedConversation,
  seedPanelState,
  useAnyBusy,
  useConversationRuntime,
} from './conversations-store';

/**
 * One open mod tab. Each tab is an independent build session: its own
 * conversation, its own agent session in the main process, its own sidebar
 * panel selection. Live chat state (messages, streaming, busy) is NOT held
 * here — it lives in the conversation store so a background tab keeps
 * accumulating while the user is focused elsewhere.
 */
interface ModTab {
  folder: string;
  conversation: Conversation;
  buildPanel: BuildPanel;
}

export function App() {
  const [view, setView] = useState<AppView>('mods');
  const [mods, setMods] = useState<WorkspaceMod[]>([]);
  const [tabs, setTabs] = useState<ModTab[]>([]);
  const [focusedFolder, setFocusedFolder] = useState<string | null>(null);
  const [availableModels, setAvailableModels] = useState<ModelOption[]>([]);
  const [settingsSection, setSettingsSection] = useState<SettingsSection | null>(
    null,
  );
  const [appVersion, setAppVersion] = useState<string>('');
  const [registryEnvelope, setRegistryEnvelope] = useState<RegistryEnvelope | null>(null);
  const [session, setSession] = useState<ActiveSession | null>(null);
  const [recoveryShown, setRecoveryShown] = useState(false);
  const [multiChat, setMultiChat] = useState(false);
  const [skipPermissions, setSkipPermissions] = useState(false);
  // Bumped after a chat is created/archived/restored so the sidebar's chat
  // list re-fetches. The list also self-refreshes off agent events.
  const [chatListRev, setChatListRev] = useState(0);

  const hasAi = availableModels.length > 0;
  // Header indicator: lit while ANY open tab's agent is working.
  const busy = useAnyBusy();

  const focusedTab = tabs.find((t) => t.folder === focusedFolder) ?? null;
  const activeMod = focusedTab
    ? mods.find((m) => m.folder === focusedTab.folder) ?? null
    : null;
  // Drives the focused mod's Test button — unconditionally called (empty id
  // resolves to an idle runtime when no tab is focused).
  const focusedBusy = useConversationRuntime(
    focusedTab?.conversation.id ?? '',
  ).busy;

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

  // A couple of toggles live in settings and need to take effect without a
  // restart; re-read them whenever the settings dialog closes. The skip-
  // permissions flag also drives the header's "Permissions off" badge.
  const refreshSettingsFlags = useCallback(() => {
    void window.modmixer.getSettings().then((s) => {
      setMultiChat(s.multiChat);
      setSkipPermissions(s.dangerouslySkipPermissions);
    });
  }, []);
  useEffect(() => {
    refreshSettingsFlags();
  }, [refreshSettingsFlags]);

  useEffect(() => {
    void refreshModels();
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
      // A finished turn may have changed the mod on disk (new files, About
      // edits) — refresh the workspace list. Per-conversation chat state is
      // owned by the conversation store, not here.
      if (env.event.type === 'agent_end') void refreshMods();
    });
    const offModChanged = window.modmixer.onModChanged(() => {
      void refreshMods();
    });
    const offScope = window.modmixer.onScopeUpgraded((env) => {
      if (env.scope.type !== 'mod') return;
      void refreshMods();
      // scaffold_mod upgraded a conversation's scope — keep the tab's copy
      // of the conversation in sync.
      setTabs((prev) =>
        prev.map((t) =>
          t.conversation.id === env.conversationId
            ? { ...t, conversation: { ...t.conversation, scope: env.scope } }
            : t,
        ),
      );
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

  /**
   * Open a mod in a tab. Each mod opens exactly once — re-opening one that's
   * already open just focuses its existing tab. Other tabs keep running.
   */
  const openMod = useCallback(
    async (folder: string) => {
      if (tabs.some((t) => t.folder === folder)) {
        setFocusedFolder(folder);
        setView('mod');
        return;
      }
      // Fast: resolve the Conversation (index op, no session) so the
      // workspace can appear immediately.
      const convo = await window.modmixer.resolveConversationForMod(folder);
      markConversationLoading(convo.id);
      seedPanelState(convo);
      setTabs((prev) =>
        prev.some((t) => t.folder === folder)
          ? prev
          : [...prev, { folder, conversation: convo, buildPanel: 'chat' }],
      );
      setFocusedFolder(folder);
      setView('mod');
      // Slow: construct the session + hydrate the transcript off the
      // critical path. The chat shows a loading state until this lands.
      void window.modmixer
        .openConversationSession(convo.id)
        .then(({ messages }) => seedConversation(convo.id, messages))
        .catch((err) => {
          console.error('Failed to open conversation session:', err);
          seedConversation(convo.id, []);
        });
    },
    [tabs],
  );

  /** Close a tab: dispose its session, forget its runtime, focus a neighbour. */
  const closeTab = useCallback(
    (folder: string) => {
      const idx = tabs.findIndex((t) => t.folder === folder);
      if (idx < 0) return;
      const tab = tabs[idx];
      void window.modmixer.closeConversation(tab.conversation.id);
      dropConversation(tab.conversation.id);
      const next = tabs.filter((t) => t.folder !== folder);
      setTabs(next);
      if (focusedFolder === folder) {
        const neighbour = next[idx] ?? next[idx - 1] ?? null;
        setFocusedFolder(neighbour?.folder ?? null);
        if (!neighbour) setView('mods');
      }
    },
    [tabs, focusedFolder],
  );

  const setTabBuildPanel = useCallback(
    (folder: string, panel: BuildPanel) => {
      setTabs((prev) =>
        prev.map((t) => (t.folder === folder ? { ...t, buildPanel: panel } : t)),
      );
    },
    [],
  );

  // Sidebar "back": return to Home without closing the tab.
  const goHome = useCallback(() => setView('mods'), []);

  const startFreshChat = useCallback(async () => {
    const tab = tabs.find((t) => t.folder === focusedFolder);
    if (!tab) return;
    const oldId = tab.conversation.id;
    const convo = await window.modmixer.startFreshChatForMod(tab.folder);
    markConversationLoading(convo.id);
    seedPanelState(convo);
    setTabs((prev) =>
      prev.map((t) =>
        t.folder === tab.folder
          ? { ...t, conversation: convo, buildPanel: 'chat' }
          : t,
      ),
    );
    // The previous chat is archived on disk; drop its live session + runtime.
    await window.modmixer.closeConversation(oldId);
    dropConversation(oldId);
    // Construct the fresh session in the background.
    void window.modmixer
      .openConversationSession(convo.id)
      .then(({ messages }) => seedConversation(convo.id, messages))
      .catch((err) => {
        console.error('Failed to open conversation session:', err);
        seedConversation(convo.id, []);
      });
  }, [tabs, focusedFolder]);

  // Multi-chat: switch the focused mod's tab to an existing chat. The
  // previous chat's runtime stays in the store (a background turn keeps
  // streaming); only its session is freed, and only if it's idle.
  const selectChat = useCallback(
    async (convo: Conversation) => {
      const tab = tabs.find((t) => t.folder === focusedFolder);
      if (!tab) return;
      // Re-clicking the active chat from another panel (Assets, Publish,
      // …) is the natural way back to its transcript — flip the panel and
      // skip the heavy switch path.
      if (tab.conversation.id === convo.id) {
        if (tab.buildPanel !== 'chat') setTabBuildPanel(tab.folder, 'chat');
        return;
      }
      const oldId = tab.conversation.id;
      // A chat with a turn in flight has a live, accurate store runtime —
      // leave it alone. Otherwise show a loading state until its transcript
      // re-hydrates (its session may have been freed while switched away).
      if (!isConversationBusy(convo.id)) markConversationLoading(convo.id);
      // First open of this chat seeds its panel state (draft + pickers);
      // a switch-back is a no-op — the existing entry is the live truth.
      seedPanelState(convo);
      await window.modmixer.setActiveConversationForMod(tab.folder, convo.id);
      setTabs((prev) =>
        prev.map((t) =>
          t.folder === tab.folder
            ? { ...t, conversation: convo, buildPanel: 'chat' }
            : t,
        ),
      );
      // Switching is non-destructive — keep the previous chat, just free its
      // session if it's idle. Untouched chats are reaped by newChatMulti, not
      // here: deleting on switch-away would orphan a chat the user is about
      // to return to.
      void window.modmixer.releaseIdleConversation(oldId);
      void window.modmixer
        .openConversationSession(convo.id)
        .then(({ messages }) => {
          if (!isConversationBusy(convo.id)) {
            seedConversation(convo.id, messages);
          }
        })
        .catch((err) => {
          console.error('Failed to open conversation session:', err);
          if (!isConversationBusy(convo.id)) seedConversation(convo.id, []);
        });
    },
    [tabs, focusedFolder, setTabBuildPanel],
  );

  // Multi-chat "+ New chat": create a chat and switch to it. Unlike the
  // single-chat flow this keeps the previous chat — it stays in the list.
  const newChatMulti = useCallback(async () => {
    const tab = tabs.find((t) => t.folder === focusedFolder);
    if (!tab) return;
    // If the user never sent a message to the chat they're on, drop it as the
    // next one is created — otherwise "+ New chat" stacks up untouched "New
    // chat" entries. The new chat is always kept, so the mod never ends up
    // with zero chats.
    const oldId = tab.conversation.id;
    const discardOld = isConversationEmpty(oldId);
    const convo = await window.modmixer.startFreshChatForMod(tab.folder);
    await selectChat(convo);
    if (discardOld) {
      void window.modmixer.deleteConversation(oldId);
      dropConversation(oldId);
    }
    setChatListRev((n) => n + 1);
  }, [tabs, focusedFolder, selectChat]);

  // Archive a chat. If it's the one on screen, fall back to the most recent
  // remaining chat (or a fresh one when nothing is left).
  const archiveChat = useCallback(
    async (id: string) => {
      await window.modmixer.archiveConversation(id);
      const tab = tabs.find((t) => t.folder === focusedFolder);
      if (tab && tab.conversation.id === id) {
        const list = await window.modmixer.listConversationsForMod(tab.folder);
        const next = list
          .filter((c) => c.id !== id && !c.archivedAt)
          .sort((a, b) => b.updatedAt - a.updatedAt)[0];
        if (next) {
          await selectChat(next);
        } else {
          await selectChat(
            await window.modmixer.startFreshChatForMod(tab.folder),
          );
        }
      }
      setChatListRev((n) => n + 1);
    },
    [tabs, focusedFolder, selectChat],
  );

  const unarchiveChat = useCallback(async (id: string) => {
    await window.modmixer.unarchiveConversation(id);
    setChatListRev((n) => n + 1);
  }, []);

  // Restore from a save replaces the focused mod's whole world: files, chat
  // list, and which chat is active. Re-seed the conversation store and swap
  // the tab's conversation in one render so the UI doesn't flash.
  const onSavesRestored = useCallback(
    (result: RestoreResult) => {
      setMods(result.mods);
      if (!result.hydrated) return;
      const restored = result.hydrated;
      const oldId = tabs.find(
        (t) => t.folder === focusedFolder,
      )?.conversation.id;
      if (oldId && oldId !== restored.conversation.id) {
        dropConversation(oldId);
      }
      seedConversation(restored.conversation.id, restored.messages);
      // Restore swaps in the snapshot's conversation wholesale — overwrite
      // any stale panel state (model/thinking on disk just changed too).
      resetPanelState(restored.conversation);
      setTabs((prev) =>
        prev.map((t) =>
          t.folder === focusedFolder
            ? { ...t, conversation: restored.conversation }
            : t,
        ),
      );
    },
    [tabs, focusedFolder],
  );

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
    if (!focusedTab || !hasAi) return;
    const mod = mods.find((m) => m.folder === focusedTab.folder);
    const displayName = mod?.about.name || focusedTab.folder;
    try {
      await window.modmixer.send(
        focusedTab.conversation.id,
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
    if (!focusedTab || !hasAi) return;
    const folder = focusedTab.folder;
    const conversationId = focusedTab.conversation.id;
    const mod = mods.find((m) => m.folder === folder);
    const displayName = mod?.about.name || folder;
    setTabBuildPanel(folder, 'chat');
    try {
      // If the user has supplied a background image (Preview panel drop zone),
      // tell the agent to use it as render_preview's `backgroundImagePath`
      // and skip the gradient/color choice. Path lives in the workspace
      // sidecar, which is allowed by render_preview's path policy.
      const bg = await window.modmixer.getPreviewBg(folder);
      const bgInstruction = bg
        ? ` The user has supplied a background image at ${bg.path} — pass it as render_preview's backgroundImagePath (do not pick a background color/gradient) and choose a titleEffect like "outline" or "shadow" so the title stays legible over the image.`
        : '';
      await window.modmixer.send(
        conversationId,
        `Generate a Steam Workshop preview image for "${displayName}" and save it to ${folder}/About/Preview.png. Use render_preview — pick a template, choose a sprite from Textures/ if any exist, and pick a background and title treatment that fits the mod's tone.${bgInstruction}`,
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

  const tabDescriptors: ModTabDescriptor[] = tabs.map((t) => {
    const mod = mods.find((m) => m.folder === t.folder);
    return {
      folder: t.folder,
      conversationId: t.conversation.id,
      title: mod?.about.name || t.conversation.title || t.folder,
    };
  });

  return (
    <div className="flex h-full flex-col bg-paper text-ink">
      <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
        <div className="flex min-w-0 flex-1 items-center gap-4">
          <div className="flex shrink-0 items-center gap-2.5">
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
            view={view}
            focusedFolder={focusedFolder}
            tabs={tabDescriptors}
            sessionActive={!!session}
            onSelectMods={() => setView('mods')}
            onSelectLibrary={() => setView('library')}
            onSelectTab={(folder) => {
              setFocusedFolder(folder);
              setView('mod');
            }}
            onCloseTab={closeTab}
          />
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {skipPermissions && (
            <button
              onClick={() => openSettings('advanced')}
              title="Permission prompts are off — the agent can edit or delete files and run shell commands without asking. Click to change."
              className="inline-flex items-center gap-1.5 rounded-md border border-failed/50 bg-failed/10 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-failed transition-colors hover:bg-failed/20"
            >
              <span aria-hidden>⚠</span>
              Permissions off
            </button>
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

      {view === 'library' ? (
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
      ) : view === 'mod' && focusedTab ? (
        // Only the focused tab's workspace is mounted — live chat state lives
        // in the conversation store, so unmounting an inactive tab is free
        // and a background agent keeps streaming regardless. Keyed by folder
        // so switching tabs cleanly remounts the workspace.
        <BuildView
          key={focusedTab.folder}
          activeMod={activeMod}
          activeConvo={focusedTab.conversation}
          panel={focusedTab.buildPanel}
          onSelectPanel={(panel) => setTabBuildPanel(focusedTab.folder, panel)}
          onBack={goHome}
          onTest={test}
          onGeneratePreview={generatePreview}
          onNewChat={startFreshChat}
          onSavesRestored={onSavesRestored}
          onModDeleted={(folder) => {
            closeTab(folder);
            void refreshMods();
            void refreshRegistry();
          }}
          busy={focusedBusy}
          hasAi={hasAi}
          availableModels={availableModels}
          onConnect={() => openSettings('providers')}
          multiChat={multiChat}
          chatListRev={chatListRev}
          onSelectChat={selectChat}
          onNewChatMulti={newChatMulti}
          onArchiveChat={archiveChat}
          onUnarchiveChat={unarchiveChat}
        />
      ) : (
        <ModsView
          mods={mods}
          onOpen={openMod}
          onNewMod={newMod}
          onImportMod={importMod}
        />
      )}
      {settingsSection && (
        <AppSettingsDialog
          initialSection={settingsSection}
          onClose={() => {
            setSettingsSection(null);
            refreshSettingsFlags();
          }}
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
            setView('library');
          }}
        />
      )}
    </div>
  );
}
