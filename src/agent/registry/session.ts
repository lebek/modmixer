// Snapshot-restore session primitive. Used by both:
//   - "Test this mod" — temporarily enable Core+DLC+target+deps, run RimWorld,
//     restore on session end so the user's modlist is unchanged.
//   - "Fix my modlist" — agent iterates on the active list freely; user
//     decides at the end whether to apply or revert.
//
// Crash safety: the active session is persisted to userData/active-session.json
// the moment a snapshot is taken. If modmixer dies mid-session, the renderer
// detects the orphan on next launch and prompts the user to revert.

import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { app } from 'electron';
import {
  restoreFromSnapshot,
  snapshotModsConfig,
  writeActiveMods,
} from './mods-config.js';

export type SessionType = 'test' | 'fix';

export interface ActiveSession {
  id: string;
  type: SessionType;
  /** ISO timestamp when the session started. */
  startedAt: string;
  /** Snapshot of ModsConfig.xml taken at session start. */
  snapshotXml: string;
  /** For test sessions: the target workspace mod folder. */
  testTarget?: { folder: string; packageId: string };
  /** For fix sessions: the original active list at start (lowercased). */
  initialActive?: string[];
}

export interface SessionEvent {
  type: 'started' | 'applied' | 'reverted';
  session: ActiveSession;
}

const STATE_FILE = 'active-session.json';

type Listener = (event: SessionEvent) => void;

class SessionManager {
  private current: ActiveSession | null = null;
  private listeners = new Set<Listener>();

  /**
   * Read the persisted active session, if any. Called once at startup so the
   * renderer can detect a crash-orphaned session and prompt the user to
   * revert. Does NOT auto-revert: the user's bytes are precious and we want
   * an explicit click.
   */
  loadPersisted(): ActiveSession | null {
    try {
      const file = stateFile();
      if (!fs.existsSync(file)) return null;
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw) as ActiveSession;
      if (!parsed.id || !parsed.snapshotXml) return null;
      this.current = parsed;
      return parsed;
    } catch {
      return null;
    }
  }

  getActive(): ActiveSession | null {
    return this.current;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Start a test session: snapshot ModsConfig, write a reduced active list
   * (Core + active DLCs + target + transitive deps), and persist the session
   * record so a crash mid-test still yields a recoverable state.
   */
  async startTestSession(args: {
    folder: string;
    packageId: string;
    /** The reduced active list to write, lowercased packageIds in order. */
    reducedActive: string[];
  }): Promise<ActiveSession> {
    if (this.current) {
      throw new Error(
        `A ${this.current.type} session is already active (started ${this.current.startedAt}). End it before starting another.`,
      );
    }
    const snapshotXml = (await snapshotModsConfig()) ?? '';
    const session: ActiveSession = {
      id: cryptoId(),
      type: 'test',
      startedAt: new Date().toISOString(),
      snapshotXml,
      testTarget: { folder: args.folder, packageId: args.packageId },
    };
    await persistSession(session);
    this.current = session;
    await writeActiveMods(args.reducedActive);
    this.emit({ type: 'started', session });
    return session;
  }

  /**
   * Start a fix session: snapshot the current state but DON'T modify the
   * active list yet. The agent will mutate it during the session via
   * registry.setActiveMods, and the user decides at the end.
   */
  async startFixSession(initialActive: string[]): Promise<ActiveSession> {
    if (this.current) {
      throw new Error(
        `A ${this.current.type} session is already active (started ${this.current.startedAt}). End it before starting another.`,
      );
    }
    const snapshotXml = (await snapshotModsConfig()) ?? '';
    const session: ActiveSession = {
      id: cryptoId(),
      type: 'fix',
      startedAt: new Date().toISOString(),
      snapshotXml,
      initialActive: initialActive.map((s) => s.toLowerCase()),
    };
    await persistSession(session);
    this.current = session;
    this.emit({ type: 'started', session });
    return session;
  }

  /** Apply: keep current state, drop the snapshot. */
  async apply(): Promise<ActiveSession | null> {
    const session = this.current;
    if (!session) return null;
    await clearPersisted();
    this.current = null;
    this.emit({ type: 'applied', session });
    return session;
  }

  /** Revert: restore the snapshot bytes to ModsConfig.xml, drop session. */
  async revert(): Promise<ActiveSession | null> {
    const session = this.current;
    if (!session) return null;
    if (session.snapshotXml) {
      await restoreFromSnapshot(session.snapshotXml);
    }
    await clearPersisted();
    this.current = null;
    this.emit({ type: 'reverted', session });
    return session;
  }

  /**
   * Treat any persisted session record as the "current" session. Used when
   * the renderer asks at startup what to do with a crash-orphan: we hydrate
   * the in-memory current from disk so apply/revert IPC handlers work.
   */
  adoptPersisted(): ActiveSession | null {
    return this.loadPersisted();
  }

  private emit(event: SessionEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch {
        // ignore listener errors
      }
    }
  }
}

function stateFile(): string {
  return path.join(app.getPath('userData'), STATE_FILE);
}

async function persistSession(session: ActiveSession): Promise<void> {
  await fsp.writeFile(stateFile(), JSON.stringify(session, null, 2), 'utf8');
}

async function clearPersisted(): Promise<void> {
  try {
    await fsp.unlink(stateFile());
  } catch {
    // already gone
  }
}

function cryptoId(): string {
  return (
    Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
  );
}

let instance: SessionManager | null = null;

export function getSessionManager(): SessionManager {
  if (!instance) instance = new SessionManager();
  return instance;
}
