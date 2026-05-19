import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

/**
 * The cookbook is a curated, repo-shipped reference library for external
 * frameworks (Combat Extended, Harmony, ...) that the agent cannot learn by
 * reading the mod's own code. It is deliberately NOT the lore system:
 *
 *   - lore     = hard-won, append-as-you-go gotchas, agent-writable
 *   - cookbook = distilled how-to reference, human-curated, read-only
 *
 * Keeping them separate matters: lore stays high-signal ("every entry is a
 * lesson worth reading") only if it isn't diluted with bulky reference
 * material. New gotchas the agent discovers still go to lore; a lore entry
 * can cross-link a cookbook section.
 *
 * Layout on disk — one directory per "page", one markdown file per "section":
 *
 *   cookbook/
 *     ce-compat/overview.md
 *     ce-compat/ranged-weapons.md
 *     harmony/transpiler.md
 *
 * The agent reads a section with the ordinary `read` tool — there is no
 * dedicated cookbook tool, to keep the tool count small (non-frontier models
 * route better with fewer tools). Two things make plain `read` work:
 *
 *   1. cookbookDir() is added to PathPolicyRoots so `read` is allowed to
 *      reach it — the cookbook lives outside the mod-workspace sandbox.
 *   2. buildSystemPrompt embeds the catalogue (absolute path + title per
 *      section) so the agent knows the files exist and where they are.
 *
 * Sections are kept small (roughly one screenful) so a whole-file `read`
 * never becomes a context sink; there is intentionally no "read the whole
 * page" affordance.
 */

/**
 * Repo cookbook lives at the modmixer install root in dev (`<repo>/cookbook/`)
 * and inside `Contents/Resources/cookbook/` in packaged builds — forge's
 * `extraResource` ships the directory. Main-process only (uses `app`).
 */
export function cookbookDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'cookbook');
  }
  // Mirrors repoLoreDir(): app.getAppPath() in dev is the project root Forge
  // serves from, and the cookbook lives alongside src/ at the repo root.
  return path.join(app.getAppPath(), 'cookbook');
}

export interface CookbookSection {
  /** Page directory name, e.g. "ce-compat". */
  page: string;
  /** Section file basename without extension, e.g. "ranged-weapons". */
  section: string;
  /** Absolute path to the markdown file — paste straight into `read`. */
  path: string;
  /** First `# ` heading in the file; falls back to the section basename. */
  title: string;
}

export interface CookbookPage {
  page: string;
  sections: CookbookSection[];
}

/** First `# ` ATX heading in a markdown string, trimmed. Null if none. */
function firstHeading(md: string): string | null {
  for (const line of md.split('\n')) {
    const m = line.match(/^#\s+(.+?)\s*$/);
    if (m) return m[1].trim();
  }
  return null;
}

/**
 * Scan the cookbook directory into a page → section catalogue. Synchronous
 * so buildSystemPrompt can embed it without an async hop; the tree is tiny
 * and read-only, same as the lore index. Missing/unreadable dir → [].
 */
export function buildCookbookCatalogueSync(): CookbookPage[] {
  const root = cookbookDir();
  let pageDirs: fs.Dirent[];
  try {
    pageDirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const pages: CookbookPage[] = [];
  for (const pd of pageDirs.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!pd.isDirectory()) continue;
    const pageRoot = path.join(root, pd.name);
    let files: string[];
    try {
      files = fs.readdirSync(pageRoot);
    } catch {
      continue;
    }
    const sections: CookbookSection[] = [];
    for (const file of files.sort()) {
      if (!file.endsWith('.md')) continue;
      const abs = path.join(pageRoot, file);
      const section = file.slice(0, -'.md'.length);
      let title = section;
      try {
        title = firstHeading(fs.readFileSync(abs, 'utf8')) ?? section;
      } catch {
        // unreadable — keep the basename as the title
      }
      sections.push({ page: pd.name, section, path: abs, title });
    }
    if (sections.length > 0) pages.push({ page: pd.name, sections });
  }
  return pages;
}
