import { cn } from '@/lib/cn';
import { useConversationRuntime } from '../conversations-store';

/** Home, Library, or a focused mod tab. */
export type AppView = 'mods' | 'library' | 'mod';

/** One open mod tab, as the nav needs to render it. */
export interface ModTabDescriptor {
  folder: string;
  conversationId: string;
  title: string;
}

export function TabNav({
  view,
  focusedFolder,
  tabs,
  sessionActive,
  onSelectMods,
  onSelectLibrary,
  onSelectTab,
  onCloseTab,
}: {
  view: AppView;
  focusedFolder: string | null;
  tabs: ModTabDescriptor[];
  sessionActive?: boolean;
  onSelectMods: () => void;
  onSelectLibrary: () => void;
  onSelectTab: (folder: string) => void;
  onCloseTab: (folder: string) => void;
}) {
  return (
    <nav className="flex min-w-0 items-center gap-1">
      <TabButton label="Home" active={view === 'mods'} onClick={onSelectMods} />
      <TabButton
        label="Library"
        active={view === 'library'}
        onClick={onSelectLibrary}
        indicator={sessionActive ? 'session' : undefined}
      />
      {tabs.length > 0 && (
        <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-line" />
      )}
      {/* One mod tab per open conversation; scrolls horizontally (wheel,
          no visible bar) once there are more tabs than fit. */}
      <div className="no-scrollbar flex min-w-0 items-center gap-1 overflow-x-auto">
        {tabs.map((t) => (
          <ModTabButton
            key={t.folder}
            title={t.title}
            conversationId={t.conversationId}
            active={view === 'mod' && focusedFolder === t.folder}
            onSelect={() => onSelectTab(t.folder)}
            onClose={() => onCloseTab(t.folder)}
          />
        ))}
      </div>
    </nav>
  );
}

function TabButton({
  label,
  active,
  onClick,
  indicator,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  indicator?: 'session';
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1 font-mono text-[11px] uppercase tracking-[0.18em] transition-colors',
        // Keyboard focus only — no ring on mouse click.
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        active
          ? 'bg-ink text-paper'
          : 'text-muted hover:bg-raised/60 hover:text-ink',
      )}
    >
      {label}
      {indicator === 'session' && (
        <span
          className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse"
          aria-label="session active"
        />
      )}
    </button>
  );
}

/**
 * One open-mod tab. A peer of TabButton — same pill shape and active
 * treatment — but carries the mod's name (rendered in the mono face, like
 * mod names elsewhere), a busy dot, and a close affordance. Subscribes to
 * its own conversation runtime so the dot lights up while that mod's agent
 * works, regardless of which tab is focused.
 */
function ModTabButton({
  title,
  conversationId,
  active,
  onSelect,
  onClose,
}: {
  title: string;
  conversationId: string;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const { busy } = useConversationRuntime(conversationId);
  return (
    <div
      className={cn(
        'flex shrink-0 items-center rounded-md pr-1 transition-colors',
        // One focus ring for the whole pill — only when an inner button is
        // keyboard-focused (the buttons themselves drop their own outline,
        // which would otherwise box just the text+dot sub-region).
        'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent',
        active
          ? 'bg-ink text-paper'
          : 'text-muted hover:bg-raised/60 hover:text-ink',
      )}
    >
      <button
        onClick={onSelect}
        title={title}
        aria-label={busy ? `${title}, agent working` : undefined}
        className="flex min-w-0 items-center gap-1.5 py-1 pl-2.5 focus:outline-none"
      >
        {/* Status dot — accent + pulse while this mod's agent is working
            (mirrors the Library session dot), a dim idle dot otherwise so
            the slot is never empty white space and the tab never changes
            width. */}
        <span
          aria-hidden
          className={cn(
            'h-1.5 w-1.5 shrink-0 rounded-full transition-colors',
            busy ? 'animate-pulse bg-accent' : 'bg-current opacity-40',
          )}
        />
        <span className="max-w-[10rem] truncate font-mono text-xs">
          {title}
        </span>
      </button>
      <button
        onClick={onClose}
        aria-label={`Close ${title}`}
        title={`Close ${title}`}
        className={cn(
          'ml-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded transition-colors focus:outline-none',
          active
            ? 'text-paper/50 hover:bg-paper/20 hover:text-paper'
            : 'text-subtle hover:bg-ink/10 hover:text-ink',
        )}
      >
        <CloseGlyph />
      </button>
    </div>
  );
}

function CloseGlyph() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      className="h-3 w-3"
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}
