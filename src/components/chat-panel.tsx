import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { MixerThinkingLevel as ThinkingLevel } from '../lib/thinking-levels';
import type { Conversation } from '../agent/conversations';
import type { WorkspaceMod } from '../agent/workspace';
import type { ModelOption } from '../agent/models';
import type { ModelSelection } from '../agent/settings';
import { cn } from '@/lib/cn';
import {
  extractImages,
  extractText,
  extractThinking,
  extractToolCalls,
} from '@/lib/agent-utils';
import { useAsyncAction } from '@/lib/use-async-action';
import { useScrollPin } from '@/lib/use-scroll-pin';
import {
  useConversationRuntime,
  usePanelState,
  setPanelDraft,
  setPanelModel,
  setPanelThinking,
  addPanelAttachments,
  removePanelAttachment,
  clearPanelAttachments,
  markIdle,
  restorePanelDraft,
  isConversationBusy,
} from '../conversations-store';
import type {
  AttachmentInput,
  PreparedAttachment,
} from '../agent/attachments/types';
import { Markdown } from './markdown';
import { ModelPicker } from './model-picker';
import { ThinkingPicker } from './thinking-picker';
import { ToolResultBubble } from './tool-result-renderer';

type ToolStatus = 'running' | 'done' | 'error';

/**
 * pi-ai stamps every assistant message with a `provider`/`usage.cost.total`
 * pair. We only surface the dollar figure for OpenRouter — Anthropic OAuth
 * users would see a *list-price* number that doesn't match what they
 * actually pay against Pro/Max credits, which would be misleading.
 */
function openrouterCost(message: AgentMessage): number | null {
  if (message.role !== 'assistant') return null;
  const m = message as { provider?: string; usage?: { cost?: { total?: number } } };
  if (m.provider !== 'openrouter') return null;
  const total = m.usage?.cost?.total;
  return typeof total === 'number' && total > 0 ? total : null;
}

function formatCost(cost: number): string {
  // Sub-cent costs need four decimals to be informative; once we cross a
  // dollar, two decimals match the way users think about money.
  if (cost >= 1) return `$${cost.toFixed(2)}`;
  return `$${cost.toFixed(4)}`;
}

// Mirrors pi-coding-agent's footer formatting: 999, 9.9k, 99k, 9.9M.
function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

// A failed turn's errorMessage is provider-shaped: Anthropic/OpenAI hand back a
// JSON envelope ({"error":{"type","message"}}), others a plain Error string.
// Pull out the human-readable bit, falling back to the raw text.
function formatAgentError(raw: string | undefined): string {
  if (!raw) return 'The model failed to respond.';
  try {
    const parsed = JSON.parse(raw) as {
      error?: { type?: string; message?: string };
      message?: string;
      type?: string;
    };
    const err = parsed.error ?? parsed;
    if (typeof err.message === 'string' && err.message.trim()) {
      return err.message.trim();
    }
    if (typeof err.type === 'string' && err.type.trim()) return err.type.trim();
  } catch {
    // Not JSON — the raw string is already the message.
  }
  return raw;
}

/**
 * Humanized message timestamp, revealed on hover. Anchored to calendar days
 * (not elapsed hours) so a message from 11pm reads "Yesterday" the next
 * morning. Within the past week it names the weekday; older falls back to a
 * dated label.
 *   Today at 6:32 · Yesterday at 6:32 · Monday at 6:32 · Sun Jun 3 at 6:32
 */
function formatMessageTime(ts: number): string {
  const d = new Date(ts);
  const h = d.getHours() % 12 || 12;
  const time = `${h}:${String(d.getMinutes()).padStart(2, '0')}`;

  const startOfDay = (x: Date) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86_400_000);

  let label: string;
  if (dayDiff <= 0) label = 'Today';
  else if (dayDiff === 1) label = 'Yesterday';
  else if (dayDiff < 7) label = d.toLocaleDateString(undefined, { weekday: 'long' });
  else {
    const weekday = d.toLocaleDateString(undefined, { weekday: 'short' });
    const month = d.toLocaleDateString(undefined, { month: 'short' });
    label = `${weekday} ${month} ${d.getDate()}`;
  }
  return `${label} at ${time}`;
}

/**
 * Per-character digit roll. Each glyph is rendered with a key derived
 * from its position + value, so digits that *didn't* change keep their
 * DOM node (no animation) while digits that flipped get re-mounted and
 * animate in. Skipping the first render avoids a noisy roll on initial
 * paint when the number was already there.
 */
function OdometerNumber({
  value,
  format,
  className,
}: {
  value: number;
  format: (n: number) => string;
  className?: string;
}) {
  const text = format(value);
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
  }, []);
  return (
    <span className={cn('inline-flex tabular-nums', className)}>
      {Array.from(text).map((ch, i) => (
        <span
          // eslint-disable-next-line react/no-array-index-key
          key={`${i}-${ch}`}
          className={cn('inline-block', mountedRef.current && 'juicy-roll')}
        >
          {ch === ' ' ? ' ' : ch}
        </span>
      ))}
    </span>
  );
}

export function ChatPanel({
  conversation,
  activeMod,
  hasAi,
  availableModels,
  onConnect,
}: {
  conversation: Conversation;
  activeMod: WorkspaceMod | null;
  hasAi: boolean;
  availableModels: ModelOption[];
  onConnect: () => void;
}) {
  // A mod-scoped chat whose mod still has an empty packageId is the untitled
  // "+ new mod" placeholder — not yet named — so the UX should still read like
  // a fresh-idea conversation, not an edit-this-mod one. Mirrors the system
  // prompt's isUntitledPlaceholder check.
  const effectiveScope: 'mod' | 'new' =
    conversation.scope.type === 'mod' &&
    activeMod &&
    activeMod.folder === conversation.scope.modFolder &&
    activeMod.about.packageId.trim() === ''
      ? 'new'
      : conversation.scope.type;
  const { messages, streaming, toolStates, busy, compacting, loading } =
    useConversationRuntime(conversation.id);
  // Draft message + model/reasoning are per-chat and live in the conversation
  // store, not local component state — so they survive this panel unmounting
  // when the user switches to another chat (or mod) and back. The store entry
  // is seeded when the tab opens (App). `draft` is renderer-only; a
  // model/thinking change also persists to conversations.json via IPC.
  const { draft, model, thinkingLevel, attachments } = usePanelState(
    conversation.id,
  );
  // Switching model is optimistic: the toolbar updates immediately, then we
  // persist via IPC. If the session rejects it (e.g. the picked model's
  // provider has no API key) we roll the toolbar back so it doesn't show a
  // model the chat isn't actually on, and surface the reason. Previously the
  // rejection escaped as an unhandled promise rejection — Sentry
  // MODMIXERAPP-D/F/H/J/K.
  const modelChange = useAsyncAction(
    async (selection: ModelSelection, previous: ModelSelection | null) => {
      setPanelModel(conversation.id, selection);
      try {
        await window.modmixer.setConversationModel(conversation.id, selection);
      } catch (err) {
        setPanelModel(conversation.id, previous);
        const raw = err instanceof Error ? err.message : String(err);
        throw new Error(
          /no api key/i.test(raw)
            ? "Can't switch to that model — its provider isn't connected. Link it under Connect first."
            : raw,
        );
      }
    },
  );
  const changeModel = (selection: ModelSelection) => {
    void modelChange.run(selection, model);
  };
  const changeThinking = (level: ThinkingLevel) => {
    setPanelThinking(conversation.id, level);
    void window.modmixer.setConversationThinkingLevel(conversation.id, level);
  };
  const send = useAsyncAction((text: string, atts: PreparedAttachment[]) =>
    window.modmixer.send(
      conversation.id,
      text,
      atts.length > 0 ? atts : undefined,
    ),
  );
  const interruptAction = useAsyncAction(() =>
    window.modmixer.interrupt(conversation.id),
  );
  const retryAction = useAsyncAction(() =>
    window.modmixer.retry(conversation.id),
  );
  const runRetry = retryAction.run;
  // Stable identity — MessageBubble is memoized on this prop. The busy check
  // reads the store non-reactively so a stale click (turn already restarted)
  // is a no-op; the main process guards again on its side.
  const retry = useCallback(async () => {
    if (isConversationBusy(conversation.id)) return;
    const result = await runRetry();
    if (result === null) markIdle(conversation.id);
  }, [conversation.id, runRetry]);
  const error =
    send.error ?? interruptAction.error ?? modelChange.error ?? retryAction.error;
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // The streaming assistant message is appended as the last row so it
  // scrolls and measures like any other.
  const visible = useMemo(
    () => (streaming ? [...messages, streaming] : messages),
    [messages, streaming],
  );
  // Virtualized message list: only the visible window of bubbles is
  // rendered + markdown-parsed, so mounting a long transcript (opening a
  // mod, switching tabs) costs a handful of renders instead of all N.
  const rowVirtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: visible.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 140,
    overscan: 6,
  });
  const scrollToEnd = useCallback(
    (smooth: boolean) => {
      const count = rowVirtualizer.options.count;
      if (count === 0) return;
      rowVirtualizer.scrollToIndex(count - 1, {
        align: 'end',
        behavior: smooth ? 'smooth' : 'auto',
      });
    },
    [rowVirtualizer],
  );
  // A settled live turn always ends with an assistant message (stop / error /
  // aborted — even Stop mid-tool appends a final aborted one), so an idle
  // transcript ending in user/toolResult — or in an assistant message still
  // waiting on its tool results — can only mean the app died mid-turn.
  // Offer to pick the turn back up.
  const lastMessage = visible.length > 0 ? visible[visible.length - 1] : null;
  const interrupted =
    !busy &&
    !streaming &&
    !loading &&
    lastMessage != null &&
    (lastMessage.role === 'user' ||
      lastMessage.role === 'toolResult' ||
      (lastMessage.role === 'assistant' &&
        lastMessage.stopReason === 'toolUse'));

  const { pinned, hasNewBelow, jumpToBottom } = useScrollPin(
    scrollRef,
    [visible.length, streaming, toolStates, compacting],
    { scrollToEnd },
  );

  const submit = async () => {
    const text = draft.trim();
    if ((!text && attachments.length === 0) || busy || loading) return;
    const staged = attachments;
    setPanelDraft(conversation.id, '');
    clearPanelAttachments(conversation.id);
    // Demo-video replay (dev-only seam, see demo-hooks.ts): the harness
    // swallows the send and feeds recorded agent events instead.
    if (import.meta.env.DEV && window.__demo?.consumeSend(conversation.id, text))
      return;
    const result = await send.run(text, staged);
    // null = the IPC threw before any agent_end event would clear busy. A
    // rejection this early never reached the transcript, so put the text and
    // attachments back — pressing Send again is the retry.
    if (result === null) {
      markIdle(conversation.id);
      restorePanelDraft(conversation.id, text);
      addPanelAttachments(conversation.id, staged);
    }
  };

  const interrupt = async () => {
    if (!busy) return;
    await interruptAction.run();
  };

  // Attachment ingestion: drag-drop, paste, and the browse button all funnel
  // here. A File with a real path (drag/browse/Explorer-copy) is sent as a
  // path; a pasted clipboard bitmap has no path, so its bytes go instead.
  const ingestFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      const inputs: AttachmentInput[] = [];
      for (const file of files) {
        const filePath = window.modmixer.getPathForFile(file);
        if (filePath) {
          inputs.push({ kind: 'path', path: filePath });
        } else {
          inputs.push({
            kind: 'bytes',
            name: file.name || 'pasted-image.png',
            mimeType: file.type || 'image/png',
            bytes: new Uint8Array(await file.arrayBuffer()),
          });
        }
      }
      const prepared = await window.modmixer.prepareAttachments(inputs);
      addPanelAttachments(conversation.id, prepared);
    },
    [conversation.id],
  );

  const [dragging, setDragging] = useState(false);
  const onDragOver = (e: DragEvent) => {
    if (!hasAi) return;
    if (!Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
    setDragging(true);
  };
  const onDragLeave = (e: DragEvent) => {
    // A leave into a descendant isn't really leaving the panel.
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDragging(false);
  };
  const onDrop = (e: DragEvent) => {
    setDragging(false);
    if (!hasAi) return;
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    e.preventDefault();
    void ingestFiles(files);
  };
  const browseAttachments = async () => {
    addPanelAttachments(conversation.id, await window.modmixer.pickAttachments());
  };

  // Warn when image attachments are staged but the active model can't see
  // images — otherwise the agent silently can't view them (and may bluff a
  // description). `vision === false` only; `undefined` means unknown → no warn.
  const activeModelOption = useMemo(
    () =>
      availableModels.find(
        (o) =>
          model != null &&
          o.provider === model.provider &&
          o.modelId === model.modelId,
      ),
    [availableModels, model],
  );
  const imageAttachmentsBlocked =
    activeModelOption?.vision === false &&
    attachments.some((a) => a.isImage);

  // Esc cancels the in-flight turn. Skipped while typing in inputs/textareas
  // (so Esc still does its usual thing in the editor) — only fires when focus
  // is outside an editable element.
  useEffect(() => {
    if (!busy) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        target?.isContentEditable
      ) {
        return;
      }
      e.preventDefault();
      void interrupt();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy]);

  // One pass over visible builds the toolCallId → args map so each toolResult
  // bubble doesn't have to do an O(N) backward scan. Returning the same
  // `arguments` object reference across renders also keeps memo'd
  // MessageBubble props stable for completed tool results.
  const toolCallArgsById = useMemo(() => {
    const map = new Map<string, Record<string, unknown>>();
    for (const m of visible) {
      if (m.role !== 'assistant') continue;
      for (const c of extractToolCalls(m.content)) {
        if (!map.has(c.id)) map.set(c.id, c.arguments);
      }
    }
    return map;
  }, [visible]);

  // Running OpenRouter total for this chat. Only completed messages count —
  // the streaming partial doesn't have final usage yet.
  const chatCost = useMemo(() => {
    let sum = 0;
    for (const m of messages) {
      const c = openrouterCost(m);
      if (c) sum += c;
    }
    return sum;
  }, [messages]);

  // True once the chat contains an assistant turn from a provider we can't
  // price (e.g. Claude via Anthropic OAuth, billed against Pro/Max credits).
  // When that happens `chatCost` only covers *part* of the chat, so showing
  // it — or the OpenRouter balance — would be misleading. Hide both.
  const hasUncostableTurns = useMemo(
    () =>
      messages.some((m) => {
        if (m.role !== 'assistant') return false;
        const provider = (m as { provider?: string }).provider;
        return typeof provider === 'string' && provider !== 'openrouter';
      }),
    [messages],
  );

  // Live OpenRouter balance. null = no API key configured, or active model
  // isn't routed through OpenRouter (hide); a number = remaining USD.
  // Refreshed on mount and after each completed turn.
  const [balance, setBalance] = useState<number | null>(null);
  const isOpenRouter = model?.provider === 'openrouter';
  // Live context-window usage from pi (`AgentSession.getContextUsage()`).
  // Updates every turn as the assistant's `usage` lands.
  const [contextUsage, setContextUsage] = useState<{
    tokens: number | null;
    contextWindow: number;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    const refreshBalance = () => {
      if (!isOpenRouter) {
        setBalance(null);
        return;
      }
      window.modmixer
        .getOpenRouterCredits()
        .then((c) => {
          if (cancelled) return;
          setBalance(c?.remaining ?? null);
        })
        .catch(() => {
          // Network/auth errors are non-fatal — leave the prior value alone.
        });
    };
    const refreshContext = () => {
      window.modmixer
        .getContextUsage(conversation.id)
        .then((u) => {
          if (cancelled) return;
          setContextUsage(
            u ? { tokens: u.tokens, contextWindow: u.contextWindow } : null,
          );
        })
        .catch(() => {});
    };
    refreshBalance();
    refreshContext();
    const off = window.modmixer.onEvent((env) => {
      if (env.conversationId !== conversation.id) return;
      // Context usage updates after every message (tool results land as their
      // own messages, so the chip steps up mid-turn instead of waiting).
      if (env.event.type === 'message_end' || env.event.type === 'agent_end') {
        refreshContext();
      }
      // Balance only refreshes once per turn — avoid hammering the credits
      // endpoint on every tool result.
      if (env.event.type === 'agent_end') refreshBalance();
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [conversation.id, isOpenRouter]);

  const showCost = chatCost > 0 && !hasUncostableTurns;
  const showBalance = balance !== null && !hasUncostableTurns;

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      onDragEnter={onDragOver}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center border-2 border-dashed border-accent bg-paper/80">
          <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-accent">
            Drop files to attach
          </span>
        </div>
      )}
      <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        className="absolute inset-0 overflow-auto px-6 py-4"
      >
        {loading ? (
          <ChatLoading />
        ) : visible.length === 0 ? (
          <ScopeEmptyState scope={effectiveScope} />
        ) : (
          <div
            className="relative w-full"
            style={{ height: rowVirtualizer.getTotalSize() }}
          >
            {rowVirtualizer.getVirtualItems().map((vi) => {
              const m = visible[vi.index];
              return (
                <div
                  key={vi.key}
                  data-index={vi.index}
                  ref={rowVirtualizer.measureElement}
                  className="absolute left-0 top-0 w-full pb-3"
                  style={{ transform: `translateY(${vi.start}px)` }}
                >
                  <MessageBubble
                    message={m}
                    toolStates={toolStates}
                    toolCallArgs={
                      m.role === 'toolResult'
                        ? toolCallArgsById.get(m.toolCallId)
                        : undefined
                    }
                    isStreaming={
                      streaming != null && vi.index === visible.length - 1
                    }
                    onRetry={
                      !busy &&
                      !streaming &&
                      !retryAction.busy &&
                      vi.index === visible.length - 1 &&
                      m.role === 'assistant' &&
                      m.stopReason === 'error'
                        ? retry
                        : undefined
                    }
                    // Stays on through the dead air between pressing Retry
                    // and the model's first token — the row stops being last
                    // (and this flips off) once the new message streams in.
                    retrying={
                      (busy || retryAction.busy) &&
                      vi.index === visible.length - 1 &&
                      m.role === 'assistant' &&
                      m.stopReason === 'error'
                    }
                  />
                </div>
              );
            })}
          </div>
        )}
        {compacting && (
          <div className="juicy-shimmer-bar mt-3 rounded-md border border-line bg-paper/70 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
            compacting context…
          </div>
        )}
        {error && (
          <div className="mt-3 rounded-md border border-failed/40 bg-failed/5 px-3 py-2 text-xs text-failed">
            {error}
          </div>
        )}
        {interrupted && (
          <div className="mt-3 flex items-center justify-between gap-3 rounded-md border border-line bg-paper/70 px-3 py-2 text-xs text-muted">
            <span>This chat was interrupted before the agent finished.</span>
            {retryAction.busy ? (
              <span className="inline-flex shrink-0 items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-subtle">
                <span className="juicy-bounce-dot inline-block h-1 w-1 rounded-full bg-pending" />
                resuming…
              </span>
            ) : (
              <button
                onClick={() => void retry()}
                className="inline-flex shrink-0 items-center rounded-md border border-line px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-ink transition-colors hover:border-ink/40 hover:bg-surface"
              >
                Resume
              </button>
            )}
          </div>
        )}
      </div>
      {!pinned && hasNewBelow && (
        <button
          onClick={jumpToBottom}
          className="juicy-bubble-in absolute left-1/2 bottom-3 z-10 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-accent/60 bg-paper px-3 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-accent shadow-md transition-colors hover:bg-surface hover:text-ink"
        >
          <span className="juicy-bounce-dot inline-block h-1.5 w-1.5 rounded-full bg-accent" />
          <span>New messages</span>
          <DownArrowIcon />
        </button>
      )}
      </div>
      <div className="border-t border-line px-6 py-3">
        {hasAi && (
          // This chat's model + reasoning toolbar on the left, live
          // telemetry on the right. Per-conversation: changing these here
          // only affects this chat.
          <div className="mb-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
            <div className="flex items-center gap-1.5">
              <ModelPicker
                models={availableModels}
                current={model}
                onChange={changeModel}
                onConnect={onConnect}
              />
              <ThinkingPicker current={thinkingLevel} onChange={changeThinking} />
            </div>
            {(showCost || showBalance || contextUsage) && (
              <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1 font-mono text-[11px] text-subtle">
                {contextUsage && contextUsage.tokens !== null && (() => {
                  // Color escalates as the context window fills up — at >95%
                  // the next turn is about to compact, so we want the user
                  // to *notice*.
                  const ratio =
                    contextUsage.tokens / contextUsage.contextWindow;
                  const cls =
                    ratio >= 0.95
                      ? 'text-failed'
                      : ratio >= 0.8
                        ? 'text-accent'
                        : '';
                  return (
                    <span className={cn('inline-flex items-center gap-1', cls)}>
                      context ={' '}
                      <OdometerNumber
                        value={contextUsage.tokens}
                        format={formatTokens}
                      />
                      /{formatTokens(contextUsage.contextWindow)}
                    </span>
                  );
                })()}
                {showCost && (
                  <span className="inline-flex items-center gap-1">
                    chat cost ={' '}
                    <OdometerNumber value={chatCost} format={formatCost} />
                  </span>
                )}
                {showBalance && (
                  <span className="inline-flex items-center gap-1">
                    balance ={' '}
                    <OdometerNumber value={balance!} format={formatCost} />
                  </span>
                )}
              </div>
            )}
          </div>
        )}
        {hasAi ? (
          <div className="rounded-md border border-line bg-paper p-3 focus-within:border-ink/40">
            {attachments.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-1.5">
                {attachments.map((a) => (
                  <AttachmentChip
                    key={a.id}
                    attachment={a}
                    onRemove={() =>
                      removePanelAttachment(conversation.id, a.id)
                    }
                  />
                ))}
              </div>
            )}
            {imageAttachmentsBlocked && (
              <div className="mb-2 rounded border border-accent/40 bg-accent/10 px-2 py-1 text-[11px] text-accent">
                {activeModelOption?.label ?? 'This model'} can’t see images —
                switch to a vision-capable model or the agent won’t be able to
                view your screenshots.
              </div>
            )}
            <textarea
              data-demo="chat-input"
              value={draft}
              onChange={(e) => setPanelDraft(conversation.id, e.target.value)}
              onPaste={(e) => {
                const files = Array.from(e.clipboardData.files);
                if (files.length === 0) return;
                e.preventDefault();
                void ingestFiles(files);
              }}
              onKeyDown={(e) => {
                if (
                  e.key === 'Enter' &&
                  !e.shiftKey &&
                  !e.metaKey &&
                  !e.ctrlKey
                ) {
                  e.preventDefault();
                  void submit();
                  return;
                }
                if (e.key === 'Escape' && busy) {
                  e.preventDefault();
                  void interrupt();
                }
              }}
              placeholder={
                loading ? 'Loading chat…' : placeholderForScope(effectiveScope)
              }
              disabled={loading}
              // Auto-grow with content (Chromium 123+); bounded so a long
              // message doesn't push the chat scroll out of view.
              className="block min-h-[1.75rem] max-h-40 w-full resize-none bg-transparent text-sm text-ink placeholder:text-subtle focus:outline-none disabled:opacity-60 [field-sizing:content]"
              rows={1}
            />
            <div className="mt-2 flex items-center justify-end gap-2">
              <button
                onClick={() => void browseAttachments()}
                title="Attach files"
                aria-label="Attach files"
                className="mr-auto inline-flex items-center rounded-md border border-line p-1.5 text-subtle transition-colors hover:border-ink/40 hover:text-ink"
              >
                <PaperclipIcon />
              </button>
              {busy && (
                <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-subtle">
                  esc to stop
                </span>
              )}
              {busy ? (
                <button
                  onClick={() => void interrupt()}
                  className="group inline-flex items-center gap-2 rounded-md border border-failed/50 bg-failed/10 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.18em] text-failed shadow-sm transition-all hover:bg-failed/20 active:translate-y-px"
                >
                  Stop
                  <StopIcon />
                </button>
              ) : (
                // Always rendered (just invisible when empty) so the
                // textarea container doesn't grow the moment the user
                // types the first character.
                <button
                  data-demo="chat-send"
                  onClick={() => void submit()}
                  aria-hidden={
                    (!draft.trim() && attachments.length === 0) || undefined
                  }
                  tabIndex={draft.trim() || attachments.length > 0 ? 0 : -1}
                  className={cn(
                    'group inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 font-mono text-[11px] uppercase tracking-[0.18em] text-accent-foreground shadow-sm transition-all hover:bg-accent-soft hover:shadow-md active:translate-y-px',
                    !draft.trim() && attachments.length === 0 && 'invisible',
                  )}
                >
                  Send
                  <SendIcon />
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3 rounded-md border border-line bg-paper/70 px-3 py-3 text-sm text-ink">
            <span>
              Connect an AI provider to chat with the agent.
            </span>
            <button
              onClick={onConnect}
              className="rounded-md bg-accent px-3 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-accent-foreground transition-opacity hover:bg-accent-soft"
            >
              Connect AI
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function SendIcon() {
  return (
    <svg
      aria-hidden
      className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
      viewBox="0 0 24 24"
      fill="currentColor"
    >
      <path d="M3 11.5 21 3l-8.5 18-2.2-7.3L3 11.5z" />
    </svg>
  );
}

function DownArrowIcon() {
  return (
    <svg
      aria-hidden
      className="h-3 w-3"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 5v14" />
      <path d="m6 13 6 6 6-6" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg
      aria-hidden
      className="h-3 w-3"
      viewBox="0 0 24 24"
      fill="currentColor"
    >
      <rect x="6" y="6" width="12" height="12" rx="1" />
    </svg>
  );
}

function PaperclipIcon() {
  return (
    <svg
      aria-hidden
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21.44 11.05 12.25 20.24a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg
      aria-hidden
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 5h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg
      aria-hidden
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14 3v5h5" />
      <path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z" />
    </svg>
  );
}

function RemoveIcon() {
  return (
    <svg
      aria-hidden
      className="h-3 w-3"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
    >
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

/** A single staged attachment: image thumbnail or type icon, name, remove. */
function AttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: PreparedAttachment;
  onRemove: () => void;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded border border-line bg-surface py-1 pl-1 pr-1.5 text-xs text-ink">
      {attachment.previewDataUrl ? (
        <img
          src={attachment.previewDataUrl}
          alt=""
          className="h-6 w-6 rounded-sm object-cover"
        />
      ) : (
        <span className="flex h-6 w-6 items-center justify-center text-subtle">
          {attachment.isDirectory ? <FolderIcon /> : <FileIcon />}
        </span>
      )}
      <span className="max-w-[10rem] truncate">{attachment.name}</span>
      <button
        onClick={onRemove}
        aria-label={`Remove ${attachment.name}`}
        className="text-subtle transition-colors hover:text-failed"
      >
        <RemoveIcon />
      </button>
    </span>
  );
}

function placeholderForScope(type: 'mod' | 'new'): string {
  if (type === 'new') return 'Describe the mod you want to create…';
  return 'Tell the agent what to change in this mod…';
}

function ScopeEmptyState({ scope }: { scope: 'mod' | 'new' }) {
  const text =
    scope === 'new'
      ? "What's your mod idea?"
      : 'Tell me what to add or fix in this mod. I have read/write/edit/build/launch tools.';
  return (
    <div className="rounded-md border border-line bg-paper/70 p-3 text-sm text-ink">
      <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
        modmixer · idle
      </div>
      {text}
    </div>
  );
}

function ChatLoading() {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-subtle">
        <span className="inline-flex items-end gap-0.5">
          {[0, 140, 280].map((delay) => (
            <span
              key={delay}
              className="juicy-bounce-dot inline-block h-1 w-1 rounded-full bg-pending"
              style={{ animationDelay: `${delay}ms` }}
            />
          ))}
        </span>
        <span>loading chat…</span>
      </div>
    </div>
  );
}

function CopyIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      className={className ?? 'h-3.5 w-3.5'}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CopiedIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      className={className ?? 'h-3.5 w-3.5'}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

/**
 * Discrete copy-to-clipboard control for a message. Hidden until the message
 * is hovered (the caller supplies the `group-hover` reveal classes) and flips
 * to a check mark for a beat after a successful copy.
 */
function CopyButton({
  text,
  className,
  iconClassName,
}: {
  text: string;
  className?: string;
  iconClassName?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be denied; nothing useful to do but skip feedback.
    }
  }, [text]);
  return (
    <button
      type="button"
      onClick={copy}
      title={copied ? 'Copied' : 'Copy message'}
      aria-label={copied ? 'Copied' : 'Copy message'}
      className={cn(
        'rounded p-1 text-subtle transition-colors hover:text-ink',
        className,
      )}
    >
      {copied ? (
        <CopiedIcon className={iconClassName} />
      ) : (
        <CopyIcon className={iconClassName} />
      )}
    </button>
  );
}

/**
 * Humanized send time for a message, revealed on hover alongside the copy
 * control (the caller's container supplies the `group` for the reveal). The
 * full localized timestamp is tucked into the tooltip for precision.
 */
function MessageTime({ ts, className }: { ts: number; className?: string }) {
  return (
    <span
      title={new Date(ts).toLocaleString()}
      className={cn(
        'shrink-0 select-none whitespace-nowrap text-[11px] tabular-nums text-subtle opacity-0 transition-opacity group-hover:opacity-100',
        className,
      )}
    >
      {formatMessageTime(ts)}
    </span>
  );
}

type MessageBubbleProps = {
  message: AgentMessage;
  toolStates: Record<string, { name: string; status: ToolStatus }>;
  toolCallArgs?: Record<string, unknown>;
  isStreaming: boolean;
  /** Set only on the last message when it's a retryable error row. */
  onRetry?: () => void;
  /** True while a retry of this error row is in flight (no new tokens yet). */
  retrying?: boolean;
};

const MessageBubble = memo(MessageBubbleImpl, (prev, next) => {
  if (
    prev.message !== next.message ||
    prev.isStreaming !== next.isStreaming ||
    prev.toolCallArgs !== next.toolCallArgs ||
    prev.onRetry !== next.onRetry ||
    prev.retrying !== next.retrying
  ) {
    return false;
  }
  // toolStates is rebuilt on every tool event. Only re-render this bubble
  // if a status this message actually cares about changed.
  if (prev.toolStates === next.toolStates) return true;
  if (prev.message.role !== 'assistant') return true;
  for (const c of extractToolCalls(prev.message.content)) {
    if (prev.toolStates[c.id]?.status !== next.toolStates[c.id]?.status) {
      return false;
    }
  }
  return true;
});

function MessageBubbleImpl({
  message,
  toolStates,
  toolCallArgs,
  isStreaming,
  onRetry,
  retrying,
}: MessageBubbleProps) {
  if (message.role === 'user') {
    const text = extractText(message.content);
    const images = extractImages(message.content);
    return (
      <div className="group flex items-center justify-end gap-1">
        <MessageTime ts={message.timestamp} />
        {text && (
          <CopyButton
            text={text}
            className="shrink-0 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
          />
        )}
        <div className="max-w-[88%] rounded-md bg-ink/90 px-3 py-2 text-sm text-paper">
          {images.length > 0 && (
            <div className="mb-1.5 flex flex-wrap gap-1.5">
              {images.map((img, i) => (
                <img
                  // eslint-disable-next-line react/no-array-index-key
                  key={i}
                  src={`data:${img.mimeType};base64,${img.data}`}
                  alt=""
                  className="max-h-40 rounded border border-paper/20"
                />
              ))}
            </div>
          )}
          {text && <div className="whitespace-pre-wrap">{text}</div>}
        </div>
      </div>
    );
  }

  if (message.role === 'assistant') {
    const text = extractText(message.content);
    const toolCalls = extractToolCalls(message.content);
    // A turn that ended in a provider error (e.g. 529 overloaded). Auto-retry
    // is off, so this is terminal: we render it as an error row whose Retry
    // button re-runs the turn. Partial content (text/tools streamed before
    // the failure) is still shown above the error note.
    const isError = message.stopReason === 'error';
    const hasContent = !!text || toolCalls.length > 0;
    // Reasoning models (Opus, Fable, Kimi, DeepSeek…) stream a readable
    // "thinking" summary ahead of their answer. We tuck it behind a
    // disclosure above the reply.
    const thinking = extractThinking(message.content);
    const hasThinking = !!thinking;
    // A finished turn that produced only reasoning — no answer text, no tools.
    // Some models (e.g. Kimi K2.6 via OpenRouter) ignore reasoning=none and
    // reply entirely inside a thinking block; that block IS the answer, so we
    // render it as the body rather than hiding it behind the disclosure.
    const thinkingIsReply = hasThinking && !hasContent && !isStreaming;
    // Mid-turn, with reasoning streaming in ahead of any answer text. Show it
    // live (auto-expanded) so the wait isn't dead air.
    const liveThinking = hasThinking && !hasContent && isStreaming;
    const showSpinner = !hasContent && !hasThinking && isStreaming;
    const copyText = text || thinking;
    // Slugs like "moonshotai/kimi-k2.6" or "accounts/fireworks/models/kimi-k2p6"
    // — only the tail is meaningful in the bubble header.
    const modelLabel = message.model.split('/').pop() || message.model;
    const cost = !isStreaming ? openrouterCost(message) : null;
    return (
      <div
        data-demo="assistant-msg"
        className={cn(
          'group rounded-md border p-3',
          isError ? 'border-failed/40 bg-failed/5' : 'border-line bg-paper/70',
          // The streaming bubble draws a rotating accent arc around its
          // border so the user can spot the live one at a glance.
          isStreaming && 'juicy-trace',
        )}
      >
        <div className="mb-1 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
          <span>
            modmixer <span className="text-subtle">·</span> {modelLabel}
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            {cost !== null && (
              <span className="text-[10px] normal-case tracking-normal text-subtle opacity-0 transition-opacity group-hover:opacity-100">
                {formatCost(cost)}
              </span>
            )}
            <MessageTime
              ts={message.timestamp}
              className="text-[10px] normal-case tracking-normal"
            />
            {copyText && !isStreaming && (
              <CopyButton
                text={copyText}
                iconClassName="h-3 w-3"
                className="-my-1 shrink-0 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
              />
            )}
          </div>
        </div>
        {hasThinking && !thinkingIsReply && (
          <ThinkingPanel thinking={thinking} live={liveThinking} />
        )}
        {text && <Markdown>{text}</Markdown>}
        {thinkingIsReply && (
          <div className="opacity-80">
            <Markdown>{thinking}</Markdown>
          </div>
        )}
        {showSpinner && <ThinkingIndicator />}
        {toolCalls.map((c) => (
          <ToolBadge
            key={c.id}
            name={c.name}
            args={c.arguments}
            status={toolStates[c.id]?.status ?? 'running'}
          />
        ))}
        {isError && (
          <AgentErrorNote
            raw={message.errorMessage}
            onRetry={onRetry}
            retrying={retrying}
          />
        )}
      </div>
    );
  }

  if (message.role === 'toolResult') {
    return <ToolResultBubble message={message} args={toolCallArgs} />;
  }

  if (message.role === 'compactionSummary') {
    return <CompactionDivider />;
  }

  return null;
}

function ChevronRightIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

/**
 * Collapsible reasoning summary shown above an assistant reply. Always starts
 * collapsed and stays that way until the user clicks — reasoning is opt-in, not
 * pushed. While the model is still reasoning ahead of its answer (`live`), the
 * header shows an animated THINKING… label; once the answer lands it settles to
 * THOUGHTS.
 */
function ThinkingPanel({ thinking, live }: { thinking: string; live: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-1.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em] text-subtle transition-colors hover:text-muted"
      >
        <ChevronRightIcon
          className={cn('h-3 w-3 transition-transform', open && 'rotate-90')}
        />
        {live ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-flex items-end gap-0.5">
              {[0, 140, 280].map((delay) => (
                <span
                  key={delay}
                  className="juicy-bounce-dot inline-block h-1 w-1 rounded-full bg-pending"
                  style={{ animationDelay: `${delay}ms` }}
                />
              ))}
            </span>
            <span>Thinking…</span>
          </span>
        ) : (
          <span>Thoughts</span>
        )}
      </button>
      {open && (
        <div className="mt-1 border-l-2 border-line pl-3 opacity-70">
          <Markdown>{thinking}</Markdown>
        </div>
      )}
    </div>
  );
}

function ThinkingIndicator() {
  return (
    <div className="flex items-center gap-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em] text-subtle">
      <span className="inline-flex items-end gap-0.5">
        {[0, 140, 280].map((delay) => (
          <span
            key={delay}
            className="juicy-bounce-dot inline-block h-1 w-1 rounded-full bg-pending"
            style={{ animationDelay: `${delay}ms` }}
          />
        ))}
      </span>
      <span>Thinking…</span>
    </div>
  );
}

// Shown in place of a blank bubble when a turn ends in a provider error.
// The last message's error row is actionable: its Retry button re-runs the
// turn (modmixer:agent:retry) and swaps to a "retrying…" pulse once pressed,
// so the dead air before the model's first token doesn't read as "nothing
// happened". Historical error rows show the bare error text.
function AgentErrorNote({
  raw,
  onRetry,
  retrying,
}: {
  raw: string | undefined;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  return (
    <div className="flex items-start gap-1.5 text-[13px] leading-snug text-failed">
      <span aria-hidden className="select-none">
        ⚠
      </span>
      <span>{formatAgentError(raw)}</span>
      {onRetry && (
        <button
          onClick={onRetry}
          className="ml-auto inline-flex shrink-0 items-center rounded-md border border-failed/50 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-failed transition-colors hover:bg-failed/10"
        >
          Retry
        </button>
      )}
      {retrying && (
        <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 self-center font-mono text-[10px] uppercase tracking-[0.18em] text-subtle">
          <span className="juicy-bounce-dot inline-block h-1 w-1 rounded-full bg-pending" />
          retrying…
        </span>
      )}
    </div>
  );
}

function CompactionDivider() {
  return (
    <div className="flex items-center gap-3 py-2 text-subtle">
      <div className="h-px flex-1 bg-line" />
      <span className="font-mono text-[10px] uppercase tracking-[0.18em]">
        context compacted
      </span>
      <div className="h-px flex-1 bg-line" />
    </div>
  );
}

function ToolBadge({
  name,
  args,
  status,
}: {
  name: string;
  args: Record<string, unknown>;
  status: ToolStatus;
}) {
  // Watch running→done / running→error transitions so we can flash the
  // badge once on completion. Mounting in a finished state (e.g. when
  // restoring a chat) must not trigger the flash, hence the prevStatus
  // ref starts at the initial status.
  const prevStatus = useRef<ToolStatus>(status);
  const [transition, setTransition] = useState<'success' | 'error' | null>(
    null,
  );
  useEffect(() => {
    if (prevStatus.current === 'running' && status === 'done') {
      setTransition('success');
    } else if (prevStatus.current === 'running' && status === 'error') {
      setTransition('error');
    }
    prevStatus.current = status;
  }, [status]);
  useEffect(() => {
    if (!transition) return;
    const t = setTimeout(() => setTransition(null), 800);
    return () => clearTimeout(t);
  }, [transition]);

  const label =
    status === 'running' ? 'running' : status === 'error' ? 'failed' : 'done';
  const dot =
    status === 'running'
      ? 'bg-pending animate-pulse'
      : status === 'error'
        ? 'bg-failed'
        : 'bg-ready';
  return (
    <div
      data-demo="tool-badge"
      className={cn(
        'mt-2 flex items-center gap-2 rounded border border-line bg-surface/60 px-2 py-1.5 font-mono text-[11px] text-muted',
        // Sliding shimmer says "this is actively running". It clears as
        // soon as the status flips to done/error.
        status === 'running' && 'juicy-shimmer-bar',
        transition === 'success' && 'juicy-flash-success',
        transition === 'error' && 'juicy-flash-error juicy-shake',
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', dot)} />
      <span className="text-ink">{name}</span>
      <span className="truncate text-subtle">{previewArgs(args)}</span>
      <span className="ml-auto uppercase tracking-[0.18em] text-subtle">
        {label}
      </span>
    </div>
  );
}

function previewArgs(args: Record<string, unknown>): string {
  // Show every arg as `key=value`, capping each value so one large field
  // (a file body, a long description) can't crowd out the others. The row's
  // CSS `truncate` then ellipsizes whatever still doesn't fit.
  const VALUE_CAP = 40;
  return Object.entries(args)
    .map(([k, v]) => {
      const raw = typeof v === 'string' ? v : JSON.stringify(v);
      const value =
        raw.length > VALUE_CAP ? `${raw.slice(0, VALUE_CAP)}…` : raw;
      return `${k}=${value}`;
    })
    .join(' ');
}
