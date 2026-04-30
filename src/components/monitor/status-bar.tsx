import { useEffect, useState } from 'react';
import { cn } from '@/lib/cn';
import type { MonitorConnectionState } from '../../agent/monitor/protocol';
import type { MonitorStream } from './use-monitor-stream';

const SPEED_LABEL = ['paused', '1x', '2x', '3x'];

export function StatusBar({
  connection,
  stream,
}: {
  connection: MonitorConnectionState;
  stream: MonitorStream;
}) {
  const connected = connection.kind === 'connected';
  const since = connected ? connection.since : 0;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!connected) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [connected]);

  const uptime = connected ? formatDuration(now - since) : '—';
  const latest = stream.latest;
  const speed = latest ? SPEED_LABEL[latest.speed] ?? `${latest.speed}x` : '—';

  return (
    <div className="flex items-center gap-5 border-b border-line bg-surface/60 px-5 py-2.5 font-mono text-[11px] uppercase tracking-[0.18em]">
      <ConnectionPill connection={connection} />
      <Stat label="uptime" value={uptime} />
      <Stat
        label="tick"
        value={latest ? latest.gameTick.toLocaleString() : '—'}
      />
      <Stat label="speed" value={speed} />
      <Stat
        label="tps"
        value={latest ? latest.tps.toFixed(1) : '—'}
        tone={tpsTone(latest?.tps)}
      />
      <Stat
        label="fps"
        value={latest ? latest.fps.toFixed(0) : '—'}
        tone={fpsTone(latest?.fps)}
      />
      <Stat
        label="frame"
        value={latest ? `${latest.frameMs.toFixed(1)}ms` : '—'}
      />
      <Stat
        label="heap"
        value={latest ? `${latest.heapMb.toFixed(0)}mb` : '—'}
      />
      <Stat
        label="bridge"
        value={latest ? `${latest.bridgeMs.toFixed(2)}ms` : '—'}
      />
      <div className="ml-auto flex items-center gap-5">
        <Stat
          label="errors"
          value={stream.errorsTotal.toString()}
          tone={stream.errorsTotal > 0 ? 'warn' : undefined}
        />
        <Stat
          label="patches"
          value={
            stream.snapshot ? stream.snapshot.patches.length.toString() : '—'
          }
        />
        <Stat
          label="conflicts"
          value={
            stream.snapshot
              ? stream.snapshot.conflicts.length.toString()
              : '—'
          }
          tone={
            stream.snapshot && stream.snapshot.conflicts.length > 0
              ? 'warn'
              : undefined
          }
        />
      </div>
    </div>
  );
}

function ConnectionPill({ connection }: { connection: MonitorConnectionState }) {
  if (connection.kind === 'connected') {
    return (
      <span className="flex items-center gap-2 text-ready">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ready" />
        live · rw {connection.rimworldVersion} · bridge{' '}
        {connection.bridgeVersion}
      </span>
    );
  }
  if (connection.kind === 'listening') {
    return (
      <span className="flex items-center gap-2 text-muted">
        <span className="h-1.5 w-1.5 rounded-full bg-pending" />
        listening :{connection.port}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-2 text-muted">
      <span className="h-1.5 w-1.5 rounded-full bg-pending" />
      offline
    </span>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'warn' | 'ok';
}) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-subtle">{label}</span>
      <span
        className={cn(
          'tabular-nums text-ink',
          tone === 'warn' && 'text-failed',
          tone === 'ok' && 'text-ready',
        )}
      >
        {value}
      </span>
    </div>
  );
}

function tpsTone(tps: number | undefined): 'warn' | 'ok' | undefined {
  if (tps === undefined) return undefined;
  if (tps < 30) return 'warn';
  if (tps >= 55) return 'ok';
  return undefined;
}

function fpsTone(fps: number | undefined): 'warn' | undefined {
  if (fps === undefined) return undefined;
  if (fps < 30) return 'warn';
  return undefined;
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${pad(m)}:${pad(sec)}`;
  return `${m}:${pad(sec)}`;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}
