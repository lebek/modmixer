import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { Conversation } from '../agent/conversations';
import type { WorkspaceMod } from '../agent/workspace';
import type { AgentEventEnvelope } from '../preload';
import { cn } from '@/lib/cn';
import { extractText, extractToolCalls } from '@/lib/agent-utils';
import { useAsyncAction } from '@/lib/use-async-action';
import { useScrollPin } from '@/lib/use-scroll-pin';
import { Markdown } from './markdown';
import { ToolResultBubble } from './tool-result-renderer';

type ToolStatus = 'running' | 'done' | 'error';

export function ChatPanel({
  conversation,
  activeMod,
  initialMessages,
  hasAi,
  onConnect,
}: {
  conversation: Conversation;
  activeMod: WorkspaceMod | null;
  initialMessages: AgentMessage[];
  hasAi: boolean;
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
  const [messages, setMessages] = useState<AgentMessage[]>(initialMessages);
  const [streaming, setStreaming] = useState<AgentMessage | null>(null);
  const [toolStates, setToolStates] = useState<
    Record<string, { name: string; status: ToolStatus }>
  >({});
  const [busy, setBusy] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const send = useAsyncAction((text: string) => window.modmixer.send(text));
  const interruptAction = useAsyncAction(() => window.modmixer.interrupt());
  const error = send.error ?? interruptAction.error;
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const visibleMessageCount = streaming ? messages.length + 1 : messages.length;
  const { pinned, hasNewBelow, jumpToBottom, resetFirstRun } = useScrollPin(
    scrollRef,
    [visibleMessageCount, streaming, toolStates, compacting],
  );

  // Reset on conversation switch.
  useEffect(() => {
    setMessages(initialMessages);
    setStreaming(null);
    setToolStates({});
    setBusy(false);
    setCompacting(false);
    send.reset();
    interruptAction.reset();
    resetFirstRun();
    // send/interruptAction/resetFirstRun are stable refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation.id, initialMessages]);

  useEffect(() => {
    return window.modmixer.onEvent((env: AgentEventEnvelope) => {
      if (env.conversationId !== conversation.id) return;
      const event = env.event;
      switch (event.type) {
        case 'agent_start':
          setBusy(true);
          send.reset();
          break;
        case 'agent_end':
          setBusy(false);
          setStreaming(null);
          break;
        case 'message_start':
        case 'message_update':
          if (event.message.role === 'assistant') setStreaming(event.message);
          break;
        case 'message_end':
          setMessages((prev) => [...prev, event.message]);
          if (event.message.role === 'assistant') setStreaming(null);
          break;
        case 'tool_execution_start':
          setToolStates((prev) => ({
            ...prev,
            [event.toolCallId]: { name: event.toolName, status: 'running' },
          }));
          break;
        case 'tool_execution_end':
          setToolStates((prev) => ({
            ...prev,
            [event.toolCallId]: {
              name: event.toolName,
              status: event.isError ? 'error' : 'done',
            },
          }));
          break;
        case 'compaction_start':
          setCompacting(true);
          break;
        case 'compaction_end':
          setCompacting(false);
          // The summary becomes a compactionSummary message that pi-coding-agent
          // injects on the next prompt(); the rendered transcript will pick it
          // up via message_end. Nothing extra to do here.
          break;
      }
    });
  }, [conversation.id]);

  const submit = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    const result = await send.run(text);
    // null = the IPC threw before any agent_end event would clear busy.
    if (result === null) setBusy(false);
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

  const visible = useMemo(
    () => (streaming ? [...messages, streaming] : messages),
    [messages, streaming],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative min-h-0 flex-1">
      <div ref={scrollRef} className="absolute inset-0 space-y-3 overflow-auto px-6 py-4">
        {visible.length === 0 && (
          <ScopeEmptyState scope={effectiveScope} />
        )}
        {visible.map((m, i) => (
          <MessageBubble
            key={`${(m as { timestamp?: number }).timestamp ?? i}-${i}`}
            message={m}
            toolStates={toolStates}
            toolCallArgs={
              m.role === 'toolResult'
                ? findToolCallArgs(visible, i, m.toolCallId)
                : undefined
            }
          />
        ))}
        {compacting && (
          <div className="rounded-md border border-line bg-paper/70 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
            compacting context…
          </div>
        )}
        {error && (
          <div className="rounded-md border border-failed/40 bg-failed/5 px-3 py-2 text-xs text-failed">
            {error}
          </div>
        )}
      </div>
      {!pinned && hasNewBelow && (
        <button
          onClick={jumpToBottom}
          className="absolute left-1/2 bottom-3 z-10 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-line bg-paper px-3 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-muted shadow-md transition-colors hover:bg-surface hover:text-ink"
        >
          <span>New messages</span>
          <DownArrowIcon />
        </button>
      )}
      </div>
      <div className="border-t border-line px-6 py-3">
        {hasAi ? (
          <div className="rounded-md border border-line bg-paper p-3 focus-within:border-ink/40">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
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
              placeholder={placeholderForScope(effectiveScope)}
              className="block h-20 w-full resize-none bg-transparent text-sm text-ink placeholder:text-subtle focus:outline-none"
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
                <button
                  onClick={() => void submit()}
                  disabled={!input.trim()}
                  className="group inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 font-mono text-[11px] uppercase tracking-[0.18em] text-accent-foreground shadow-sm transition-all hover:bg-accent-soft hover:shadow-md active:translate-y-px disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
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

function findToolCallArgs(
  msgs: AgentMessage[],
  idx: number,
  toolCallId: string,
): Record<string, unknown> | undefined {
  for (let j = idx - 1; j >= 0; j--) {
    const m = msgs[j];
    if (m.role !== 'assistant') continue;
    const calls = extractToolCalls(m.content);
    const hit = calls.find((c) => c.id === toolCallId);
    if (hit) return hit.arguments;
  }
  return undefined;
}

function MessageBubble({
  message,
  toolStates,
  toolCallArgs,
}: {
  message: AgentMessage;
  toolStates: Record<string, { name: string; status: ToolStatus }>;
  toolCallArgs?: Record<string, unknown>;
}) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[88%] rounded-md bg-ink/90 px-3 py-2 text-sm text-paper">
          {extractText(message.content)}
        </div>
      </div>
    );
  }

  if (message.role === 'assistant') {
    const text = extractText(message.content);
    const toolCalls = extractToolCalls(message.content);
    const isEmpty = !text && toolCalls.length === 0;
    return (
      <div className="rounded-md border border-line bg-paper/70 p-3">
        <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
          modmixer
        </div>
        {text && <Markdown>{text}</Markdown>}
        {isEmpty && <ThinkingIndicator />}
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
    <div className="flex items-center gap-1.5 py-0.5 font-mono text-[11px] text-subtle">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-pending" />
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
  const label =
    status === 'running' ? 'running' : status === 'error' ? 'failed' : 'done';
  const dot =
    status === 'running'
      ? 'bg-pending animate-pulse'
      : status === 'error'
        ? 'bg-failed'
        : 'bg-ready';
  return (
    <div className="mt-2 flex items-center gap-2 rounded border border-line bg-surface/60 px-2 py-1.5 font-mono text-[11px] text-muted">
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
  const entries = Object.entries(args);
  if (entries.length === 0) return '';
  const [k, v] = entries[0];
  const value = typeof v === 'string' ? v : JSON.stringify(v);
  const more = entries.length > 1 ? ` +${entries.length - 1}` : '';
  return `${k}=${value}${more}`;
}
