import { useEffect, useReducer, useRef } from 'react';
import type {
  BridgeMessage,
  ErrorEvent,
  ModsSnapshot,
  PerfTick,
} from '../../agent/monitor/protocol';

const PERF_RING = 240; // ~60s @ 4Hz

export interface ErrorBucket {
  hash: string;
  severity: ErrorEvent['severity'];
  firstLine: string;
  text: string;
  attributedMods: string[];
  count: number;
  firstAt: number;
  lastAt: number;
}

export interface MonitorStream {
  perf: PerfTick[];
  latest: PerfTick | null;
  snapshot: ModsSnapshot | null;
  errors: ErrorBucket[];
  errorsTotal: number;
}

const empty: MonitorStream = {
  perf: [],
  latest: null,
  snapshot: null,
  errors: [],
  errorsTotal: 0,
};

type Action =
  | { type: 'reset' }
  | { type: 'perf'; msg: PerfTick }
  | { type: 'snapshot'; msg: ModsSnapshot }
  | { type: 'error'; msg: ErrorEvent }
  | { type: 'seed_snapshot'; msg: ModsSnapshot | null };

function reducer(state: MonitorStream, action: Action): MonitorStream {
  switch (action.type) {
    case 'reset':
      return empty;
    case 'perf': {
      const next = state.perf.length >= PERF_RING ? state.perf.slice(1) : state.perf.slice();
      next.push(action.msg);
      return { ...state, perf: next, latest: action.msg };
    }
    case 'snapshot':
      return { ...state, snapshot: action.msg };
    case 'seed_snapshot':
      return action.msg ? { ...state, snapshot: action.msg } : state;
    case 'error': {
      const idx = state.errors.findIndex((e) => e.hash === action.msg.hash);
      const errors = state.errors.slice();
      if (idx === -1) {
        errors.unshift({
          hash: action.msg.hash,
          severity: action.msg.severity,
          firstLine: action.msg.firstLine,
          text: action.msg.text,
          attributedMods: action.msg.attributedMods,
          count: 1,
          firstAt: action.msg.at,
          lastAt: action.msg.at,
        });
        if (errors.length > 200) errors.pop();
      } else {
        const existing = errors[idx];
        errors.splice(idx, 1);
        errors.unshift({
          ...existing,
          count: existing.count + 1,
          lastAt: action.msg.at,
        });
      }
      return { ...state, errors, errorsTotal: state.errorsTotal + 1 };
    }
  }
}

/**
 * Subscribes to bridge messages and maintains a rolling perf ring,
 * the latest mods snapshot, and a deduped error list.
 *
 * Resets when the connection drops so old data doesn't bleed into a
 * new game session.
 */
export function useMonitorStream(connected: boolean): MonitorStream {
  const [state, dispatch] = useReducer(reducer, empty);
  const wasConnectedRef = useRef(connected);

  useEffect(() => {
    if (!connected && wasConnectedRef.current) {
      dispatch({ type: 'reset' });
    }
    wasConnectedRef.current = connected;
  }, [connected]);

  useEffect(() => {
    if (!connected) return;
    void window.modmixer.getMonitorSnapshot().then((snap) => {
      dispatch({ type: 'seed_snapshot', msg: snap });
    });
    return window.modmixer.onMonitorMessage((msg: BridgeMessage) => {
      switch (msg.type) {
        case 'perf':
          dispatch({ type: 'perf', msg });
          break;
        case 'mods_snapshot':
          dispatch({ type: 'snapshot', msg });
          break;
        case 'error_event':
          dispatch({ type: 'error', msg });
          break;
      }
    });
  }, [connected]);

  return state;
}
