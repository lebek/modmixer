import fsp from 'node:fs/promises';
import { shell } from 'electron';
import { getMonitorServer } from '../../agent/monitor/server.js';
import { userLoreDir } from '../../agent/lore.js';
import {
  userConfigDir,
  userInstructionsPath,
  userSkillsDir,
} from '../../agent/user-config.js';
import { getAdapter } from '../../agent/adapters/index.js';
import { getLastSetupProgress } from '../../agent/index/setup-progress.js';
import { resolveGameId } from '../../agent/games/registry.js';
import type { GameId } from '../../agent/games/types.js';
import type { RouteContext } from './context.js';

/**
 * Per-game setup (Settings → Games), in-game monitor bridge, shell open
 * helpers, and the lore-folder reveal escape hatch. None of these share state
 * with the registry/agent stack, so they live together as the "system" routes.
 */
export function registerSystemRoutes(ctx: RouteContext): void {
  const { ipc } = ctx;
  const monitor = getMonitorServer();

  // Per-game setup (Settings → Games). Uniform across games — each game's
  // adapter knows how to read its own toolchain/index state and rebuild.
  ipc.handle(
    'modmixer:game-setup:rebuild',
    (_evt, game: GameId, opts?: { force?: boolean }) =>
      getAdapter(resolveGameId(game)).setup.rebuild(opts),
  );

  // Status + latest progress event in one shot, for the onboarding step and
  // the pre-chat gate (which render granular per-phase progress for any game).
  ipc.handle('modmixer:game-setup:snapshot', async (_evt, game: GameId) => {
    const g = resolveGameId(game);
    return {
      status: await getAdapter(g).setup.getStatus(),
      lastProgress: getLastSetupProgress(g),
    };
  });

  // Prerequisite checks (install/toolchain/paths). Separate from the snapshot
  // because it's the expensive probe — the renderer fetches it on mount + after
  // a fix, not on every build-progress tick.
  ipc.handle('modmixer:game-setup:requirements', (_evt, game: GameId) =>
    getAdapter(resolveGameId(game)).setup.checkRequirements(),
  );

  ipc.handle('modmixer:monitor:get-state', () => monitor.getState());
  ipc.handle('modmixer:monitor:get-snapshot', () => monitor.getLastSnapshot());

  ipc.handle('modmixer:shell:open-external', async (_evt, url: string) => {
    // Allow http(s) for general links, steam:// for Steam client deep-links
    // (e.g. the Workshop legal-agreement page after createItem).
    if (!/^(https?|steam):\/\//i.test(url)) return;
    await shell.openExternal(url);
  });

  ipc.handle('modmixer:shell:open-folder', async (_evt, folder: string) => {
    const err = await shell.openPath(folder);
    return err === '' ? null : err;
  });

  // Power-user escape hatch from Settings → reveal the user lore directory
  // in Finder/Explorer. Returns null on success (matches shell.openPath's
  // empty-string convention) or an error string for the renderer to surface.
  ipc.handle('modmixer:lore:reveal', async () => {
    const dir = userLoreDir();
    // Materialize the directory on first reveal so the user lands inside
    // it instead of seeing "folder does not exist".
    await fsp.mkdir(dir, { recursive: true });
    const err = await shell.openPath(dir);
    return err === '' ? null : err;
  });

  // Power-user: open the global skills folder (~/.modmixer/skills). Seed it on
  // first reveal with a README explaining the <name>/SKILL.md layout (the
  // README sits at the skills root, which discovery ignores — only subdirs with
  // a SKILL.md count). Returns null on success or an error string.
  ipc.handle('modmixer:skills:reveal', async () => {
    const dir = userSkillsDir();
    await fsp.mkdir(dir, { recursive: true });
    await writeIfAbsent(`${dir}/README.md`, SKILLS_README);
    const err = await shell.openPath(dir);
    return err === '' ? null : err;
  });

  // Power-user: open the global instructions file (~/.modmixer/AGENTS.md) in
  // the OS default editor, creating it from an inert template on first use.
  ipc.handle('modmixer:instructions:edit', async () => {
    await fsp.mkdir(userConfigDir(), { recursive: true });
    const file = userInstructionsPath();
    await writeIfAbsent(file, INSTRUCTIONS_TEMPLATE);
    const err = await shell.openPath(file);
    return err === '' ? null : err;
  });
}

/** Write `content` only if `file` doesn't already exist (never clobbers). */
async function writeIfAbsent(file: string, content: string): Promise<void> {
  try {
    await fsp.writeFile(file, content, { flag: 'wx' });
  } catch {
    // EEXIST (already authored) or a transient write error — either way we
    // still open what's there; nothing to surface.
  }
}

// Kept inert: the whole thing is an HTML comment so an un-edited file folds a
// harmless note into the prompt rather than active instructions.
const INSTRUCTIONS_TEMPLATE = `<!--
Modmixer — global instructions

Anything you write in this file (outside this comment) is added to the
assistant's instructions for every mod, in every new chat you start.

Changes apply to NEW chats only; existing chats keep the instructions they were
created with. Delete this comment and write your own instructions below.
-->
`;

const SKILLS_README = `# Modmixer skills

Each skill is a folder with a \`SKILL.md\` inside:

    skills/
      my-skill/
        SKILL.md        <- required
        (any other files the skill references)

\`SKILL.md\` starts with YAML frontmatter:

    ---
    name: my-skill        # optional; defaults to the folder name (lowercase-kebab)
    description: One line telling the assistant when to use this skill.
    ---

    Full instructions go here. The assistant reads this file on demand when a
    task matches the description, so keep the description specific.

Skills apply to new chats only.
`;
