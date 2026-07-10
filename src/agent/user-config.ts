import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import {
  parseFrontmatter,
  createSyntheticSourceInfo,
  type Skill,
  type SkillFrontmatter,
} from '@earendil-works/pi-coding-agent';

/**
 * Global power-user config lives in a home-directory dotfolder, NOT under
 * Electron's userData. The split is deliberate (and is a security boundary):
 *
 *   ~/.modmixer/         <- hand-authored, portable, sync-able (this module)
 *     AGENTS.md          <- custom instructions folded into the system prompt
 *     skills/<name>/SKILL.md
 *   userData/            <- app-managed, regenerable, secret (auth.enc, etc.)
 *
 * Hand-authored config that the user versions/syncs (chezmoi, a dotfiles repo,
 * …) wants a visible, stable, cross-platform home path; secrets must NOT follow
 * it there. We resolve via os.homedir() + path.join so the same code yields
 * `/Users/<u>/.modmixer` on macOS and `C:\Users\<u>\.modmixer` on Windows — a
 * literal `~` is never handed to `fs`.
 *
 * These files fold into the snapshotted system prompt (see buildSystemPrompt's
 * invariant), so edits apply to NEW chats only — exactly like defaultAuthor or
 * the lore index. All reads tolerate the dir/file being absent (the common
 * case) and never throw into the prompt builder.
 */
export function userConfigDir(): string {
  return path.join(homedir(), '.modmixer');
}

export function userInstructionsPath(): string {
  return path.join(userConfigDir(), 'AGENTS.md');
}

export function userSkillsDir(): string {
  return path.join(userConfigDir(), 'skills');
}

/** Raw text of the user's global instructions, or '' when absent/empty. */
export function readUserInstructionsSync(): string {
  try {
    return fs.readFileSync(userInstructionsPath(), 'utf8').trim();
  } catch {
    return '';
  }
}

// Skill names follow pi's contract: lowercase a-z0-9 with single internal
// hyphens. We enforce it here so a stray folder name can't emit a malformed
// <name> into the prompt.
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Discover skills under ~/.modmixer/skills, one per `<name>/SKILL.md`. Sync to
 * match the rest of the prompt builder (buildIndexSync, etc.); the dir is tiny.
 * Mirrors a minimal slice of pi's loadSkills — frontmatter name/description,
 * lowercase-kebab name contract — without pi's recursion/ignore-file walk,
 * which we don't need for a flat, modmixer-owned folder.
 *
 * Anything malformed (no SKILL.md, bad YAML, missing description, illegal name)
 * is skipped rather than thrown, so one bad skill can't break every chat.
 */
export function discoverUserSkillsSync(): Skill[] {
  const root = userSkillsDir();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const skills: Skill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const baseDir = path.join(root, entry.name);
    const filePath = path.join(baseDir, 'SKILL.md');
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue; // a subdir without a SKILL.md is just not a skill
    }
    let frontmatter: SkillFrontmatter;
    try {
      frontmatter = parseFrontmatter<SkillFrontmatter>(raw).frontmatter;
    } catch {
      continue; // malformed YAML — skip rather than poison the prompt
    }
    const description =
      typeof frontmatter.description === 'string'
        ? frontmatter.description.trim()
        : '';
    if (!description) continue; // no description = nothing useful to advertise
    const name =
      typeof frontmatter.name === 'string' && frontmatter.name.trim()
        ? frontmatter.name.trim()
        : entry.name;
    if (!SKILL_NAME_RE.test(name)) continue;
    skills.push({
      name,
      description,
      filePath,
      baseDir,
      sourceInfo: createSyntheticSourceInfo(filePath, {
        source: 'modmixer-user',
        scope: 'user',
        baseDir,
      }),
      disableModelInvocation: frontmatter['disable-model-invocation'] === true,
    });
  }
  // Deterministic, locale-independent order so the system prompt stays
  // byte-identical across the (at most two) rebuilds of a conversation —
  // readdir order is filesystem-dependent.
  skills.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return skills;
}
