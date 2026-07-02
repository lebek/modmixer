import { useCallback, useSyncExternalStore } from 'react';
import type { AgentMessage, ThinkingLevel } from '@mariozechner/pi-agent-core';
import type { AgentSessionEvent } from '@mariozechner/pi-coding-agent';
import type { AgentEventEnvelope } from './preload';
import type { Conversation } from './agent/conversations';
import type { ModelSelection } from './agent/settings';
import type { PreparedAttachment } from './agent/attachments/types';
import { extractToolCalls } from './lib/agent-utils';

/**
 * Renderer-side store for live agent state, keyed by conversation id.
 *
 * Why this exists: with concurrent build sessions, a background mod tab's
 * agent keeps streaming while the user is focused elsewhere. If the chat
 * component owned that state (as it used to), unmounting the inactive tab
 * would drop the event subscription and lose the in-flight turn. So the
 * single global event subscription and all per-conversation accumulation
 * live here instead — components are pure views over `runtimes`.
 *
 * That same split is what makes "many tabs" cheap: inactive tabs hold only
 * a Map entry, and `useSyncExternalStore` with per-id subscriptions means an
 * event for one conversation re-renders only that conversation's views.
 */

export type ToolStatus = 'running' | 'done' | 'error';

export interface ToolState {
  name: string;
  status: ToolStatus;
}

/** Per-conversation runtime: everything the chat UI derives from events. */
export interface ConvoRuntime {
  messages: AgentMessage[];
  /** Assistant message currently streaming, or null between turns. */
  streaming: AgentMessage | null;
  toolStates: Record<string, ToolState>;
  /** A turn is in flight — drives the per-tab busy indicator. */
  busy: boolean;
  compacting: boolean;
  /**
   * The conversation's agent session is still being constructed in the main
   * process — the workspace is shown but the transcript isn't loaded yet.
   */
  loading: boolean;
}

/**
 * Reconstruct tool-call status from a message list. `tool_execution_*`
 * events only fire live, so a re-opened chat needs its finished tool calls
 * derived from the transcript or they'd render "running" forever. A
 * toolResult message is the authoritative finished state.
 */
export function deriveToolStates(
  msgs: AgentMessage[],
): Record<string, ToolState> {
  const out: Record<string, ToolState> = {};
  for (const m of msgs) {
    if (m.role === 'assistant') {
      for (const c of extractToolCalls(m.content)) {
        if (!out[c.id]) out[c.id] = { name: c.name, status: 'running' };
      }
    } else if (m.role === 'toolResult') {
      const prev = out[m.toolCallId];
      out[m.toolCallId] = {
        name: prev?.name ?? m.toolName ?? m.toolCallId,
        status: m.isError ? 'error' : 'done',
      };
    }
  }
  return out;
}

const EMPTY: ConvoRuntime = {
  messages: [],
  streaming: null,
  toolStates: {},
  busy: false,
  compacting: false,
  loading: false,
};

const runtimes = new Map<string, ConvoRuntime>();
const listeners = new Map<string, Set<() => void>>();
const globalListeners = new Set<() => void>();

/**
 * Per-conversation panel state: the unsent draft message plus the chat's
 * model / thinking selection. Deliberately separate from ConvoRuntime —
 * runtime is rebuilt from the transcript every time an idle chat's session
 * is freed and re-opened (see seedConversation), which would wipe these.
 * This survives switch-away for as long as the chat's tab is open, and is
 * cleared by dropConversation when the tab closes.
 *
 * `draft` is renderer-only and never persisted — by design it does not
 * survive an app restart. `model`/`thinkingLevel` mirror conversations.json:
 * the durable copy is written there via IPC, and this mirror just lets the
 * pickers reflect a change without re-reading disk.
 */
export interface ConvoPanelState {
  draft: string;
  model: ModelSelection | null;
  thinkingLevel: ThinkingLevel;
  /** Files staged for the next send — kept here so they survive tab switches. */
  attachments: PreparedAttachment[];
}

const panels = new Map<string, ConvoPanelState>();
const panelListeners = new Map<string, Set<() => void>>();
const EMPTY_PANEL: ConvoPanelState = {
  draft: '',
  model: null,
  thinkingLevel: 'medium',
  attachments: [],
};

function notify(conversationId: string): void {
  const ls = listeners.get(conversationId);
  if (ls) for (const fn of [...ls]) fn();
  // The "any session busy" header indicator depends on every conversation.
  for (const fn of [...globalListeners]) fn();
}

function notifyPanel(conversationId: string): void {
  const ls = panelListeners.get(conversationId);
  if (ls) for (const fn of [...ls]) fn();
}

/**
 * Mark a conversation's session as loading — its mod tab/workspace is shown
 * but the transcript hasn't arrived. Cleared by seedConversation.
 */
export function markConversationLoading(conversationId: string): void {
  runtimes.set(conversationId, {
    messages: [],
    streaming: null,
    toolStates: {},
    busy: false,
    compacting: false,
    loading: true,
  });
  notify(conversationId);
}

/** Seed a conversation's runtime from its hydrated transcript. */
export function seedConversation(
  conversationId: string,
  messages: AgentMessage[],
): void {
  runtimes.set(conversationId, {
    messages,
    streaming: null,
    toolStates: deriveToolStates(messages),
    busy: false,
    compacting: false,
    loading: false,
  });
  notify(conversationId);
}

/** Forget a conversation's runtime + panel state — call when its tab closes. */
export function dropConversation(conversationId: string): void {
  const hadRuntime = runtimes.delete(conversationId);
  const hadPanel = panels.delete(conversationId);
  if (hadRuntime) notify(conversationId);
  if (hadPanel) notifyPanel(conversationId);
}

function initialPanel(convo: Conversation): ConvoPanelState {
  return {
    draft: '',
    model: convo.model ?? null,
    thinkingLevel: convo.thinkingLevel ?? 'medium',
    attachments: [],
  };
}

/**
 * Initialize a chat's panel state the first time its tab opens. No-op if an
 * entry already exists: once seeded, the in-renderer copy is the live truth,
 * so switching back to a chat must not reset its draft or re-stale its
 * pickers from a (possibly stale) Conversation snapshot.
 */
export function seedPanelState(convo: Conversation): void {
  if (panels.has(convo.id)) return;
  panels.set(convo.id, initialPanel(convo));
  notifyPanel(convo.id);
}

/**
 * Overwrite a chat's panel state unconditionally. Used by snapshot restore,
 * which replaces the conversation — and its on-disk model/thinking — wholesale.
 */
export function resetPanelState(convo: Conversation): void {
  panels.set(convo.id, initialPanel(convo));
  notifyPanel(convo.id);
}

export function setPanelDraft(conversationId: string, draft: string): void {
  const cur = panels.get(conversationId) ?? EMPTY_PANEL;
  if (cur.draft === draft) return;
  panels.set(conversationId, { ...cur, draft });
  notifyPanel(conversationId);
}

/**
 * Put a failed send's text back in the box so pressing Send again is the
 * retry. Skipped if the user already started typing a replacement — their
 * words win over the restored ones.
 */
export function restorePanelDraft(conversationId: string, draft: string): void {
  const cur = panels.get(conversationId) ?? EMPTY_PANEL;
  if (cur.draft.trim() !== '') return;
  panels.set(conversationId, { ...cur, draft });
  notifyPanel(conversationId);
}

export function setPanelModel(
  conversationId: string,
  model: ModelSelection | null,
): void {
  const cur = panels.get(conversationId) ?? EMPTY_PANEL;
  panels.set(conversationId, { ...cur, model });
  notifyPanel(conversationId);
}

export function setPanelThinking(
  conversationId: string,
  thinkingLevel: ThinkingLevel,
): void {
  const cur = panels.get(conversationId) ?? EMPTY_PANEL;
  panels.set(conversationId, { ...cur, thinkingLevel });
  notifyPanel(conversationId);
}

/** Append staged attachments — reads current state so rapid drops don't race. */
export function addPanelAttachments(
  conversationId: string,
  items: PreparedAttachment[],
): void {
  if (items.length === 0) return;
  const cur = panels.get(conversationId) ?? EMPTY_PANEL;
  panels.set(conversationId, {
    ...cur,
    attachments: [...cur.attachments, ...items],
  });
  notifyPanel(conversationId);
}

export function removePanelAttachment(
  conversationId: string,
  id: string,
): void {
  const cur = panels.get(conversationId) ?? EMPTY_PANEL;
  const next = cur.attachments.filter((a) => a.id !== id);
  if (next.length === cur.attachments.length) return;
  panels.set(conversationId, { ...cur, attachments: next });
  notifyPanel(conversationId);
}

export function clearPanelAttachments(conversationId: string): void {
  const cur = panels.get(conversationId);
  if (!cur || cur.attachments.length === 0) return;
  panels.set(conversationId, { ...cur, attachments: [] });
  notifyPanel(conversationId);
}

/** Subscribe a component to one conversation's panel state. */
export function usePanelState(conversationId: string): ConvoPanelState {
  const subscribe = useCallback(
    (cb: () => void) => {
      let set = panelListeners.get(conversationId);
      if (!set) {
        set = new Set();
        panelListeners.set(conversationId, set);
      }
      set.add(cb);
      return () => {
        const s = panelListeners.get(conversationId);
        if (!s) return;
        s.delete(cb);
        if (s.size === 0) panelListeners.delete(conversationId);
      };
    },
    [conversationId],
  );
  const getSnapshot = useCallback(
    () => panels.get(conversationId) ?? EMPTY_PANEL,
    [conversationId],
  );
  return useSyncExternalStore(subscribe, getSnapshot);
}

/**
 * Force a conversation back to idle. Belt-and-braces for when a send() IPC
 * rejects before any agent_end event would have cleared `busy`.
 */
export function markIdle(conversationId: string): void {
  const cur = runtimes.get(conversationId);
  if (!cur || (!cur.busy && !cur.streaming)) return;
  runtimes.set(conversationId, { ...cur, busy: false, streaming: null });
  notify(conversationId);
}

/** Apply one agent event to a runtime, returning a new object iff it changed. */
function applyEvent(cur: ConvoRuntime, event: AgentSessionEvent): ConvoRuntime {
  switch (event.type) {
    case 'agent_start':
      return { ...cur, busy: true };
    case 'agent_end':
      return { ...cur, busy: false, streaming: null };
    case 'message_start':
    case 'message_update':
      return event.message.role === 'assistant'
        ? { ...cur, streaming: event.message }
        : cur;
    case 'message_end':
      return {
        ...cur,
        messages: [...cur.messages, event.message],
        streaming: event.message.role === 'assistant' ? null : cur.streaming,
      };
    case 'tool_execution_start':
      return {
        ...cur,
        toolStates: {
          ...cur.toolStates,
          [event.toolCallId]: { name: event.toolName, status: 'running' },
        },
      };
    case 'tool_execution_end':
      return {
        ...cur,
        toolStates: {
          ...cur.toolStates,
          [event.toolCallId]: {
            name: event.toolName,
            status: event.isError ? 'error' : 'done',
          },
        },
      };
    case 'compaction_start':
      return { ...cur, compacting: true };
    case 'compaction_end':
      return { ...cur, compacting: false };
    default:
      return cur;
  }
}

// Exported for demo-hooks.ts (dev-only replay injection); the product itself
// only feeds this from the IPC subscription below.
export function handleAgentEvent(env: AgentEventEnvelope): void {
  const id = env.conversationId;
  if (!id) return;
  const cur = runtimes.get(id);
  // Events for a conversation with no open tab are dropped — there's no
  // runtime to accumulate into. A tab is always seeded before it can send.
  if (!cur) return;
  const next = applyEvent(cur, env.event);
  if (next === cur) return;
  runtimes.set(id, next);
  notify(id);
}

// One global subscription for the whole renderer lifetime. Events are routed
// to the right conversation by id — this is what keeps a background tab's
// turn accumulating while its chat component is unmounted.
window.modmixer.onEvent(handleAgentEvent);

function subscribeTo(conversationId: string, cb: () => void): () => void {
  let set = listeners.get(conversationId);
  if (!set) {
    set = new Set();
    listeners.set(conversationId, set);
  }
  set.add(cb);
  return () => {
    const s = listeners.get(conversationId);
    if (!s) return;
    s.delete(cb);
    if (s.size === 0) listeners.delete(conversationId);
  };
}

/** Subscribe a component to one conversation's live runtime. */
export function useConversationRuntime(conversationId: string): ConvoRuntime {
  const subscribe = useCallback(
    (cb: () => void) => subscribeTo(conversationId, cb),
    [conversationId],
  );
  const getSnapshot = useCallback(
    () => runtimes.get(conversationId) ?? EMPTY,
    [conversationId],
  );
  return useSyncExternalStore(subscribe, getSnapshot);
}

function subscribeGlobal(cb: () => void): () => void {
  globalListeners.add(cb);
  return () => {
    globalListeners.delete(cb);
  };
}

function anyBusy(): boolean {
  for (const rt of runtimes.values()) {
    if (rt.busy) return true;
  }
  return false;
}

/** True while any open conversation has a turn in flight. */
export function useAnyBusy(): boolean {
  return useSyncExternalStore(subscribeGlobal, anyBusy);
}

/** Non-reactive snapshot of {@link useAnyBusy} for one-off reads (e.g. quit confirm). */
export function anyConversationBusy(): boolean {
  return anyBusy();
}

/**
 * Non-reactive check: does this conversation have a turn in flight right now?
 * Used when the multi-chat UI switches chats — re-seeding a busy chat from its
 * transcript would drop the in-flight streaming state, so the switch skips the
 * re-seed when this is true.
 */
export function isConversationBusy(conversationId: string): boolean {
  const rt = runtimes.get(conversationId);
  return !!rt && (rt.busy || rt.streaming !== null);
}

/**
 * Non-reactive check: has this conversation never received a user message?
 * The multi-chat switcher discards such chats on switch-away so the list isn't
 * littered with untouched "New chat" entries. Returns false when the runtime
 * is unknown or busy — we only discard a chat we can positively confirm empty.
 */
export function isConversationEmpty(conversationId: string): boolean {
  const rt = runtimes.get(conversationId);
  if (!rt || rt.busy || rt.streaming) return false;
  if (rt.messages.some((m) => m.role === 'user')) return false;
  // A typed-but-unsent draft counts as "in use" — discarding the chat on the
  // next "+ New chat" would throw away a message the user means to return to.
  const draft = panels.get(conversationId)?.draft;
  return !draft || draft.trim() === '';
}
