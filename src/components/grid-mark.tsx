import type { CSSProperties } from 'react';
import { cn } from '@/lib/cn';

const GRID_MARK = [
  false, true,     true,     false,
  true,  true,     true,     true,
  true,  'accent', 'accent', true,
  true,  true,     true,     true,
] as const;

export function GridMark({
  loading = false,
  size = 5,
}: {
  loading?: boolean;
  size?: number;
}) {
  const cellSize: CSSProperties = { width: `${size}px`, height: `${size}px` };
  let litIndex = 0;
  return (
    <div
      className={cn('grid grid-cols-4 gap-px', loading && 'gridmark-loading')}
      aria-hidden
    >
      {GRID_MARK.map((cell, i) => {
        if (cell === false) {
          return (
            <span key={i} style={cellSize} className="block bg-transparent" />
          );
        }
        const color = cell === 'accent' ? 'bg-accent' : 'bg-ink';
        const style: CSSProperties = loading
          ? { ...cellSize, ['--i' as string]: litIndex++ }
          : cellSize;
        return (
          <span
            key={i}
            style={style}
            className={cn('block', color, loading && 'gridmark-cell')}
          />
        );
      })}
    </div>
  );
}
