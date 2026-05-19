import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import type { ThinkingLevel } from '@mariozechner/pi-agent-core';
import type { ModelSelection } from './settings.js';

export type ConversationScope =
  | { type: 'new' }
  | { type: 'mod'; modFolder: string };

export interface Conversation {
  id: string;
  /** Absolute path to the pi-coding-agent JSONL session file. */
  sessionFile: string;
  scope: ConversationScope;
  title: string;
  createdAt: number;
  updatedAt: number;
  /**
   * System prompt frozen at conversation creation (and refreshed on scope
   * upgrade). Reused on every rehydration — never rebuilt against current
   * disk/settings state on a per-turn basis.
   *
   * Why this is persisted instead of recomputed: OpenRouter hashes the first
   * system message + first non-system message to identify a conversation for
   * sticky provider routing, which is what keeps the upstream provider's
   * prompt cache warm. If the system prompt drifts by even one byte across
   * restarts (lore index counts shift, RimWorld first-launch flips
   * `(not found)` paths, scope upgrades from `new` → `mod`, etc.) the hash
   * changes, sticky resets, and the next turn lands on a fresh provider with
   * a cold cache — at ~10× the per-turn cost. See `buildSystemPrompt` for
   * the upstream invariant.
   *
   * Optional for backward-compat: legacy conversations created before this
   * field existed backfill on first rehydration.
   */
  systemPrompt?: string;
  /**
   * Model this chat runs on, chosen from its in-chat toolbar. Per-conversation
   * (NOT per-mod) — a mod with several chats can run each on a different
   * model. Stamped at creation from the settings default; backfilled on first
   * rehydration for chats created before this field existed.
   */
  model?: ModelSelection;
  /**
   * Reasoning effort for this chat. Same per-conversation semantics as
   * `model` — stamped at creation, backfilled for legacy chats.
   */
  thinkingLevel?: ThinkingLevel;
  /**
   * When set, the chat is archived: kept on disk and fully restorable, but
   * hidden from the default multi-chat list. Undefined means active. Only
   * ever set while the multi-chat setting is on — regular-mode users never
   * see this field.
   */
  archivedAt?: number;
  /**
   * Absolute paths of files/directories the user attached to this chat. The
   * files are NOT copied — only their paths are remembered, so the read-side
   * path allowlist can be rebuilt when the session is reconstructed (tab
   * switch) or after an app restart. Lets the agent still read or copy an
   * attachment in a later turn instead of only the turn it arrived in.
   */
  attachmentPaths?: string[];
}

interface Persisted {
  version: 2;
  conversations: Conversation[];
  /** Folder → conversation id of the current "active chat" for that mod. */
  activeByMod: Record<string, string>;
}

const FILE_VERSION = 2;
export const DEFAULT_TITLE = 'New chat';

let cached: Persisted | null = null;

function file(): string {
  return path.join(app.getPath('userData'), 'conversations.json');
}

function load(): Persisted {
  if (cached) return cached;
  try {
    const raw = fs.readFileSync(file(), 'utf8');
    const parsed = JSON.parse(raw) as { version?: number };
    if (parsed.version === FILE_VERSION) {
      cached = parsed as Persisted;
      return cached;
    }
    // Older formats (v1) stored full transcripts inline. We're now backed by
    // pi's JSONL session files, so the in-app index has nothing to migrate
    // toward — start fresh. Old data stays on disk but is unreferenced.
  } catch {
    // First run or unreadable file — fall through to a fresh index.
  }
  cached = { version: FILE_VERSION, conversations: [], activeByMod: {} };
  return cached;
}

function persist(): void {
  if (!cached) return;
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(cached, null, 2));
}

export function listConversations(): Conversation[] {
  return load().conversations.slice().sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getConversation(id: string): Conversation | null {
  return load().conversations.find((c) => c.id === id) ?? null;
}

export function addConversation(entry: {
  id: string;
  sessionFile: string;
  scope: ConversationScope;
  title?: string;
  systemPrompt?: string;
  model?: ModelSelection;
  thinkingLevel?: ThinkingLevel;
}): Conversation {
  const now = Date.now();
  const convo: Conversation = {
    id: entry.id,
    sessionFile: entry.sessionFile,
    scope: entry.scope,
    title: entry.title ?? DEFAULT_TITLE,
    createdAt: now,
    updatedAt: now,
    systemPrompt: entry.systemPrompt,
    model: entry.model,
    thinkingLevel: entry.thinkingLevel,
  };
  load().conversations.push(convo);
  persist();
  return convo;
}

/**
 * Remove a conversation from the index. Returns the session file path so the
 * caller can delete it on disk (we don't touch the file ourselves — that's
 * SessionManager territory).
 */
export function removeConversation(id: string): string | null {
  const data = load();
  const convo = data.conversations.find((c) => c.id === id);
  if (!convo) return null;
  data.conversations = data.conversations.filter((c) => c.id !== id);
  for (const [folder, activeId] of Object.entries(data.activeByMod)) {
    if (activeId === id) delete data.activeByMod[folder];
  }
  persist();
  return convo.sessionFile;
}

export function setTitle(id: string, title: string): void {
  const c = getConversation(id);
  if (!c) return;
  c.title = title;
  c.updatedAt = Date.now();
  persist();
}

export function setScope(id: string, scope: ConversationScope): void {
  const c = getConversation(id);
  if (!c) return;
  c.scope = scope;
  c.updatedAt = Date.now();
  persist();
}

export function setSystemPrompt(id: string, systemPrompt: string): void {
  const c = getConversation(id);
  if (!c) return;
  c.systemPrompt = systemPrompt;
  // Don't bump updatedAt — this is bookkeeping, not a user-visible change.
  persist();
}

export function setConvModel(id: string, model: ModelSelection): void {
  const c = getConversation(id);
  if (!c) return;
  c.model = model;
  // Don't bump updatedAt — a model switch shouldn't reorder the chat list.
  persist();
}

export function setConvThinkingLevel(id: string, level: ThinkingLevel): void {
  const c = getConversation(id);
  if (!c) return;
  c.thinkingLevel = level;
  persist();
}

export function archiveConversation(id: string): void {
  const c = getConversation(id);
  if (!c) return;
  c.archivedAt = Date.now();
  // Don't bump updatedAt — archiving is a visibility change, not an edit.
  persist();
}

export function unarchiveConversation(id: string): void {
  const c = getConversation(id);
  if (!c) return;
  delete c.archivedAt;
  persist();
}

/**
 * Append attachment paths for a chat, de-duplicated. Persisted so the
 * session's read-side allowlist survives reconstruction and app restart.
 */
export function addAttachmentPaths(id: string, paths: string[]): void {
  if (paths.length === 0) return;
  const c = getConversation(id);
  if (!c) return;
  const merged = new Set(c.attachmentPaths ?? []);
  const before = merged.size;
  for (const p of paths) merged.add(p);
  if (merged.size === before) return;
  c.attachmentPaths = [...merged];
  // Don't bump updatedAt — bookkeeping, not a user-visible edit.
  persist();
}

export function touch(id: string): void {
  const c = getConversation(id);
  if (!c) return;
  c.updatedAt = Date.now();
  persist();
}

export function getActiveForMod(folder: string): Conversation | null {
  const data = load();
  const id = data.activeByMod[folder];
  if (!id) return null;
  return data.conversations.find((c) => c.id === id) ?? null;
}

export function setActiveForMod(folder: string, id: string): void {
  load().activeByMod[folder] = id;
  persist();
}

export function clearActiveForMod(folder: string): void {
  delete load().activeByMod[folder];
  persist();
}

export function listConversationsForMod(folder: string): Conversation[] {
  return load().conversations.filter(
    (c) => c.scope.type === 'mod' && c.scope.modFolder === folder,
  );
}

export interface ModConversationsSlice {
  /** Mod-scoped conversations as of this slice. */
  conversations: Conversation[];
  /** activeByMod[folder] at slice time, or null if unset. */
  activeId: string | null;
}

/**
 * Read the per-mod subset of the global index. Used by the snapshot system
 * so the chat list and which-chat-is-active are part of every save.
 */
export function getModConversationsSlice(folder: string): ModConversationsSlice {
  const data = load();
  return {
    // Defensive copy — snapshots shouldn't share refs with live state.
    conversations: data.conversations
      .filter((c) => c.scope.type === 'mod' && c.scope.modFolder === folder)
      .map((c) => ({ ...c })),
    activeId: data.activeByMod[folder] ?? null,
  };
}

/**
 * Replace the mod-scoped subset of the global index with a snapshot slice.
 * Mod-scoped conversations not in the slice are dropped (the caller is
 * responsible for unlinking their session files); slice conversations not
 * currently in the index are added back. activeByMod[folder] is set to
 * slice.activeId, or cleared if the snapshot had nothing active.
 *
 * Conversations belonging to other mods (or 'new' scope) are left alone.
 */
export function replaceModConversationsSlice(
  folder: string,
  slice: ModConversationsSlice,
): void {
  const data = load();
  const others = data.conversations.filter(
    (c) => !(c.scope.type === 'mod' && c.scope.modFolder === folder),
  );
  data.conversations = [
    ...others,
    ...slice.conversations.map((c) => ({ ...c })),
  ];
  if (slice.activeId) {
    data.activeByMod[folder] = slice.activeId;
  } else {
    delete data.activeByMod[folder];
  }
  // Belt-and-braces: if activeId points to a chat that isn't in the slice,
  // clear it rather than leave a dangling pointer.
  const ids = new Set(slice.conversations.map((c) => c.id));
  if (data.activeByMod[folder] && !ids.has(data.activeByMod[folder])) {
    delete data.activeByMod[folder];
  }
  persist();
}

/**
 * Drop the in-memory cache so the next read re-loads from disk. Call after
 * something rewrites conversations.json behind our back (e.g. snapshot
 * restore patching the file directly).
 */
export function reloadConversations(): void {
  cached = null;
}

export function isDefaultTitle(title: string): boolean {
  return title === DEFAULT_TITLE;
}
