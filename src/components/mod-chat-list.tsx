import { useEffect, useMemo, useState } from 'react';
import type { Conversation } from '../agent/conversations';
import { cn } from '@/lib/cn';
import { useConversationRuntime } from '../conversations-store';

function relativeTime(ts: number): string {
  const min = Math.floor((Date.now() - ts) / 60000);
  if (min < 1) return 'now';
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  return `${Math.floor(day / 7)}w`;
}

/**
 * The multi-chat switcher: every chat for one mod, shown inline in the build
 * sidebar's nav. Not its own scroll region — it flows in the nav, which
 * already scrolls. The list re-fetches off the global agent event stream so
 * titles and ordering stay live as background chats run.
 */
export function ModChatList({
  modFolder,
  activeConversationId,
  refreshKey,
  onSelect,
  onNewChat,
  onArchive,
  onUnarchive,
}: {
  modFolder: string;
  activeConversationId: string;
  refreshKey: number;
  onSelect: (convo: Conversation) => void;
  onNewChat: () => void;
  onArchive: (id: string) => void;
  onUnarchive: (id: string) => void;
}) {
  const [chats, setChats] = useState<Conversation[]>([]);
  const [showArchived, setShowArchived] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void window.modmixer.listConversationsForMod(modFolder).then((list) => {
        if (!cancelled) setChats(list);
      });
    };
    refresh();
    // Titles auto-generate from the first message and updatedAt bumps as a
    // chat runs — keep the list current off the global event stream.
    const off = window.modmixer.onEvent((env) => {
      if (env.event.type === 'message_end' || env.event.type === 'agent_end') {
        refresh();
      }
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [modFolder, refreshKey]);

  const { active, archived } = useMemo(() => {
    const sorted = [...chats].sort((a, b) => b.updatedAt - a.updatedAt);
    return {
      active: sorted.filter((c) => !c.archivedAt),
      archived: sorted.filter((c) => c.archivedAt),
    };
  }, [chats]);

  return (
    <div className="border-b border-line bg-surface/30 py-1.5">
      {active.map((c) => (
        <ChatRow
          key={c.id}
          convo={c}
          active={c.id === activeConversationId}
          onSelect={() => onSelect(c)}
          onArchive={() => onArchive(c.id)}
        />
      ))}

      <button
        type="button"
        onClick={onNewChat}
        className="flex w-full items-center px-3 py-1.5 text-left font-mono text-[10px] uppercase tracking-[0.18em] text-subtle transition-colors hover:bg-raised/60 hover:text-ink"
      >
        + New chat
      </button>

      {archived.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setShowArchived((v) => !v)}
            className="flex w-full items-center gap-1 px-3 py-1 text-left font-mono text-[10px] uppercase tracking-[0.18em] text-muted transition-colors hover:text-ink"
          >
            <span aria-hidden>{showArchived ? '▾' : '▸'}</span>
            Archived ({archived.length})
          </button>
          {showArchived &&
            archived.map((c) => (
              <ChatRow
                key={c.id}
                convo={c}
                active={c.id === activeConversationId}
                archived
                onSelect={() => onSelect(c)}
                onUnarchive={() => onUnarchive(c.id)}
              />
            ))}
        </>
      )}
    </div>
  );
}

function ChatRow({
  convo,
  active,
  archived,
  onSelect,
  onArchive,
  onUnarchive,
}: {
  convo: Conversation;
  active: boolean;
  archived?: boolean;
  onSelect: () => void;
  onArchive?: () => void;
  onUnarchive?: () => void;
}) {
  const busy = useConversationRuntime(convo.id).busy;
  return (
    <div
      className={cn(
        'group flex items-center gap-2 px-3 py-1 transition-colors',
        active ? 'bg-raised text-ink' : 'text-ink/85 hover:bg-raised/60',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'h-1.5 w-1.5 shrink-0 rounded-full transition-colors',
          busy ? 'animate-pulse bg-accent' : 'bg-current opacity-40',
        )}
      />
      <button
        type="button"
        onClick={onSelect}
        className="min-w-0 flex-1 truncate py-0.5 text-left text-[12px]"
      >
        {convo.title || 'New chat'}
      </button>
      <span className="shrink-0 font-mono text-[9px] text-muted">
        {relativeTime(convo.updatedAt)}
      </span>
      <button
        type="button"
        onClick={archived ? onUnarchive : onArchive}
        title={archived ? 'Unarchive chat' : 'Archive chat'}
        aria-label={archived ? 'Unarchive chat' : 'Archive chat'}
        className="shrink-0 text-muted opacity-0 transition-opacity hover:text-ink group-hover:opacity-100"
      >
        {archived ? <UnarchiveIcon /> : <ArchiveIcon />}
      </button>
    </div>
  );
}

function ArchiveIcon() {
  return (
    <svg
      aria-hidden
      className="h-3.5 w-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
      <path d="M10 12h4" />
    </svg>
  );
}

function UnarchiveIcon() {
  return (
    <svg
      aria-hidden
      className="h-3.5 w-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
      <path d="M12 18v-6" />
      <path d="m9 15 3-3 3 3" />
    </svg>
  );
}
