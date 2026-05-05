import { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

export function Column<T>({
  title,
  subtitle,
  empty,
  items,
  getKey,
  renderItem,
}: {
  title: string;
  subtitle: string;
  empty: string;
  items: T[];
  getKey: (item: T, index: number) => string;
  renderItem: (item: T, index: number) => React.ReactNode;
}) {
  return (
    <div className="flex flex-1 flex-col overflow-hidden border-r border-line last:border-r-0">
      <div className="border-b border-line bg-surface/40 px-4 py-2">
        <div className="font-display text-sm font-medium text-ink">{title}</div>
        <div className="text-[11px] text-muted">{subtitle}</div>
      </div>
      {items.length === 0 ? (
        <div className="flex-1 overflow-auto p-6 text-center text-xs text-muted">
          {empty}
        </div>
      ) : (
        <VirtualRows items={items} getKey={getKey} renderItem={renderItem} />
      )}
    </div>
  );
}

function VirtualRows<T>({
  items,
  getKey,
  renderItem,
}: {
  items: T[];
  getKey: (item: T, index: number) => string;
  renderItem: (item: T, index: number) => React.ReactNode;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    // ModRow is two text lines + py-2 padding; measureElement corrects
    // for rows that wrap badges onto a second line.
    estimateSize: () => 52,
    overscan: 8,
    getItemKey: (index) => getKey(items[index], index),
  });
  return (
    <div ref={parentRef} className="flex-1 overflow-auto">
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => (
          <div
            key={virtualRow.key}
            data-index={virtualRow.index}
            ref={virtualizer.measureElement}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${virtualRow.start}px)`,
            }}
            className="border-b border-line"
          >
            {renderItem(items[virtualRow.index], virtualRow.index)}
          </div>
        ))}
      </div>
    </div>
  );
}
