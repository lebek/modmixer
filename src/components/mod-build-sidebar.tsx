import { useEffect, useState } from 'react';
import type { Conversation } from '../agent/conversations';
import type { WorkspaceMod } from '../agent/workspace';
import type { AssetCounts } from '../agent/assets/types';
import { cn } from '@/lib/cn';
import { appConfirm } from './app-dialog';
import { useSnapshots } from './saves-view';
import { ModChatList } from './mod-chat-list';

export type BuildPanel =
  | 'chat'
  | 'schematic'
  | 'assets'
  | 'deps'
  | 'saves'
  | 'publish';

export function ModBuildSidebar({
  mod,
  convo,
  panel,
  onSelectPanel,
  onBack,
  showAssets,
  onNewChat,
  multiChat,
  chatListRev,
  onSelectChat,
  onNewChatMulti,
  onArchiveChat,
  onUnarchiveChat,
}: {
  mod: WorkspaceMod | null;
  convo: Conversation;
  panel: BuildPanel;
  onSelectPanel: (panel: BuildPanel) => void;
  onBack: () => void;
  showAssets: boolean;
  onNewChat?: () => void;
  multiChat: boolean;
  chatListRev: number;
  onSelectChat: (convo: Conversation) => void;
  onNewChatMulti: () => void;
  onArchiveChat: (id: string) => void;
  onUnarchiveChat: (id: string) => void;
}) {
  const [assetCounts, setAssetCounts] = useState<AssetCounts | null>(null);
  const saves = useSnapshots(showAssets && mod ? mod.folder : null);
  // Multi-chat only applies to a real mod — a pre-scaffold draft has no
  // folder to list chats against and keeps the single-chat flow.
  const showMultiChat = multiChat && !!mod;

  useEffect(() => {
    if (!mod || !showAssets) {
      setAssetCounts(null);
      return;
    }
    let cancelled = false;
    const refresh = async () => {
      try {
        const scan = await window.modmixer.scanAssets(mod.folder);
        if (!cancelled) setAssetCounts(scan.counts);
      } catch {
        // best-effort badge
      }
    };
    void refresh();
    const off = window.modmixer.onAssetsChanged(({ folder }) => {
      if (folder === mod.folder) void refresh();
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [mod?.folder, showAssets]);

  const missing = assetCounts?.missing ?? 0;
  const invalid = assetCounts?.invalid ?? 0;
  const needsAttention = missing + invalid;

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-line bg-surface/50">
      <div className="border-b border-line px-4 py-3">
        <button
          onClick={onBack}
          className="group flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.18em] text-muted transition-colors hover:text-ink"
        >
          <span aria-hidden className="transition-transform group-hover:-translate-x-0.5">
            ←
          </span>
          <span>back</span>
        </button>
        <div className="mt-1 truncate font-display text-sm font-medium text-ink">
          {mod ? mod.about.name || mod.folder : convo.title || 'Draft'}
        </div>
      </div>

      <nav className="no-scrollbar flex-1 overflow-auto py-1">
        <SidebarRow
          label="Chat"
          subtitle="Make or fix your mod"
          icon={<ChatIcon />}
          active={panel === 'chat'}
          onClick={() => onSelectPanel('chat')}
        />
        {showMultiChat && mod && (
          <ModChatList
            modFolder={mod.folder}
            activeConversationId={convo.id}
            refreshKey={chatListRev}
            onSelect={onSelectChat}
            onNewChat={onNewChatMulti}
            onArchive={onArchiveChat}
            onUnarchive={onUnarchiveChat}
          />
        )}
        {showAssets && (
          <SidebarRow
            label="Schematic"
            subtitle="Learn how your mod works"
            icon={<SchematicIcon />}
            active={panel === 'schematic'}
            onClick={() => onSelectPanel('schematic')}
          />
        )}
        {showAssets && (
          <SidebarRow
            label="Assets"
            subtitle="Add images and sounds"
            icon={<AssetsIcon />}
            active={panel === 'assets'}
            onClick={() => onSelectPanel('assets')}
            badge={
              needsAttention > 0
                ? {
                    count: needsAttention,
                    tone: invalid > 0 ? 'failed' : 'accent',
                    title:
                      invalid > 0
                        ? `${missing} missing, ${invalid} invalid`
                        : `${missing} missing`,
                  }
                : undefined
            }
          />
        )}
        {showAssets && (
          <SidebarRow
            label="Deps"
            subtitle="What this mod needs"
            icon={<DepsIcon />}
            active={panel === 'deps'}
            onClick={() => onSelectPanel('deps')}
          />
        )}
        {showAssets && (
          <SidebarRow
            label="Publish"
            subtitle="Send to Steam Workshop"
            icon={<PublishIcon />}
            active={panel === 'publish'}
            onClick={() => onSelectPanel('publish')}
          />
        )}
        {showAssets && (
          <SidebarRow
            label="History"
            subtitle="Rollback your mod"
            icon={<SavesIcon />}
            active={panel === 'saves'}
            onClick={() => onSelectPanel('saves')}
            badge={
              saves.length > 0
                ? {
                    count: saves.length,
                    tone: 'accent',
                    title: `${saves.length} save${saves.length === 1 ? '' : 's'}`,
                  }
                : undefined
            }
          />
        )}
      </nav>

      {onNewChat && !showMultiChat && (
        <div className="border-t border-line px-4 py-3">
          <button
            type="button"
            onClick={async () => {
              const ok = await appConfirm(
                'The current chat will be archived and the agent will begin with no prior context for this mod.',
                { title: 'Start a fresh chat?', okLabel: 'Start fresh' },
              );
              if (ok) onNewChat();
            }}
            title="Start a fresh chat (clears agent context for this mod)"
            className="font-mono text-[10px] uppercase tracking-[0.18em] text-subtle transition-colors hover:text-ink"
          >
            + New chat
          </button>
        </div>
      )}
    </aside>
  );
}

function SidebarRow({
  label,
  subtitle,
  icon,
  active,
  onClick,
  badge,
}: {
  label: string;
  subtitle: string;
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
  badge?: { count: number; tone: 'accent' | 'failed'; title: string };
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-3 px-4 py-2 text-left transition-colors',
        active ? 'bg-raised text-ink' : 'text-ink/85 hover:bg-raised/60',
      )}
    >
      <span
        className={cn(
          'shrink-0 transition-colors',
          active ? 'text-ink' : 'text-muted',
        )}
      >
        {icon}
      </span>
      <span className="flex-1 min-w-0">
        <span className="block truncate text-sm">{label}</span>
        <span className="block truncate text-[11px] text-muted">{subtitle}</span>
      </span>
      {badge && (
        <span
          title={badge.title}
          className={cn(
            'inline-flex items-center rounded-full px-1.5 font-mono text-[10px]',
            badge.tone === 'failed'
              ? 'bg-failed/15 text-failed'
              : 'bg-accent/15 text-accent',
          )}
        >
          {badge.count}
        </span>
      )}
    </button>
  );
}

function ChatIcon() {
  return (
    <svg
      aria-hidden
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 12a8 8 0 0 1-11.6 7.13L4 20l.87-5.4A8 8 0 1 1 21 12z" />
    </svg>
  );
}

function SchematicIcon() {
  return (
    <svg
      aria-hidden
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="5" r="2" />
      <circle cx="5" cy="19" r="2" />
      <circle cx="19" cy="19" r="2" />
      <path d="M12 7v3M7 17l4-5M17 17l-4-5" />
    </svg>
  );
}

function AssetsIcon() {
  return (
    <svg
      aria-hidden
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="10" r="1.75" />
      <path d="m4 18 5-5 4 4 3-3 4 4" />
    </svg>
  );
}

function DepsIcon() {
  return (
    <svg
      aria-hidden
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="3" width="7" height="7" />
      <rect x="14" y="3" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" />
      <path d="M14 17.5h7" />
      <path d="M17.5 14v7" />
    </svg>
  );
}

function SavesIcon() {
  return (
    <svg
      aria-hidden
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <polyline points="3 4 3 10 9 10" />
    </svg>
  );
}

function PublishIcon() {
  return (
    <svg
      aria-hidden
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 16V4" />
      <path d="m6 10 6-6 6 6" />
      <path d="M4 20h16" />
    </svg>
  );
}
