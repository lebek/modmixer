import type { BrowserWindow, IpcMain } from 'electron';
import type { AgentHost } from '../../agent/agent-host.js';
import type { ConfirmationGate } from '../../agent/security/confirmation-gate.js';
import type {
  AnalysisResult,
  RegistrySnapshot,
} from '../../agent/registry/index.js';

export interface RegistryEnvelope {
  snapshot: RegistrySnapshot;
  analysis: AnalysisResult;
}

/**
 * Shared dependencies handed to each route-registration function so they
 * don't have to grab module-scoped singletons at runtime.
 */
export interface RouteContext {
  ipc: IpcMain;
  getWindow: () => BrowserWindow | null;
  host: AgentHost;
  confirmGate: ConfirmationGate;
  buildRegistryEnvelope: () => RegistryEnvelope;
  /** Throws if the user hasn't accepted the consent screen. */
  requireConsent: () => void;
}
