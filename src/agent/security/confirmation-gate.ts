import { createHash, randomUUID } from 'node:crypto';

/**
 * Minimal subset of Electron's BrowserWindow we depend on, kept here so the
 * gate can be unit-tested without loading the Electron runtime. main.ts
 * passes a real window getter; tests pass `() => null` (no window → fail
 * closed unless the test auto-approve flag is set).
 */
export interface ConfirmTransport {
  send(channel: string, payload: unknown): void;
}
export type ConfirmTransportGetter = () => ConfirmTransport | null;

/**
 * What the user sees in the approval modal. The renderer formats these as
 * "are you sure you want to <label>?" with the parameters listed beneath.
 */
export interface ConfirmationRequest {
  id: string;
  /** Tool name as known by the LLM (e.g. `bash`, `enable_mod_in_game`). */
  tool: string;
  /** Short imperative phrase shown in the modal title. */
  label: string;
  /**
   * One-line plain-English summary of what will happen, supplied by the
   * caller. The LLM-supplied tool args are *not* shown verbatim because they
   * may contain prompt-injected text designed to manipulate the user.
   */
  summary: string;
  /**
   * Argument key/value pairs surfaced in the modal so the user can spot a
   * mismatched intent (e.g. "I asked it to enable Mod A but it's about to
   * enable Mod B"). Sensitive long blobs are truncated to avoid abusing the
   * UI as an exfiltration channel.
   */
  paramPreview: Record<string, string>;
}

export interface ConfirmationDecision {
  approved: boolean;
  /**
   * If true and approved, the same (tool, paramsHash) pair won't prompt again
   * for the rest of this session. Always-allow is keyed on a hash of the
   * params so "always allow `bash` with command `dotnet build`" doesn't
   * silently approve a different `bash` command later.
   */
  alwaysAllowForSession: boolean;
}

/** Console audit log entry. We don't persist this to disk yet (TODO once we
 * have a settled telemetry path); the goal is at least to leave a trail in
 * the renderer dev tools and main-process console for incident response. */
export interface ConfirmationLogEntry {
  timestamp: string;
  tool: string;
  /** Hash of the JSON-stringified params, NOT the raw params. The raw
   * arguments may include user paths or other PII. */
  paramsHash: string;
  approved: boolean;
  alwaysAllow: boolean;
  /** "user" = explicit click, "session-allow" = previously-granted always-allow,
   * "no-window" = renderer not available so request denied by default,
   * "test" = test harness short-circuit. */
  source: 'user' | 'session-allow' | 'no-window' | 'test';
}

export const CONFIRM_CHANNEL_REQUEST = 'modmixer:confirm:request';
export const CONFIRM_CHANNEL_RESOLVE = 'modmixer:confirm:resolve';

/**
 * Hash of stable JSON representation of params. Used as the always-allow key
 * so a per-session approval is parameter-shape-specific. We sort keys so
 * `{a:1,b:2}` and `{b:2,a:1}` collide. Truncated to 16 hex chars — collision
 * resistance is overkill for an in-memory session map.
 */
function paramsHash(params: unknown): string {
  const stable = JSON.stringify(params, Object.keys(params ?? {}).sort());
  return createHash('sha256').update(stable).digest('hex').slice(0, 16);
}

/**
 * Truncate a value for display in the modal. Long strings are capped so a
 * malicious mod's About.xml can't push UI past the screen edge. Objects are
 * JSON-stringified.
 */
function previewValue(v: unknown, max = 240): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

export function buildParamPreview(
  params: Record<string, unknown> | null | undefined,
): Record<string, string> {
  if (!params || typeof params !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    out[k] = previewValue(v);
  }
  return out;
}

interface PendingRequest {
  resolve: (decision: ConfirmationDecision) => void;
  reject: (err: Error) => void;
}

/**
 * Single source of truth for "was this destructive action approved?"
 * Lives in the main process so the renderer cannot self-approve by sending
 * a fake event — every approval comes from a real IPC call originating in
 * the user's click.
 */
export class ConfirmationGate {
  private readonly pending = new Map<string, PendingRequest>();
  /** key = `${tool}:${paramsHash}`. */
  private readonly sessionAllowed = new Set<string>();
  /** Override for tests. When set, the gate never asks the user. */
  private testApproveAll = false;

  constructor(private readonly getTransport: ConfirmTransportGetter) {}

  /**
   * Resolve a pending request from the renderer. Called by main.ts whenever
   * the renderer sends `CONFIRM_CHANNEL_RESOLVE`. Kept as a public method
   * (instead of binding ipcMain inside the gate) so tests can inject
   * decisions without touching Electron.
   */
  resolveFromRenderer(payload: unknown): void {
    this.handleResolve(payload);
  }

  /** Test-only entry: short-circuit every request with `approved: true`. */
  setTestAutoApprove(value: boolean): void {
    this.testApproveAll = value;
  }

  /** Test-only: forget all session-allow grants. */
  resetSessionAllowsForTests(): void {
    this.sessionAllowed.clear();
  }

  /**
   * Ask the user to approve a sensitive action. Resolves with
   * { approved: true } iff the user explicitly approved (or had previously
   * granted always-allow for the same params). Rejects only on internal
   * error — denial is a normal `{ approved: false }` outcome.
   */
  async request(req: Omit<ConfirmationRequest, 'id'>, params: unknown): Promise<ConfirmationDecision> {
    const hash = paramsHash(params);
    const sessionKey = `${req.tool}:${hash}`;

    if (this.testApproveAll) {
      this.log({ tool: req.tool, paramsHash: hash, approved: true, alwaysAllow: false, source: 'test' });
      return { approved: true, alwaysAllowForSession: false };
    }

    if (this.sessionAllowed.has(sessionKey)) {
      this.log({ tool: req.tool, paramsHash: hash, approved: true, alwaysAllow: true, source: 'session-allow' });
      return { approved: true, alwaysAllowForSession: true };
    }

    const transport = this.getTransport();
    if (!transport) {
      // Renderer not available — fail closed. The agent will surface the
      // tool error and the user can retry once the window is back.
      this.log({ tool: req.tool, paramsHash: hash, approved: false, alwaysAllow: false, source: 'no-window' });
      return { approved: false, alwaysAllowForSession: false };
    }

    const id = randomUUID();
    const promise = new Promise<ConfirmationDecision>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });

    const message: ConfirmationRequest = { id, ...req };
    transport.send(CONFIRM_CHANNEL_REQUEST, message);

    const decision = await promise;
    if (decision.approved && decision.alwaysAllowForSession) {
      this.sessionAllowed.add(sessionKey);
    }
    this.log({
      tool: req.tool,
      paramsHash: hash,
      approved: decision.approved,
      alwaysAllow: decision.alwaysAllowForSession,
      source: 'user',
    });
    return decision;
  }

  /**
   * Cancel every outstanding request (e.g. on shutdown or when the user
   * starts a fresh chat). Each cancelled request resolves to denied.
   */
  cancelAll(): void {
    for (const { resolve } of this.pending.values()) {
      resolve({ approved: false, alwaysAllowForSession: false });
    }
    this.pending.clear();
  }

  private handleResolve(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return;
    const obj = payload as Record<string, unknown>;
    const id = typeof obj.id === 'string' ? obj.id : null;
    if (!id) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    pending.resolve({
      approved: !!obj.approved,
      alwaysAllowForSession: !!obj.alwaysAllowForSession,
    });
  }

  private log(entry: Omit<ConfirmationLogEntry, 'timestamp'>): void {
    const full: ConfirmationLogEntry = {
      ...entry,
      timestamp: new Date().toISOString(),
    };
    // eslint-disable-next-line no-console
    console.log('[modmixer:confirm]', JSON.stringify(full));
  }
}

let gateInstance: ConfirmationGate | null = null;

export function initConfirmationGate(
  getTransport: ConfirmTransportGetter,
): ConfirmationGate {
  if (!gateInstance) gateInstance = new ConfirmationGate(getTransport);
  return gateInstance;
}

export function getConfirmationGate(): ConfirmationGate {
  if (!gateInstance) {
    throw new Error('ConfirmationGate not initialized. Call initConfirmationGate() in main first.');
  }
  return gateInstance;
}

/** Test-only: install a no-transport gate that auto-approves by default. */
export function installTestConfirmationGateForTests(): ConfirmationGate {
  gateInstance = new ConfirmationGate(() => null);
  gateInstance.setTestAutoApprove(true);
  return gateInstance;
}
