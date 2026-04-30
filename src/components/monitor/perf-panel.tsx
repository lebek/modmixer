import type { MonitorStream } from './use-monitor-stream';
import { Sparkline } from './sparkline';

export function PerfPanel({ stream }: { stream: MonitorStream }) {
  const tps = stream.perf.map((p) => p.tps);
  const frameMs = stream.perf.map((p) => p.frameMs);
  const heap = stream.perf.map((p) => p.heapMb);
  const fps = stream.perf.map((p) => p.fps);

  return (
    <Panel title="performance" subtitle="rolling 60s · 4Hz">
      <div className="grid grid-cols-1 gap-3">
        <SparkRow
          label="TPS"
          values={tps}
          color="var(--color-ready)"
          fill
          latest={stream.latest?.tps}
          format={(v) => v.toFixed(1)}
          target={60}
        />
        <SparkRow
          label="FPS"
          values={fps}
          color="var(--color-ink)"
          latest={stream.latest?.fps}
          format={(v) => v.toFixed(0)}
        />
        <SparkRow
          label="frame ms"
          values={frameMs}
          color="var(--color-accent)"
          latest={stream.latest?.frameMs}
          format={(v) => `${v.toFixed(1)}`}
        />
        <SparkRow
          label="heap mb"
          values={heap}
          color="var(--color-muted)"
          fill
          latest={stream.latest?.heapMb}
          format={(v) => v.toFixed(0)}
        />
      </div>
    </Panel>
  );
}

function SparkRow({
  label,
  values,
  color,
  fill,
  latest,
  format,
  target,
}: {
  label: string;
  values: number[];
  color: string;
  fill?: boolean;
  latest: number | undefined;
  format: (v: number) => string;
  target?: number;
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="w-20 font-mono text-[10px] uppercase tracking-[0.18em] text-subtle">
        {label}
      </div>
      <div className="flex-1 text-ink" style={{ color }}>
        <Sparkline
          values={values}
          width={320}
          height={24}
          color={color}
          fill={fill}
        />
      </div>
      <div className="w-20 text-right font-mono text-[12px] tabular-nums text-ink">
        {latest === undefined ? '—' : format(latest)}
        {target !== undefined && (
          <span className="ml-1 text-subtle text-[10px]">/{target}</span>
        )}
      </div>
    </div>
  );
}

export function Panel({
  title,
  subtitle,
  children,
  rightSlot,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  rightSlot?: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col rounded-md border border-line bg-surface/40">
      <div className="flex items-center justify-between border-b border-line/60 px-3 py-2">
        <div className="flex items-baseline gap-2">
          <h3 className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink">
            {title}
          </h3>
          {subtitle && (
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-subtle">
              {subtitle}
            </span>
          )}
        </div>
        {rightSlot}
      </div>
      <div className="flex-1 overflow-auto px-3 py-3">{children}</div>
    </div>
  );
}
