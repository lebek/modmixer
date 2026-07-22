/**
 * Per-mod C# assembly naming for RimWorld mods.
 *
 * Every mod that compiles a C# project needs a UNIQUE assembly identity:
 * RimWorld (Mono) loads at most one assembly per identity across all active
 * mods and silently skips duplicates — no error, nothing loads. Two
 * Modmixer-built mods that shared one hardcoded name (the old `ModSource`)
 * would clobber each other exactly this way. So we derive the name from the
 * mod's display name (PascalCased), de-duped against the other mods in the
 * workspace.
 *
 * Assembly name vs. namespace — these are independent, which is what makes the
 * naming safe to change after the fact:
 *   • The assembly NAME is the DLL filename + Mono identity. It's what collides.
 *     RimWorld does NOT assembly-qualify the type names it persists in saves, so
 *     renaming the assembly never breaks a save or an XML Class= reference.
 *   • The NAMESPACE (in the .cs and in XML Class="Ns.Type") IS save/XML-visible,
 *     so it must stay stable. We never rewrite it here — the agent picks its own
 *     namespace per file and we leave it alone.
 * Because the assembly name is save-safe, we can pick it late and even repair it
 * at build time (see reconcileFallbackAssemblyName) without touching any code.
 *
 * Deliberately workspace-free (fs + the standalone About parser only):
 * rimworld/build.ts imports this, and build.ts is itself reachable from
 * workspace.ts via the game adapter — importing workspace.ts back would form an
 * import cycle.
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { pascalCase } from '../../lib/identifiers.js';
import { parseAboutXml } from '../registry/about-xml.js';
import { SKIP_DIRS } from '../fs-helpers.js';

/**
 * The display name a freshly-minted mod carries until the agent names it (see
 * the RimWorld adapter's createPlaceholder). We won't bake this into an
 * assembly — kept in sync with that literal by hand.
 */
const PLACEHOLDER_NAME = 'untitled mod';

/**
 * Pick a unique PascalCase assembly name for the mod at `modDir`: derived from
 * its About.xml <name>, de-duped against sibling workspace mods, and never the
 * throwaway placeholder name. `modDir` is `<workspaceDir>/<folderId>`, so its
 * parent is the workspace Mods dir we scan for siblings.
 */
export async function deriveAssemblyName(modDir: string): Promise<string> {
  const workspaceDir = path.dirname(modDir);
  const folderId = path.basename(modDir);
  const displayName = await readAboutName(modDir);
  const taken = await collectSiblingAssemblyNames(workspaceDir, folderId);
  return chooseAssemblyName({ displayName, folderId, taken });
}

/**
 * The pure choice: PascalCase the display name, fall back to the (unique)
 * folder id when the mod has no usable name yet, then append 2, 3, … until the
 * name is free among `taken` (a lowercased set of sibling assembly names).
 */
export function chooseAssemblyName(input: {
  displayName: string;
  folderId: string;
  taken: Set<string>;
}): string {
  const name = input.displayName.trim();
  // A mod is "unnamed" when its <name> is empty or still the placeholder — key
  // this off the NAME, never the packageId: the agent sets a real name well
  // before the packageId, and add_csharp can run in between (that's exactly how
  // a well-named mod ended up with a folder-id assembly).
  const usable =
    name && name.toLowerCase() !== PLACEHOLDER_NAME ? pascalCase(name) : '';
  // The folder id is unique by construction (mintWorkspaceFolderId), so it's the
  // safe fallback. pascalCase's leading-digit guard turns a hex id into a valid
  // identifier (Mod<hex>). Build-time reconcile later upgrades this to the real
  // name once the mod has one.
  let base = usable || pascalCase(input.folderId);
  if (!base) base = 'Mod'; // defensive: never return an empty assembly name
  let candidate = base;
  let n = 2;
  while (input.taken.has(candidate.toLowerCase())) {
    candidate = `${base}${n}`;
    n += 1;
  }
  return candidate;
}

/** The provisional name chooseAssemblyName lands on for an as-yet-unnamed mod. */
export function fallbackAssemblyName(folderId: string): string {
  return pascalCase(folderId) || 'Mod';
}

export interface AssemblyRename {
  from: string;
  to: string;
}

/**
 * Repair a mod whose assembly is still the provisional folder-id fallback
 * (add_csharp ran before the mod had a real name) now that it has one: rename
 * the assembly to match the display name. Save-safe — only the AssemblyName/DLL
 * identity and the .csproj filename change; the .cs namespaces and the type
 * names saved games persist are untouched. Returns the rename it made, or null
 * (already established name, or still unnamed — nothing better to pick yet).
 *
 * Only touches the csproj whose AssemblyName equals the fallback, so a live
 * session's LiveSession.csproj sitting alongside is left alone.
 */
export async function reconcileFallbackAssemblyName(
  modDir: string,
): Promise<AssemblyRename | null> {
  const sourceDir = path.join(modDir, 'Source');
  const fallback = fallbackAssemblyName(path.basename(modDir));
  let target: { file: string; xml: string } | null = null;
  for (const file of await filesWithExt(sourceDir, /\.csproj$/i)) {
    const xml = await fs.readFile(path.join(sourceDir, file), 'utf8');
    const current = extractAssemblyName(xml) ?? stripExt(file, /\.csproj$/i);
    if (current === fallback) {
      target = { file, xml };
      break;
    }
  }
  if (!target) return null;

  const desired = await deriveAssemblyName(modDir);
  if (desired === fallback) return null; // still unnamed — no improvement available

  const nextXml = target.xml
    .replace(
      /<AssemblyName>[^<]*<\/AssemblyName>/,
      `<AssemblyName>${desired}</AssemblyName>`,
    )
    .replace(
      /<RootNamespace>[^<]*<\/RootNamespace>/,
      `<RootNamespace>${desired}</RootNamespace>`,
    );
  const oldPath = path.join(sourceDir, target.file);
  const newPath = path.join(sourceDir, `${desired}.csproj`);
  await fs.writeFile(oldPath, nextXml, 'utf8');
  if (newPath !== oldPath) await fs.rename(oldPath, newPath);
  // Drop the stale DLL/pdb so RimWorld doesn't keep loading the old identity
  // (and so it isn't flagged by the collision check). force: no-op if absent.
  for (const ext of ['dll', 'pdb']) {
    await fs.rm(path.join(modDir, 'Assemblies', `${fallback}.${ext}`), {
      force: true,
    });
  }
  return { from: fallback, to: desired };
}

/**
 * Lowercased set of assembly names already claimed by sibling workspace mods:
 * their Source/*.csproj basenames (we name the csproj after the assembly) plus
 * any built Assemblies/*.dll basenames. Used to de-dupe a new mod's name.
 */
export async function collectSiblingAssemblyNames(
  workspaceDir: string,
  selfFolder: string,
): Promise<Set<string>> {
  const dirs = await listSiblingModDirs(workspaceDir, selfFolder);
  const names = new Set<string>();
  await Promise.all(
    dirs.map(async (dir) => {
      for (const n of await basenames(dir, 'Source', /\.csproj$/i))
        names.add(n.toLowerCase());
      for (const n of await basenames(dir, 'Assemblies', /\.dll$/i))
        names.add(n.toLowerCase());
    }),
  );
  return names;
}

export interface AssemblyCollision {
  /** The shared DLL basename, e.g. "ModSource". */
  assembly: string;
  /** Friendly names of the sibling mods that also emit it. */
  others: string[];
}

/**
 * Find assembly identities the mod at `modDir` shares with a sibling workspace
 * mod — i.e. an Assemblies/<name>.dll both of them build. This is the RimWorld
 * load-time collision: only one such DLL loads, the rest are silently skipped.
 * Compares built DLLs (what RimWorld actually scans), so an as-yet-unbuilt
 * sibling — which wouldn't collide at load time — isn't flagged.
 */
export async function findAssemblyCollisions(
  modDir: string,
): Promise<AssemblyCollision[]> {
  const mine = new Set(
    (await basenames(modDir, 'Assemblies', /\.dll$/i)).map((n) =>
      n.toLowerCase(),
    ),
  );
  if (mine.size === 0) return [];
  const workspaceDir = path.dirname(modDir);
  const selfFolder = path.basename(modDir);
  const dirs = await listSiblingModDirs(workspaceDir, selfFolder);
  // Resolve every sibling's DLLs + friendly name first, THEN merge
  // synchronously — merging inside the async map would race on the shared map
  // across the mid-loop `await friendlyName`.
  const perDir = await Promise.all(
    dirs.map(async (dir) => {
      const hits = (await basenames(dir, 'Assemblies', /\.dll$/i)).filter((d) =>
        mine.has(d.toLowerCase()),
      );
      return hits.length ? { display: await friendlyName(dir), hits } : null;
    }),
  );
  const collisions = new Map<string, AssemblyCollision>();
  for (const entry of perDir) {
    if (!entry) continue;
    for (const dll of entry.hits) {
      const lc = dll.toLowerCase();
      const c = collisions.get(lc) ?? { assembly: dll, others: [] };
      c.others.push(entry.display);
      collisions.set(lc, c);
    }
  }
  return [...collisions.values()];
}

/** Render an agent-facing warning for build_mod output, or '' if no collision. */
export function formatCollisionWarning(collisions: AssemblyCollision[]): string {
  if (collisions.length === 0) return '';
  const lines = collisions.map((c) => {
    const others = c.others.map((n) => `"${n}"`).join(', ');
    return `• Assemblies/${c.assembly}.dll is also built by ${others}.`;
  });
  return (
    '\n\n⚠️ ASSEMBLY NAME COLLISION\n' +
    lines.join('\n') +
    '\nRimWorld loads only ONE assembly per identity — with these mods active ' +
    "together, one silently won't load (no error, nothing runs). Give this mod a " +
    'unique assembly: in Source/<name>.csproj set a unique <AssemblyName>, rename ' +
    'the .csproj to match, and rebuild. This is a build-identity change only — the ' +
    'DLL filename — so it needs no code edits and does not affect existing saves ' +
    '(saved type names are namespace-qualified, not assembly-qualified).'
  );
}

async function listSiblingModDirs(
  workspaceDir: string,
  selfFolder: string,
): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(workspaceDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(
      (e) => e.isDirectory() && e.name !== selfFolder && !SKIP_DIRS.has(e.name),
    )
    .map((e) => path.join(workspaceDir, e.name));
}

/** Basenames (extension stripped) of files matching `ext` in `modDir/subdir`. */
async function basenames(
  modDir: string,
  subdir: string,
  ext: RegExp,
): Promise<string[]> {
  return (await filesWithExt(path.join(modDir, subdir), ext)).map((f) =>
    stripExt(f, ext),
  );
}

async function filesWithExt(dir: string, ext: RegExp): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).filter((f) => ext.test(f));
  } catch {
    return [];
  }
}

function stripExt(file: string, ext: RegExp): string {
  return file.replace(ext, '');
}

function extractAssemblyName(csprojXml: string): string | null {
  return csprojXml.match(/<AssemblyName>([^<]*)<\/AssemblyName>/)?.[1]?.trim() ?? null;
}

async function friendlyName(modDir: string): Promise<string> {
  const name = await readAboutName(modDir);
  return name.trim() || path.basename(modDir);
}

async function readAboutName(modDir: string): Promise<string> {
  try {
    const xml = await fs.readFile(
      path.join(modDir, 'About', 'About.xml'),
      'utf8',
    );
    return parseAboutXml(xml).name;
  } catch {
    return '';
  }
}
