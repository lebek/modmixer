import type { AgentEventEnvelope } from './preload';
import { handleAgentEvent } from './conversations-store';

/**
 * Dev-only automation seam for the demo-video harness (~/projects/modmixer-demo).
 *
 * Loaded exclusively through the `import.meta.env.DEV` guard in renderer.tsx,
 * so this module — and the `window.__demo` global it installs — is statically
 * dead-code-eliminated from production bundles. The harness drives the app
 * over CDP and talks to these hooks via page.evaluate; nothing in the product
 * calls them except the single DEV-gated intercept in chat-panel's submit().
 *
 * Capabilities, by demo phase:
 *  - session run:  onEvent() taps every agent event envelope so the harness
 *                  can persist a timestamped transcript of a real agent run.
 *  - replay:       injectEvent() feeds those recorded envelopes back into the
 *                  conversation store on the harness's cinematic clock, and
 *                  setSendInterceptor() lets the harness swallow the real
 *                  send that typing-then-Enter would otherwise trigger.
 */

export interface DemoHooks {
  version: 1;
  /** Tap every agent event envelope as it arrives from main. Returns unsubscribe. */
  onEvent(cb: (env: AgentEventEnvelope) => void): () => void;
  /** Feed a (recorded) envelope into the conversation store as if it were live. */
  injectEvent(env: AgentEventEnvelope): void;
  /**
   * Arm replay mode: while set, chat sends are swallowed (return true from the
   * interceptor) instead of reaching the agent. Pass null to disarm.
   */
  setSendInterceptor(
    fn: ((conversationId: string, text: string) => boolean) | null,
  ): void;
  /** Consulted by chat-panel submit(); true = the send was intercepted. */
  consumeSend(conversationId: string, text: string): boolean;
}

const taps = new Set<(env: AgentEventEnvelope) => void>();
let sendInterceptor:
  | ((conversationId: string, text: string) => boolean)
  | null = null;

const hooks: DemoHooks = {
  version: 1,
  onEvent(cb) {
    taps.add(cb);
    return () => taps.delete(cb);
  },
  injectEvent(env) {
    handleAgentEvent(env);
  },
  setSendInterceptor(fn) {
    sendInterceptor = fn;
  },
  consumeSend(conversationId, text) {
    return sendInterceptor ? sendInterceptor(conversationId, text) : false;
  },
};

window.modmixer.onEvent((env) => {
  for (const cb of [...taps]) cb(env);
});

window.__demo = hooks;
