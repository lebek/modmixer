import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { loadSettings } from './settings.js';
import type { GameId } from './games/types.js';
import { getGame, listGames } from './games/registry.js';

/**
 * Per-game on-disk nesting under a shared lore base. RimWorld owns the legacy
 * un-namespaced root (storageSegment ''); other games nest under their segment.
 */
function gameSubdir(base: string, game: GameId): string {
  const seg = getGame(game).storageSegment;
  return seg ? path.join(base, seg) : base;
}

/**
 * Modmixer Lore is a knowledge base for transferable RimWorld-modding
 * lessons the agent consults while working.
 *
 *   tier "repo"  — ships with modmixer (read-only at runtime)
 *   tier "user"  — per-installation, cross-mod (engine-level lessons)
 *
 * Topics are flat: `sounds`, `weather`, `harmony`, `defs`, `build`,
 * `test-loop`, `assets`, `misc`. One markdown file per topic per tier.
 *
 * Each entry inside a topic file is a short markdown section starting
 * with an `## ` H2 hook line — that hook is what the agent matches on
 * when deciding whether to update an existing entry vs append a new one.
 *
 * Precedence when the same topic+hook exists in both tiers: user wins
 * over repo. Callers get both back; the more specific tier should be
 * preferred when they disagree.
 */

export type LoreTier = 'repo' | 'user';

/**
 * Topic taxonomy. Locked: the agent cannot create new topics, only write
 * within these. Most slots are empty until lessons accumulate — that's
 * fine. The bar for adding a topic is "the agent will frequently have a
 * lesson that fits nowhere else"; the bar for keeping one is "occasional
 * lessons land here and would otherwise pollute misc."
 *
 * Grouping (informal, for human readers):
 *   Engine systems     — defs, patches, harmony, scribe-saving, performance, localization
 *   Presentation       — ui, sounds, textures, animation
 *   Game subsystems    — pawns, things, recipes, jobs-ai, combat, world-incidents,
 *                        weather, biomes, factions, ideology, biotech, anomaly
 *   Author workflow    — build, test-loop, debugging, compat, assets, distribution
 *   Catch-all          — misc
 *
 * `misc` is intentionally last — the agent should treat it as the
 * placement of last resort, not the default.
 */
// Topics are per-game (RimWorld vs Minecraft have different taxonomies), so the
// catalogue lives on each game's descriptor (see <game>/lore-taxonomy.ts) and is
// validated at runtime via isLoreTopicForGame. Loosened to string accordingly.
export type LoreTopic = string;

export function isLoreTopic(t: string): t is LoreTopic {
  return getGame('rimworld').lore.topics.includes(t);
}

/** The topic catalogue for a game (from its descriptor). */
export function loreTopics(game: GameId): readonly string[] {
  return getGame(game).lore.topics;
}

function loreTopicHints(game: GameId): Record<string, string> {
  return getGame(game).lore.topicHints;
}

export function isLoreTopicForGame(t: string, game: GameId): boolean {
  return loreTopics(game).includes(t);
}

/** Multi-line topic catalogue suitable for embedding in tool descriptions. */
export function topicCatalogueText(game: GameId = 'rimworld'): string {
  const hints = loreTopicHints(game);
  const lines = loreTopics(game).map((t) => `  ${t}: ${hints[t]}`);
  return lines.join('\n');
}

export interface LoreEntry {
  /** The H2 hook line (without the `## ` prefix). Identifies the entry within a topic. */
  hook: string;
  /** Full markdown body for this entry, starting at the `## ` line. */
  markdown: string;
  tier: LoreTier;
  topic: LoreTopic;
  /** ISO date this entry was last written. Repo entries pull this from frontmatter. */
  updatedAt?: string;
  /**
   * Identifier of the model active when this entry was last written, in
   * `provider:modelId` form (e.g. `anthropic:claude-opus-4-7`). Parsed
   * from the trailing `<sub>` footer. Undefined for repo-tier entries
   * (no footer) and for user entries written before this stamp existed.
   */
  clientModel?: string;
}

/**
 * Format `settings.model` as a `provider:modelId` stamp. Null when no
 * model is selected (first launch before model picker has been touched).
 */
function activeModelTag(): string | null {
  const { model } = loadSettings();
  return model ? `${model.provider}:${model.modelId}` : null;
}

/**
 * Matches the auto-generated footer `saveEntry` writes:
 *   <sub>updated YYYY-MM-DD</sub>
 *   <sub>updated YYYY-MM-DD · provider:modelId</sub>
 * Capturing groups: 1 = date, 2 = model tag (may be undefined).
 */
const SUB_FOOTER_RE =
  /<sub>updated (\d{4}-\d{2}-\d{2})(?: · ([^<]+?))?<\/sub>\s*$/;

export interface LoreTopicFile {
  tier: LoreTier;
  topic: LoreTopic;
  /** Absolute path to the markdown file. May not exist on disk. */
  path: string;
}

/**
 * Lore shipped inside the app bundle. Lives at `<repo>/lore/` in dev and
 * `Contents/Resources/lore/` in packaged builds (forge `extraResource`).
 *
 * Only call this from the main process — `app.isPackaged` and
 * `app.getAppPath()` aren't available elsewhere.
 */
// Lore is per-game. RimWorld keeps the legacy flat paths (lore/, userData/lore/)
// so existing lore isn't lost; every other game nests under a /<game>/ subdir
// (lore/minecraft/, userData/lore/minecraft/). This is why a Minecraft
// conversation never sees RimWorld lessons — they live in different dirs.
export function shippedLoreDir(game: GameId = 'rimworld'): string {
  const base = app.isPackaged
    ? path.join(process.resourcesPath, 'lore')
    : path.join(app.getAppPath(), 'lore');
  return gameSubdir(base, game);
}

/**
 * Local cache of crowd-sourced community lore. Populated on startup when
 * the community-lore toggle is on (push user lore, pull curated entries).
 * Empty until the first activation; deleted when the toggle goes back off.
 */
export function communityLoreDir(game: GameId = 'rimworld'): string {
  const base = path.join(app.getPath('userData'), 'community-lore');
  return gameSubdir(base, game);
}

export function userLoreDir(game: GameId = 'rimworld'): string {
  const base = path.join(app.getPath('userData'), 'lore');
  return gameSubdir(base, game);
}

/**
 * What the `repo` tier reads at runtime. With community lore enabled,
 * the shipped bundle is wholesale ignored in favor of the local
 * community-lore cache — it's a strict swap, not a merge, because the
 * server-curated lore is expected to subsume the shipped bootstrap.
 */
export function baseLoreDir(game: GameId = 'rimworld'): string {
  // Community-lore sync is gated by the per-game `communityLore` capability;
  // games without it always read their shipped bundle — otherwise the (empty)
  // community cache would shadow the bundled starter lore when useCommunityLore
  // is on (the default).
  if (!getGame(game).capabilities.communityLore) return shippedLoreDir(game);
  return loadSettings().useCommunityLore
    ? communityLoreDir(game)
    : shippedLoreDir(game);
}

function tierDir(tier: LoreTier, game: GameId): string {
  return tier === 'repo' ? baseLoreDir(game) : userLoreDir(game);
}

export function topicFile(
  tier: LoreTier,
  topic: LoreTopic,
  game: GameId = 'rimworld',
): LoreTopicFile {
  return {
    tier,
    topic,
    path: path.join(tierDir(tier, game), `${topic}.md`),
  };
}

/**
 * Split a markdown topic file into entries by `## ` headings. Anything
 * before the first `## ` is treated as preamble and ignored — the agent
 * shouldn't be authoring preamble, but hand-written repo files may
 * legitimately have an intro paragraph.
 */
function finalizeEntry(
  current: { hook: string; lines: string[] },
  tier: LoreTier,
  topic: LoreTopic,
): LoreEntry {
  const markdown = current.lines.join('\n').trimEnd();
  const m = markdown.match(SUB_FOOTER_RE);
  return {
    hook: current.hook,
    markdown,
    tier,
    topic,
    updatedAt: m?.[1],
    clientModel: m?.[2]?.trim() || undefined,
  };
}

function splitEntries(md: string, tier: LoreTier, topic: LoreTopic): LoreEntry[] {
  const lines = md.split('\n');
  const entries: LoreEntry[] = [];
  let current: { hook: string; lines: string[] } | null = null;
  for (const line of lines) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) {
      if (current) entries.push(finalizeEntry(current, tier, topic));
      current = { hook: m[1].trim(), lines: [line] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) entries.push(finalizeEntry(current, tier, topic));
  return entries;
}

async function readTopicEntries(
  tier: LoreTier,
  topic: LoreTopic,
  game: GameId = 'rimworld',
): Promise<LoreEntry[]> {
  const { path: file } = topicFile(tier, topic, game);
  if (!fs.existsSync(file)) return [];
  try {
    const md = await fsp.readFile(file, 'utf8');
    return splitEntries(md, tier, topic);
  } catch {
    return [];
  }
}

/**
 * Read a single topic across both tiers. Tier order is repo → user,
 * mirroring precedence (later tier wins).
 */
export async function readTopic(
  topic: LoreTopic,
  game: GameId = 'rimworld',
): Promise<LoreEntry[]> {
  const tiers: LoreTier[] = ['repo', 'user'];
  const out: LoreEntry[] = [];
  for (const tier of tiers) {
    out.push(...(await readTopicEntries(tier, topic, game)));
  }
  return out;
}

export interface LoreIndexRow {
  topic: LoreTopic;
  /** Per-tier entry counts. Missing tiers count as 0. */
  counts: Record<LoreTier, number>;
}

/**
 * Synchronous variant of `buildIndex`, for callers (like
 * `buildSystemPrompt`) that need to render the index inside non-async
 * code paths. Reads the same files as the async version.
 */
export function buildIndexSync(game: GameId = 'rimworld'): LoreIndexRow[] {
  const rows: LoreIndexRow[] = [];
  const tiers: LoreTier[] = ['repo', 'user'];
  for (const topic of loreTopics(game)) {
    const counts: Record<LoreTier, number> = { repo: 0, user: 0 };
    for (const tier of tiers) {
      const { path: file } = topicFile(tier, topic, game);
      if (!fs.existsSync(file)) continue;
      try {
        const md = fs.readFileSync(file, 'utf8');
        counts[tier] = splitEntries(md, tier, topic).length;
      } catch {
        // ignore unreadable files — count stays 0
      }
    }
    rows.push({ topic, counts });
  }
  return rows;
}

/**
 * Cheap index of how many entries each tier has per topic. Used to
 * render the lore block in the system prompt without dumping content.
 */
export async function buildIndex(game: GameId = 'rimworld'): Promise<LoreIndexRow[]> {
  const rows: LoreIndexRow[] = [];
  for (const topic of loreTopics(game)) {
    const counts: Record<LoreTier, number> = { repo: 0, user: 0 };
    counts.repo = (await readTopicEntries('repo', topic, game)).length;
    counts.user = (await readTopicEntries('user', topic, game)).length;
    rows.push({ topic, counts });
  }
  return rows;
}

export interface SaveLoreInput {
  topic: LoreTopic;
  hook: string;
  markdown: string;
}

/**
 * Append-or-update an entry in the user tier. Repo lore is read-only
 * at runtime — only `user` is writable.
 *
 * Matching is by exact hook line (case-insensitive trim). If a match
 * exists, that entry is replaced; otherwise the new entry is appended
 * to the topic file (creating the file if needed).
 */
export async function saveEntry(
  input: SaveLoreInput,
  game: GameId = 'rimworld',
): Promise<{
  file: string;
  action: 'created' | 'updated' | 'appended';
}> {
  const { topic, hook } = input;
  const cleanedHook = hook.trim();
  if (!cleanedHook) throw new Error('hook is required.');

  const trimmedBody = input.markdown.trim();
  const stamp = new Date().toISOString().slice(0, 10);
  const modelTag = activeModelTag();
  const footer = modelTag
    ? `<sub>updated ${stamp} · ${modelTag}</sub>`
    : `<sub>updated ${stamp}</sub>`;
  const entryBlock = `## ${cleanedHook}\n\n${trimmedBody}\n\n${footer}\n`;

  const { path: file } = topicFile('user', topic, game);
  await fsp.mkdir(path.dirname(file), { recursive: true });

  let existing = '';
  let fileExisted = false;
  if (fs.existsSync(file)) {
    existing = await fsp.readFile(file, 'utf8');
    fileExisted = true;
  }

  const matchIndex = existing
    .split('\n')
    .findIndex((line) =>
      line.match(/^##\s+(.+?)\s*$/)?.[1]?.trim().toLowerCase() ===
      cleanedHook.toLowerCase(),
    );

  let action: 'created' | 'updated' | 'appended';
  let next: string;
  if (matchIndex !== -1) {
    // Replace the existing entry through the next `## ` (exclusive) or EOF.
    const lines = existing.split('\n');
    let end = lines.length;
    for (let i = matchIndex + 1; i < lines.length; i++) {
      if (lines[i].match(/^##\s+/)) {
        end = i;
        break;
      }
    }
    const before = lines.slice(0, matchIndex).join('\n').replace(/\s*$/, '');
    const after = lines.slice(end).join('\n').replace(/^\s*/, '');
    next = [before, entryBlock.trimEnd(), after].filter((s) => s.length > 0).join('\n\n') + '\n';
    action = 'updated';
  } else if (fileExisted && existing.trim().length > 0) {
    next = existing.replace(/\s*$/, '') + '\n\n' + entryBlock;
    action = 'appended';
  } else {
    next = entryBlock;
    action = 'created';
  }

  await fsp.writeFile(file, next, 'utf8');
  return { file, action };
}

/**
 * Copy every shipped lore file into `communityLoreDir()` so the first
 * activation of the community-lore toggle has content to read from
 * immediately — the shipped bundle is treated as "community lore at
 * release time". Idempotent: skips topics that already have a file in
 * the cache so we never clobber a freshly pulled snapshot if the user
 * toggles off-then-on after a sync.
 */
export async function seedCommunityLoreFromShipped(
  game: GameId = 'rimworld',
): Promise<void> {
  const src = shippedLoreDir(game);
  const dst = communityLoreDir(game);
  await fsp.mkdir(dst, { recursive: true });
  for (const topic of loreTopics(game)) {
    const srcFile = path.join(src, `${topic}.md`);
    const dstFile = path.join(dst, `${topic}.md`);
    if (!fs.existsSync(srcFile)) continue;
    if (fs.existsSync(dstFile)) continue;
    await fsp.copyFile(srcFile, dstFile);
  }
}

/** Seed every game's community cache from its shipped bundle (idempotent). */
export async function seedAllCommunityLoreFromShipped(): Promise<void> {
  for (const g of listGames()) {
    await seedCommunityLoreFromShipped(g.id);
  }
}

/**
 * Wipe the community-lore cache. Used when the toggle goes back off so
 * the agent reverts to the shipped bundle with no stale crowd-sourced
 * residue. Safe if the directory doesn't exist.
 */
export async function clearCommunityLore(game?: GameId): Promise<void> {
  const games = game ? [game] : listGames().map((g) => g.id);
  for (const g of games) {
    await fsp.rm(communityLoreDir(g), { recursive: true, force: true });
  }
}

/**
 * Snapshot of every user-tier entry across all topics. Used to build
 * the payload for the community-lore push. Each entry retains its topic
 * and hook so the server-side row layout is straightforward.
 */
export async function readAllUserEntries(
  game: GameId = 'rimworld',
): Promise<LoreEntry[]> {
  const out: LoreEntry[] = [];
  for (const topic of loreTopics(game)) {
    out.push(...(await readTopicEntries('user', topic, game)));
  }
  return out;
}

/**
 * Remove user-tier entries by (topic, hook). Used by the community-lore
 * sync to prune local lessons the reviewer has already adjudicated —
 * once an entry reaches a terminal `review_status` server-side it's
 * either available via the community pull (verified/dup) or judged
 * not-to-be-kept (rejected/meta/auto_filter), so the local copy is dead
 * weight that would otherwise shadow the curated version forever.
 *
 * Matching is by case-insensitive hook, mirroring `saveEntry`. Each
 * target may carry `reviewedAt` (ISO date): if the local entry was
 * updated *after* the review, the user has changed it since the reviewer
 * looked, so we keep it rather than clobber unreviewed local work.
 *
 * Returns the number of entries actually removed. Files left empty are
 * deleted. Preamble before the first `## ` heading is not preserved, but
 * user-tier files are agent-authored and never carry preamble.
 */
export async function deleteUserEntries(
  targets: Array<{ topic: LoreTopic; hook: string; reviewedAt?: string }>,
  game: GameId = 'rimworld',
): Promise<number> {
  // hook (lowercased) -> reviewedAt date, grouped by topic.
  const byTopic = new Map<LoreTopic, Map<string, string | undefined>>();
  for (const t of targets) {
    if (!isLoreTopicForGame(t.topic, game)) continue;
    const hooks = byTopic.get(t.topic) ?? new Map();
    hooks.set(t.hook.trim().toLowerCase(), t.reviewedAt?.slice(0, 10));
    byTopic.set(t.topic, hooks);
  }

  let removed = 0;
  for (const [topic, hooks] of byTopic) {
    const { path: file } = topicFile('user', topic, game);
    if (!fs.existsSync(file)) continue;
    const md = await fsp.readFile(file, 'utf8');
    const entries = splitEntries(md, 'user', topic);
    const keep = entries.filter((e) => {
      const key = e.hook.trim().toLowerCase();
      if (!hooks.has(key)) return true; // not under review — keep
      // Locally edited after the review landed — keep the newer local copy.
      // Date strings compare chronologically (YYYY-MM-DD).
      const reviewedDate = hooks.get(key);
      if (reviewedDate && e.updatedAt && e.updatedAt > reviewedDate) return true;
      return false; // reviewed and not since edited — drop
    });
    if (keep.length === entries.length) continue;
    removed += entries.length - keep.length;
    if (keep.length === 0) {
      await fsp.rm(file, { force: true });
    } else {
      const next = keep.map((e) => e.markdown.trimEnd()).join('\n\n') + '\n';
      await fsp.writeFile(file, next, 'utf8');
    }
  }
  return removed;
}

/**
 * Replace the community-lore cache with the supplied snapshot. Each
 * input entry contributes one block (`## hook` + body) inside its
 * topic file. Topics with no entries are left untouched so a partial
 * server snapshot still leaves the previous cache intact for unseen
 * topics — but in practice the pull is a full rebuild so this rarely
 * matters.
 */
export async function writeCommunityLore(
  entries: Array<{ topic: LoreTopic; hook: string; markdown: string }>,
  game: GameId = 'rimworld',
): Promise<void> {
  const dir = communityLoreDir(game);
  await fsp.mkdir(dir, { recursive: true });
  const grouped = new Map<LoreTopic, string[]>();
  for (const e of entries) {
    const trimmed = e.markdown.trim();
    const block = trimmed.startsWith('## ')
      ? trimmed
      : `## ${e.hook.trim()}\n\n${trimmed}`;
    const list = grouped.get(e.topic) ?? [];
    list.push(block);
    grouped.set(e.topic, list);
  }
  for (const [topic, blocks] of grouped) {
    const file = path.join(dir, `${topic}.md`);
    await fsp.writeFile(file, blocks.join('\n\n') + '\n', 'utf8');
  }
}
