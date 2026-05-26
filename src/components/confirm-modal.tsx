import { useEffect, useState } from 'react';
import type { ConfirmationRequest } from '../agent/security/confirmation-gate';

/**
 * Renders a modal whenever the agent host requests confirmation for a
 * sensitive action. Mounted near the root so any active view (mods, build,
 * monitor) gets the prompt, and so an in-flight request survives a tab
 * switch.
 *
 * The modal prefers showing the *fixed* per-tool summary written by the
 * tool wrapper rather than free-form LLM text, because the ask is whether
 * the user wants this thing to happen — not whether the agent's narration
 * sounds reasonable.
 */
export function ConfirmModal() {
  // FIFO queue. The agent fires parallel tool calls (e.g. two `bash`s in one
  // turn); each one independently awaits its own approval. Without a queue,
  // the second incoming request would clobber the first in state and its
  // promise would stall forever, hanging the conversation.
  const [queue, setQueue] = useState<ConfirmationRequest[]>([]);
  const [alwaysAllow, setAlwaysAllow] = useState(false);
  const request = queue[0] ?? null;

  useEffect(() => {
    return window.modmixer.onConfirmRequest((req) => {
      setQueue((q) => [...q, req]);
    });
  }, []);

  useEffect(() => {
    setAlwaysAllow(false);
  }, [request?.id]);

  if (!request) return null;

  const respond = (approved: boolean) => {
    window.modmixer.resolveConfirm(request.id, approved, approved && alwaysAllow);
    setQueue((q) => q.slice(1));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-md border border-line bg-paper shadow-lg">
        <div className="border-b border-line px-4 py-3">
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
            modmixer · confirmation needed
          </div>
          <div className="mt-1 text-sm font-medium text-ink">{request.label}</div>
        </div>
        <div className="space-y-3 px-4 py-3 text-sm text-ink">
          <p>{request.summary}</p>
          {Object.keys(request.paramPreview).length > 0 && (
            <div className="rounded border border-line bg-surface/40 p-2 font-mono text-[11px] text-muted">
              {Object.entries(request.paramPreview).map(([k, v]) => (
                <div key={k} className="flex gap-2">
                  <span className="text-subtle">{k}</span>
                  <span className="break-all text-ink">{v}</span>
                </div>
              ))}
            </div>
          )}
          <label className="flex items-center gap-2 text-xs text-muted">
            <input
              type="checkbox"
              checked={alwaysAllow}
              onChange={(e) => setAlwaysAllow(e.target.checked)}
              className="h-3 w-3"
            />
            Always allow this exact action for the rest of this session
          </label>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-3">
          <button
            onClick={() => respond(false)}
            className="rounded-md border border-line bg-paper px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-ink transition-colors hover:border-ink/40"
          >
            Deny
          </button>
          <button
            onClick={() => respond(true)}
            className="rounded-md bg-accent px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-accent-foreground shadow-sm transition-opacity hover:bg-accent-soft"
          >
            Approve
          </button>
        </div>
      </div>
    </div>
  );
}
