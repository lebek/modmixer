import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

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

export function isDefaultTitle(title: string): boolean {
  return title === DEFAULT_TITLE;
}
