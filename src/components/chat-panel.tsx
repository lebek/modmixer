import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { AgentMessage, ThinkingLevel } from '@mariozechner/pi-agent-core';
import type { Conversation } from '../agent/conversations';
import type { WorkspaceMod } from '../agent/workspace';
import type { ModelOption } from '../agent/models';
import type { ModelSelection } from '../agent/settings';
import { cn } from '@/lib/cn';
import { extractText, extractThinking, extractToolCalls } from '@/lib/agent-utils';
import { useAsyncAction } from '@/lib/use-async-action';
import { useScrollPin } from '@/lib/use-scroll-pin';
import {
  useConversationRuntime,
  usePanelState,
  setPanelDraft,
  setPanelModel,
  setPanelThinking,
  markIdle,
} from '../conversations-store';
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
  // A mod-scoped chat with an empty packageId is the renderer-created
  // placeholder from "+ new mod" — no scaffold_mod yet, so the UX should
  // still read like a fresh-idea conversation, not an edit-this-mod one.
  // Mirrors the system prompt's isUntitledPlaceholder check.
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
  const { draft, model, thinkingLevel } = usePanelState(conversation.id);
  const changeModel = (selection: ModelSelection) => {
    setPanelModel(conversation.id, selection);
    void window.modmixer.setConversationModel(conversation.id, selection);
  };
  const changeThinking = (level: ThinkingLevel) => {
    setPanelThinking(conversation.id, level);
    void window.modmixer.setConversationThinkingLevel(conversation.id, level);
  };
  const send = useAsyncAction((text: string) =>
    window.modmixer.send(conversation.id, text),
  );
  const interruptAction = useAsyncAction(() =>
    window.modmixer.interrupt(conversation.id),
  );
  const error = send.error ?? interruptAction.error;
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
  const { pinned, hasNewBelow, jumpToBottom } = useScrollPin(
    scrollRef,
    [visible.length, streaming, toolStates, compacting],
    { scrollToEnd },
  );

  const submit = async () => {
    const text = draft.trim();
    if (!text || busy || loading) return;
    setPanelDraft(conversation.id, '');
    const result = await send.run(text);
    // null = the IPC threw before any agent_end event would clear busy.
    if (result === null) markIdle(conversation.id);
  };

  const interrupt = async () => {
    if (!busy) return;
    await interruptAction.run();
  };

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
    <div className="flex min-h-0 flex-1 flex-col">
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
            <textarea
              value={draft}
              onChange={(e) => setPanelDraft(conversation.id, e.target.value)}
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
                  onClick={() => void submit()}
                  aria-hidden={!draft.trim() || undefined}
                  tabIndex={draft.trim() ? 0 : -1}
                  className={cn(
                    'group inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 font-mono text-[11px] uppercase tracking-[0.18em] text-accent-foreground shadow-sm transition-all hover:bg-accent-soft hover:shadow-md active:translate-y-px',
                    !draft.trim() && 'invisible',
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

type MessageBubbleProps = {
  message: AgentMessage;
  toolStates: Record<string, { name: string; status: ToolStatus }>;
  toolCallArgs?: Record<string, unknown>;
  isStreaming: boolean;
};

const MessageBubble = memo(MessageBubbleImpl, (prev, next) => {
  if (
    prev.message !== next.message ||
    prev.isStreaming !== next.isStreaming ||
    prev.toolCallArgs !== next.toolCallArgs
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
}: MessageBubbleProps) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[88%] whitespace-pre-wrap rounded-md bg-ink/90 px-3 py-2 text-sm text-paper">
          {extractText(message.content)}
        </div>
      </div>
    );
  }

  if (message.role === 'assistant') {
    const text = extractText(message.content);
    const toolCalls = extractToolCalls(message.content);
    const hasContent = !!text || toolCalls.length > 0;
    // Some models (e.g. Kimi K2.6 via OpenRouter) ignore reasoning=none and
    // return their entire answer inside a thinking block. Surface it instead
    // of leaving the bubble blank — but only when the turn is actually done,
    // since mid-stream a thinking-only state usually means text is still on
    // its way.
    const fallbackThinking =
      !hasContent && !isStreaming ? extractThinking(message.content) : '';
    const showSpinner = !hasContent && !fallbackThinking && isStreaming;
    // Slugs like "moonshotai/kimi-k2.6" or "accounts/fireworks/models/kimi-k2p6"
    // — only the tail is meaningful in the bubble header.
    const modelLabel = message.model.split('/').pop() || message.model;
    const cost = !isStreaming ? openrouterCost(message) : null;
    return (
      <div
        className={cn(
          'rounded-md border border-line bg-paper/70 p-3',
          // The streaming bubble draws a rotating accent arc around its
          // border so the user can spot the live one at a glance.
          isStreaming && 'juicy-trace',
        )}
      >
        <div className="mb-1 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
          <span>
            modmixer <span className="text-subtle">·</span> {modelLabel}
          </span>
          {cost !== null && (
            <span className="ml-auto text-subtle">{formatCost(cost)}</span>
          )}
        </div>
        {text && <Markdown>{text}</Markdown>}
        {fallbackThinking && (
          <div className="opacity-80">
            <Markdown>{fallbackThinking}</Markdown>
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

function ThinkingIndicator() {
  return (
    <div className="flex items-center gap-2 py-0.5 font-mono text-[11px] text-subtle">
      <span className="inline-flex items-end gap-0.5">
        {[0, 140, 280].map((delay) => (
          <span
            key={delay}
            className="juicy-bounce-dot inline-block h-1 w-1 rounded-full bg-pending"
            style={{ animationDelay: `${delay}ms` }}
          />
        ))}
      </span>
      <span>thinking…</span>
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
