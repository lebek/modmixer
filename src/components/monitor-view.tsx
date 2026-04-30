import { useState } from 'react';
import type { MonitorConnectionState } from '../agent/monitor/protocol';
import { useMonitorStream } from './monitor/use-monitor-stream';
import { StatusBar } from './monitor/status-bar';
import { PerfPanel } from './monitor/perf-panel';
import { ModsPanel } from './monitor/mods-panel';
import { PatchesPanel } from './monitor/patches-panel';
import { ErrorsPanel } from './monitor/errors-panel';

export function MonitorView({
  connection,
}: {
  connection: MonitorConnectionState;
}) {
  const stream = useMonitorStream(connection.kind === 'connected');
  const [selectedMod, setSelectedMod] = useState<string | null>(null);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <StatusBar connection={connection} stream={stream} />
      {connection.kind !== 'connected' ? (
        <NotConnected connection={connection} />
      ) : (
        <div className="grid flex-1 grid-cols-12 grid-rows-2 gap-3 overflow-hidden p-3">
          <div className="col-span-7 row-span-1 overflow-hidden">
            <PerfPanel stream={stream} />
          </div>
          <div className="col-span-5 row-span-2 overflow-hidden">
            <ModsPanel stream={stream} onSelectMod={setSelectedMod} />
          </div>
          <div className="col-span-7 row-span-1 overflow-hidden">
            <PatchesPanel stream={stream} selectedMod={selectedMod} />
          </div>
          <div className="col-span-12 row-span-1 max-h-72 overflow-hidden">
            <ErrorsPanel stream={stream} />
          </div>
        </div>
      )}
    </div>
  );
}

function NotConnected({
  connection,
}: {
  connection: MonitorConnectionState;
}) {
  const port =
    connection.kind === 'listening' || connection.kind === 'connected'
      ? connection.port
      : 13371;
  return (
    <div className="flex flex-1 items-center justify-center px-8 py-12">
      <div className="max-w-xl rounded-lg border border-dashed border-line bg-surface/40 p-8">
        <h3 className="font-display text-lg font-medium text-ink">
          No bridge connected
        </h3>
        <p className="mt-2 text-sm text-muted">
          The monitor watches for a connection from the Modmixer Bridge mod
          inside RimWorld. Install and enable the bridge mod, then start the
          game — this panel goes live the instant it connects.
        </p>
        <div className="mt-4 rounded bg-paper px-3 py-2 font-mono text-[11px] text-muted">
          listening · 127.0.0.1:{port}
        </div>
        <ul className="mt-4 space-y-1 font-mono text-[11px] text-subtle">
          <li>· perf telemetry — TPS, FPS, frame ms, GC heap</li>
          <li>· mod inventory — load order, assemblies, patch counts</li>
          <li>· harmony patch graph — destructive-prefix conflict detection</li>
          <li>· errors &amp; warnings — deduped, attributed by stack frame</li>
        </ul>
      </div>
    </div>
  );
}
