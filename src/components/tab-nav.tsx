import { cn } from '@/lib/cn';

export type Tab = 'mods' | 'library' | 'build';

export function TabNav({
  active,
  onChange,
  sessionActive,
}: {
  active: Tab;
  onChange: (t: Tab) => void;
  sessionActive?: boolean;
}) {
  return (
    <nav className="flex items-center gap-1">
      <TabButton
        label="Home"
        active={active === 'mods'}
        onClick={() => onChange('mods')}
      />
      <TabButton
        label="Library"
        active={active === 'library'}
        onClick={() => onChange('library')}
        indicator={sessionActive ? 'session' : undefined}
      />
      <TabButton
        label="Build"
        active={active === 'build'}
        onClick={() => onChange('build')}
      />
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
        'flex items-center gap-1.5 rounded-md px-3 py-1 font-mono text-[11px] uppercase tracking-[0.18em] transition-colors',
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
