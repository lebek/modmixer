import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { getWorkspacePaths } from './workspace.js';

/**
 * Modmixer Lore is a three-tier knowledge base for transferable
 * RimWorld-modding lessons the agent consults while working.
 *
 *   tier "repo"  — ships with modmixer (read-only at runtime)
 *   tier "user"  — per-installation, cross-mod (engine-level lessons)
 *   tier "mod"   — per-mod (mod-specific quirks)
 *
 * Topics are flat: `sounds`, `weather`, `harmony`, `defs`, `build`,
 * `test-loop`, `assets`, `misc`. One markdown file per topic per tier.
 *
 * Each entry inside a topic file is a short markdown section starting
 * with an `## ` H2 hook line — that hook is what the agent matches on
 * when deciding whether to update an existing entry vs append a new one.
 *
 * Precedence when the same topic+hook exists in multiple tiers: mod
 * wins over user wins over repo. Callers get all three back; the most
 * specific tier should be preferred when they disagree.
 */

export type LoreTier = 'repo' | 'user' | 'mod';

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
export const LORE_TOPICS = [
  // Engine systems
  'defs',
  'patches',
  'harmony',
  'scribe-saving',
  'performance',
  'localization',
  // Presentation
  'ui',
  'sounds',
  'textures',
  'animation',
  // Game subsystems
  'pawns',
  'things',
  'recipes',
  'jobs-ai',
  'combat',
  'world-incidents',
  'weather',
  'biomes',
  'factions',
  'ideology',
  'biotech',
  'anomaly',
  // Author workflow
  'build',
  'test-loop',
  'debugging',
  'compat',
  'assets',
  'distribution',
  // Catch-all
  'misc',
] as const;
export type LoreTopic = (typeof LORE_TOPICS)[number];

export function isLoreTopic(t: string): t is LoreTopic {
  return (LORE_TOPICS as readonly string[]).includes(t);
}

/**
 * One-line hint per topic, shown to the agent in tool descriptions so it
 * can pick the right slot without guessing. Keep these tight — they are
 * the only signal the agent gets at routing time. If you find yourself
 * wanting to write a paragraph here, the topic probably needs splitting.
 */
export const LORE_TOPIC_HINTS: Record<LoreTopic, string> = {
  // Engine systems
  defs: 'Def system mechanics, parentName/abstract resolution, def lookup timing, DefDatabase quirks.',
  patches: 'PatchOperations (Add/Replace/Insert), XPath shape, named vs wildcard targets, Patch ordering.',
  harmony: 'Harmony patches, prefix/postfix/transpiler patterns, when to use Harmony vs alternatives.',
  'scribe-saving': 'Save/load via Scribe_*, IExposable, ExposeData, Look* helpers, savegame compatibility.',
  performance: 'Tick budgets, ThingComp/MapComponent overhead, GC pressure, profiling, hot paths.',
  localization: 'Languages/, Keyed/ vs DefInjected/, translation injection, runtime string lookup.',
  // Presentation
  ui: 'Widgets, Listing_Standard, Window subclasses, ITab, Gizmo, Inspector tab, MainTab.',
  sounds: 'SoundDef shape, SubSoundDef, sustainers, OneShot, FMOD/Unity audio quirks, .ogg encoding.',
  textures: 'PNG/_m mask conventions, texPath resolution, GraphicData, atlasing, shaders.',
  animation: 'Sprite swaps, PawnRenderer, AnimationDef, smooth interpolation, body/apparel layering.',
  // Game subsystems
  pawns: 'Pawn generation, kinds, traits, skills, hediffs, needs, body parts, stats, age/biology.',
  things: 'ThingDef shape, Building/Pawn/Plant subclasses, ThingComp, stuff/material system, spawning.',
  recipes: 'RecipeDef, ingredients, work amount, workSkill, surgical recipes, bills, RecipeUser.',
  'jobs-ai': 'JobDef, JobDriver, ThinkTree/ThinkNode, WorkGiver, mental states, pawn AI extensions.',
  combat: 'Verbs, Verb_Shoot/Melee, ProjectileDef, damage calc, armor, cover, ranged accuracy.',
  'world-incidents': 'IncidentDef, IncidentWorker, GameCondition, storyteller comps, raid generation.',
  weather: 'WeatherDef, WeatherOverlay, sky color, wind, rain/snow, MusicManager interactions.',
  biomes: 'BiomeDef, world tiles, terrain generation, plant/animal density, weather chains.',
  factions: 'FactionDef, PawnGroupMaker, relations, settlements, faction-specific raids.',
  ideology: 'PreceptDef, MemeDef, IdeoDef, rituals, role abilities (DLC: Ideology).',
  biotech: 'GeneDef, xenotypes, mechanitor/mech, growth stages, ChildAgeRequirements (DLC: Biotech).',
  anomaly: 'EntityDef, study, void/dark mechanics, monolith, suppression (DLC: Anomaly).',
  // Author workflow
  build: 'csproj, target framework, references, NuGet packages, Assembly-CSharp/UnityEngine DLLs.',
  'test-loop': 'Iteration cadence: dev console, hot-reload tricks, ModSettings sliders, MapComponent tuning.',
  debugging: 'Reading Player.log, triaging errors by mod, decompile_dll usage, log severity classification.',
  compat: 'HugsLib, mod ordering, soft dependencies, optional Harmony patches, version detection.',
  assets: 'Filesystem layout (Sounds/, Textures/), naming, .ogg/.png encoding requirements, placeholder strategy.',
  distribution: 'About.xml, packageId conventions, supportedVersions, Workshop publishing, PublishedFileId.',
  // Catch-all
  misc: "Anything that doesn't fit elsewhere — use sparingly. If lessons cluster here, propose a new topic.",
};

/** Multi-line topic catalogue suitable for embedding in tool descriptions. */
export function topicCatalogueText(): string {
  const lines = LORE_TOPICS.map((t) => `  ${t}: ${LORE_TOPIC_HINTS[t]}`);
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
}

export interface LoreTopicFile {
  tier: LoreTier;
  topic: LoreTopic;
  /** Absolute path to the markdown file. May not exist on disk. */
  path: string;
}

/**
 * Repo lore lives at the modmixer install root in dev (`<repo>/lore/`)
 * and inside `Contents/Resources/lore/` in packaged builds. The forge
 * config's `extraResource` ships the directory.
 *
 * Only call this from the main process — `app.isPackaged` and
 * `app.getAppPath()` aren't available elsewhere.
 */
export function repoLoreDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'lore');
  }
  // app.getAppPath() during dev points at the project root that Forge
  // serves from. The repo lore lives alongside src/ at the repo root.
  return path.join(app.getAppPath(), 'lore');
}

export function userLoreDir(): string {
  return path.join(app.getPath('userData'), 'lore');
}

export function modLoreDir(folder: string): string {
  const { workspaceDir } = getWorkspacePaths();
  return path.join(workspaceDir, folder, '.modmixer', 'lore');
}

function tierDir(tier: LoreTier, modFolder: string | null): string {
  switch (tier) {
    case 'repo':
      return repoLoreDir();
    case 'user':
      return userLoreDir();
    case 'mod':
      if (!modFolder) throw new Error('mod-tier lore requires a mod folder');
      return modLoreDir(modFolder);
  }
}

export function topicFile(
  tier: LoreTier,
  topic: LoreTopic,
  modFolder: string | null = null,
): LoreTopicFile {
  return {
    tier,
    topic,
    path: path.join(tierDir(tier, modFolder), `${topic}.md`),
  };
}

/**
 * Split a markdown topic file into entries by `## ` headings. Anything
 * before the first `## ` is treated as preamble and ignored — the agent
 * shouldn't be authoring preamble, but hand-written repo files may
 * legitimately have an intro paragraph.
 */
function splitEntries(md: string, tier: LoreTier, topic: LoreTopic): LoreEntry[] {
  const lines = md.split('\n');
  const entries: LoreEntry[] = [];
  let current: { hook: string; lines: string[] } | null = null;
  for (const line of lines) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) {
      if (current) {
        entries.push({
          hook: current.hook,
          markdown: current.lines.join('\n').trimEnd(),
          tier,
          topic,
        });
      }
      current = { hook: m[1].trim(), lines: [line] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) {
    entries.push({
      hook: current.hook,
      markdown: current.lines.join('\n').trimEnd(),
      tier,
      topic,
    });
  }
  return entries;
}

async function readTopicEntries(
  tier: LoreTier,
  topic: LoreTopic,
  modFolder: string | null,
): Promise<LoreEntry[]> {
  const { path: file } = topicFile(tier, topic, modFolder);
  if (!fs.existsSync(file)) return [];
  try {
    const md = await fsp.readFile(file, 'utf8');
    return splitEntries(md, tier, topic);
  } catch {
    return [];
  }
}

/**
 * Read a single topic across all relevant tiers. Tier order is
 * repo → user → mod, mirroring precedence (later tier wins).
 * `modFolder` may be null when the agent is not scoped to a mod;
 * the mod tier is then skipped.
 */
export async function readTopic(
  topic: LoreTopic,
  modFolder: string | null,
): Promise<LoreEntry[]> {
  const tiers: LoreTier[] = modFolder ? ['repo', 'user', 'mod'] : ['repo', 'user'];
  const out: LoreEntry[] = [];
  for (const tier of tiers) {
    out.push(...(await readTopicEntries(tier, topic, modFolder)));
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
export function buildIndexSync(modFolder: string | null): LoreIndexRow[] {
  const rows: LoreIndexRow[] = [];
  const tiers: LoreTier[] = modFolder ? ['repo', 'user', 'mod'] : ['repo', 'user'];
  for (const topic of LORE_TOPICS) {
    const counts: Record<LoreTier, number> = { repo: 0, user: 0, mod: 0 };
    for (const tier of tiers) {
      const { path: file } = topicFile(tier, topic, modFolder);
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
export async function buildIndex(modFolder: string | null): Promise<LoreIndexRow[]> {
  const rows: LoreIndexRow[] = [];
  for (const topic of LORE_TOPICS) {
    const counts: Record<LoreTier, number> = { repo: 0, user: 0, mod: 0 };
    counts.repo = (await readTopicEntries('repo', topic, modFolder)).length;
    counts.user = (await readTopicEntries('user', topic, modFolder)).length;
    if (modFolder) {
      counts.mod = (await readTopicEntries('mod', topic, modFolder)).length;
    }
    rows.push({ topic, counts });
  }
  return rows;
}

export interface SaveLoreInput {
  tier: 'user' | 'mod';
  topic: LoreTopic;
  hook: string;
  markdown: string;
  modFolder?: string;
}

/**
 * Append-or-update an entry in a writable tier. Repo lore is read-only
 * at runtime — only `user` and `mod` are accepted here.
 *
 * Matching is by exact hook line (case-insensitive trim). If a match
 * exists, that entry is replaced; otherwise the new entry is appended
 * to the topic file (creating the file if needed).
 *
 * The agent is responsible for picking the right tier — engine-level
 * lessons go to `user`, mod-specific quirks go to `mod`.
 */
export async function saveEntry(input: SaveLoreInput): Promise<{
  file: string;
  action: 'created' | 'updated' | 'appended';
}> {
  const { tier, topic, hook, modFolder } = input;
  if (tier === 'mod' && !modFolder) {
    throw new Error('mod-tier lore requires modFolder.');
  }
  const cleanedHook = hook.trim();
  if (!cleanedHook) throw new Error('hook is required.');

  const trimmedBody = input.markdown.trim();
  const stamp = new Date().toISOString().slice(0, 10);
  const entryBlock =
    `## ${cleanedHook}\n\n${trimmedBody}\n\n` +
    `<sub>updated ${stamp}</sub>\n`;

  const { path: file } = topicFile(tier, topic, modFolder ?? null);
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
