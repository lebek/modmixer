import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import {
  MINECRAFT_VERSION,
  NEOFORGE_VERSION,
  PARCHMENT_MINECRAFT_VERSION,
  PARCHMENT_MAPPINGS_VERSION,
} from './versions.js';

/**
 * Scaffolding a Minecraft NeoForge mod. Unlike RimWorld (where a mod is a folder
 * of XML + an optional C# project), a NeoForge mod IS a Gradle project. ModMixer
 * vendors the official ModDevGradle 1.21.1 MDK as a template and stamps the
 * mod's identity into gradle.properties; the MDK's neoforge.mods.toml already
 * pulls those values via Gradle property expansion, so the project is buildable
 * immediately and the agent just edits Java/JSON from there.
 *
 * The template (including the binary gradle-wrapper.jar) is fetched at build
 * time by scripts/fetch-neoforge-mdk.mjs into vendor/neoforge-mdk/ and shipped
 * in the packaged app's resources.
 */

export interface MinecraftModIdentity {
  /** lowercase a-z0-9_ mod id (2-64 chars), e.g. "coolblocks". */
  modId: string;
  /** Human display name, e.g. "Cool Blocks". */
  modName: string;
  author: string;
  description: string;
  /** semver, defaults to 0.1.0. */
  version?: string;
  /** reverse-DNS group, defaults to com.modmixer.<modId>. */
  groupId?: string;
}

/**
 * Coerce arbitrary text into a valid NeoForge mod id. NeoForge requires the id
 * to match `[a-z][a-z0-9_]{1,63}` — i.e. start with a LETTER and be 2–64 chars.
 * Stripping disallowed chars isn't enough: a name like "3D Shapes" → "3dshapes"
 * or "_under" would pass a naive strip but fail FML at load. So we prefix a
 * letter when the cleaned text starts with a digit/underscore (or is empty),
 * then guarantee the 2-char minimum.
 */
export function slugifyModId(raw: string): string {
  let slug = raw.toLowerCase().replace(/[^a-z0-9_]+/g, '');
  if (!/^[a-z]/.test(slug)) slug = `mod${slug}`;
  slug = slug.slice(0, 64);
  return slug.length >= 2 ? slug : `${slug}mod`.slice(0, 64);
}

export interface MinecraftMeta {
  name: string;
  modId: string;
  author: string;
  description: string;
  version: string;
}

function parseGradleProps(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith('!')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}

/**
 * Read a scaffolded Minecraft mod's identity from gradle.properties — the MC
 * analogue of RimWorld's About.xml. Returns null when the file is absent (an
 * MC mod whose project hasn't been laid down yet).
 */
export function readMinecraftMeta(modDir: string): MinecraftMeta | null {
  const p = path.join(modDir, 'gradle.properties');
  if (!fs.existsSync(p)) return null;
  try {
    const props = parseGradleProps(fs.readFileSync(p, 'utf8'));
    return {
      name: props.mod_name ?? '',
      modId: props.mod_id ?? '',
      author: props.mod_authors ?? '',
      description: props.mod_description ?? '',
      version: props.mod_version ?? '',
    };
  } catch {
    return null;
  }
}

/** Resolve the vendored MDK template dir (dev tree or packaged resources). */
function templateDir(): string | null {
  const candidates = [
    path.join(app.getAppPath(), 'vendor', 'neoforge-mdk', 'template'),
    path.join(process.resourcesPath ?? '', 'neoforge-mdk', 'template'),
    // dev fallback: repo root relative to compiled main
    path.join(process.cwd(), 'vendor', 'neoforge-mdk', 'template'),
  ];
  return candidates.find((p) => p && fs.existsSync(path.join(p, 'gradle.properties'))) ?? null;
}

const TEMPLATE_MISSING =
  'The Minecraft (NeoForge) project template is not installed. Run ' +
  '`npm run fetch:neoforge-mdk` to vendor the ModDevGradle 1.21.1 MDK.';

/**
 * Rewrite a gradle.properties string with the given key/value pairs, preserving
 * comments, ordering, and any keys we don't touch. Keys absent from the file
 * are appended.
 */
function patchGradleProperties(content: string, values: Record<string, string>): string {
  const lines = content.split(/\r?\n/);
  const remaining = new Set(Object.keys(values));
  const out = lines.map((line) => {
    const m = line.match(/^(\s*)([A-Za-z0-9_.]+)(\s*=\s*)(.*)$/);
    if (!m) return line;
    const key = m[2];
    if (!(key in values)) return line;
    remaining.delete(key);
    return `${m[1]}${key}${m[3]}${values[key]}`;
  });
  for (const key of remaining) out.push(`${key}=${values[key]}`);
  return out.join('\n');
}

/**
 * Lay down a fresh, buildable NeoForge project in `modDir` from the vendored
 * MDK template, stamping the mod identity into gradle.properties.
 */
export async function createMinecraftMod(
  modDir: string,
  identity: MinecraftModIdentity,
): Promise<void> {
  const template = templateDir();
  if (!template) throw new Error(TEMPLATE_MISSING);

  await fsp.mkdir(modDir, { recursive: true });
  await fsp.cp(template, modDir, { recursive: true });

  const propsPath = path.join(modDir, 'gradle.properties');
  const props = await fsp.readFile(propsPath, 'utf8');
  const modId = slugifyModId(identity.modId || identity.modName || 'untitledmod');
  const groupId = identity.groupId ?? `com.modmixer.${modId}`;
  const patched = patchGradleProperties(props, {
    minecraft_version: MINECRAFT_VERSION,
    neo_version: NEOFORGE_VERSION,
    parchment_minecraft_version: PARCHMENT_MINECRAFT_VERSION,
    parchment_mappings_version: PARCHMENT_MAPPINGS_VERSION,
    mod_id: modId,
    mod_name: identity.modName || 'Untitled Mod',
    mod_version: identity.version ?? '0.1.0',
    mod_group_id: groupId,
    mod_authors: identity.author || 'Modmixer User',
    mod_description: (identity.description || '').replace(/\n/g, ' '),
    mod_license: 'MIT',
  });
  await fsp.writeFile(propsPath, patched, 'utf8');

  // Rename the MDK's bundled example so the @Mod id + package + resource
  // namespace match the new mod_id — otherwise NeoForge rejects the mod at
  // load time ("entrypoint class … for mod with id examplemod, which does not
  // exist"), even though it compiles fine.
  await renameModId(modDir, EXAMPLE_ID, EXAMPLE_GROUP, modId, groupId);

  await ensureModmixerWiring(path.join(modDir, 'build.gradle'));

  // The POSIX wrapper must stay executable; a copy can drop the bit.
  if (process.platform !== 'win32') {
    try {
      await fsp.chmod(path.join(modDir, 'gradlew'), 0o755);
    } catch {
      /* best effort */
    }
  }
}

/**
 * The ModMixer test-loop wiring appended to a scaffolded mod's build.gradle. All
 * of it is inert during a normal `gradlew build` and only activates for the test
 * loop's `runClient -P…` invocation. Two independent blocks, each guarded by its
 * own marker so {@link ensureModmixerWiring} can add a newer one to a project
 * that already has the older — keeping pre-existing workspace mods upgradeable:
 *
 *  - BRIDGE: the bridge jar (a real FML mod) goes on the run's runtime classpath
 *    so NeoForge discovers it alongside the user's mod, and the `modmixer.*`
 *    system properties are forwarded to the game JVM so it can connect back to
 *    ModMixer's monitor.
 *  - COMPANION: any `-PmodmixerExtraMods=<jar1><sep><jar2>` (platform path
 *    separator) jars are added to the same runtime classpath, for compat testing
 *    against the user's other installed mods.
 */
const BRIDGE_WIRING_MARKER = '// --- ModMixer diagnostics bridge';
const COMPANION_WIRING_MARKER = '// --- ModMixer companion mods';
// Every ModMixer-managed block starts with this prefix; ensureModmixerWiring
// strips and regenerates everything from the first such marker so a block can be
// UPGRADED in place (not only appended-if-absent) on a project that has an older
// one. Our blocks are always appended at EOF in order, so nothing else follows.
const MODMIXER_MARKER_PREFIX = '// --- ModMixer';

const BRIDGE_SNIPPET = `

${BRIDGE_WIRING_MARKER} (added by Modmixer) -----------------
// Loaded only for the agent test loop:
//   gradlew runClient -PmodmixerBridgeJar=<jar> -Dmodmixer.port=<port>
if (project.hasProperty('modmixerBridgeJar')) {
    dependencies {
        localRuntime files(project.property('modmixerBridgeJar'))
    }
}
// Snapshot EVERY -Dmodmixer.* system property so it can be forwarded to the game
// JVM below, where the bridge reads it (port, token, testTimeoutMs, reportFile,
// quicktest, …). Generic on purpose: new properties need no edit here.
//
// Read via the provider API, NOT a bulk System.getProperties() scan: gradle.properties
// enables the configuration cache, and a bulk read isn't tracked per-key — so once the
// cache is warm a later launch that ADDS a modmixer.* prop (e.g. quicktest) reuses the
// stale task graph and silently drops it, leaving the client at the title screen instead
// of the test world. systemPropertiesPrefixedBy IS a tracked config-cache input, so
// changing the modmixer.* set correctly invalidates the cache. Read here at script scope
// (not inside the neoForge run closure) so 'providers' resolves against the project.
def modmixerProps = providers.systemPropertiesPrefixedBy('modmixer.').get()
neoForge {
    runs {
        client {
            modmixerProps.each { k, v -> systemProperty(k, v) }
        }
    }
}
`;

const COMPANION_SNIPPET = `

${COMPANION_WIRING_MARKER} (added by Modmixer) -----------------
// Compat testing: load installed mods alongside this one for the test loop.
//   gradlew runClient -PmodmixerExtraMods=<jar1>\${File.pathSeparator}<jar2>
if (project.hasProperty('modmixerExtraMods')) {
    dependencies {
        project.property('modmixerExtraMods')
            .split(java.io.File.pathSeparator)
            .findAll { it?.trim() }
            .each { p -> localRuntime files(p.trim()) }
    }
}
`;

/**
 * Strip every ModMixer-managed wiring block, returning just the project's own
 * build.gradle. Our blocks are always appended at EOF in order, so everything
 * from the first `// --- ModMixer …` marker on is ours to regenerate. Trailing
 * whitespace is trimmed so re-appending the snippets (each leads with its own
 * blank line) stays tidy and idempotent.
 */
function stripModmixerBlocks(content: string): string {
  const idx = content.indexOf(MODMIXER_MARKER_PREFIX);
  const head = idx < 0 ? content : content.slice(0, idx);
  return head.replace(/\s+$/, '');
}

/**
 * Ensure the build.gradle has the CURRENT ModMixer test-loop wiring. Strips any
 * existing ModMixer block(s) and re-appends the current snippets, so a project
 * scaffolded against an OLDER wiring version is upgraded in place (the launch
 * path calls this before every run to self-heal older projects) — not merely
 * left alone because a marker is present. Idempotent: regenerating identical
 * wiring produces identical bytes and skips the write. No-op when the file is
 * missing.
 */
export async function ensureModmixerWiring(
  buildGradlePath: string,
): Promise<void> {
  if (!fs.existsSync(buildGradlePath)) return;
  const existing = await fsp.readFile(buildGradlePath, 'utf8');
  const next = stripModmixerBlocks(existing) + BRIDGE_SNIPPET + COMPANION_SNIPPET;
  if (next !== existing) await fsp.writeFile(buildGradlePath, next, 'utf8');
}

// The MDK example mod's identity, which we rename to the scaffolded mod's.
const EXAMPLE_GROUP = 'com.example.examplemod';
const EXAMPLE_ID = 'examplemod';
const RENAME_TEXT_EXT = new Set(['.java', '.json', '.toml', '.mcmeta', '.txt', '.cfg']);

async function walkFiles(dir: string, cb: (file: string) => Promise<void>): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walkFiles(full, cb);
    else await cb(full);
  }
}

/** Recursively remove directories left empty after a move. */
async function pruneEmptyDirs(dir: string): Promise<void> {
  if (!fs.existsSync(dir)) return;
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) await pruneEmptyDirs(path.join(dir, e.name));
  }
  if ((await fsp.readdir(dir)).length === 0) await fsp.rmdir(dir);
}

/**
 * Rebrand a mod's id + group across all sources and resources, moving the Java
 * package + resource-namespace dirs to match. Used to rename the MDK's bundled
 * example (`examplemod`) at scaffold time, and again when the user names the mod
 * (set_mod_metadata). String-replacing the OLD id→NEW id everywhere keeps any
 * agent-written code correct too. No-op when nothing changes.
 */
export async function renameModId(
  modDir: string,
  fromId: string,
  fromGroup: string,
  toId: string,
  toGroup: string,
): Promise<void> {
  const srcDir = path.join(modDir, 'src');
  if (!fs.existsSync(srcDir)) return;
  if (fromId === toId && fromGroup === toGroup) return;

  // 1. Text replacements. Replace the fully-qualified group FIRST (it contains
  //    the bare id as a substring), then the standalone mod id.
  await walkFiles(srcDir, async (file) => {
    if (!RENAME_TEXT_EXT.has(path.extname(file))) return;
    const orig = await fsp.readFile(file, 'utf8');
    let next = orig;
    if (fromGroup !== toGroup) next = next.split(fromGroup).join(toGroup);
    if (fromId !== toId) next = next.split(fromId).join(toId);
    if (next !== orig) await fsp.writeFile(file, next, 'utf8');
  });

  // 2. Move the Java package dir to match the new group.
  const javaRoot = path.join(modDir, 'src', 'main', 'java');
  const oldPkg = path.join(javaRoot, ...fromGroup.split('.'));
  const newPkg = path.join(javaRoot, ...toGroup.split('.'));
  if (fs.existsSync(oldPkg) && path.resolve(oldPkg) !== path.resolve(newPkg)) {
    await fsp.mkdir(path.dirname(newPkg), { recursive: true });
    await fsp.rename(oldPkg, newPkg);
    await pruneEmptyDirs(path.join(javaRoot, 'com'));
  }

  // 3. Rename resource namespaces (assets/<id>, data/<id>).
  for (const kind of ['assets', 'data']) {
    const oldNs = path.join(modDir, 'src', 'main', 'resources', kind, fromId);
    const newNs = path.join(modDir, 'src', 'main', 'resources', kind, toId);
    if (fs.existsSync(oldNs) && path.resolve(oldNs) !== path.resolve(newNs)) {
      await fsp.rename(oldNs, newNs);
    }
  }
}

export interface MinecraftMetaPatch {
  name?: string;
  author?: string;
  description?: string;
  /** New mod id (slugified). When it differs from the current id, the whole
   *  project is renamed (Java @Mod id, package, resource namespaces). */
  modId?: string;
  /** New mod version (gradle.properties mod_version). Gradle bakes it into the
   *  jar file name (<mod_id>-<mod_version>.jar) and expands it into the in-jar
   *  neoforge.mods.toml at build time. */
  version?: string;
}

/**
 * Update a Minecraft mod's identity in gradle.properties — the MC analogue of
 * patching About.xml. Renaming mod_id additionally rebrands the project so the
 * @Mod id keeps matching the manifest. Returns the fields that changed.
 */
export async function writeMinecraftMeta(
  modDir: string,
  patch: MinecraftMetaPatch,
): Promise<string[]> {
  const propsPath = path.join(modDir, 'gradle.properties');
  if (!fs.existsSync(propsPath)) {
    throw new Error(`gradle.properties not found in ${modDir}`);
  }
  const current = parseGradleProps(await fsp.readFile(propsPath, 'utf8'));
  const changed: string[] = [];
  const values: Record<string, string> = {};

  if (patch.name && patch.name !== current.mod_name) {
    values.mod_name = patch.name;
    changed.push('name');
  }
  if (patch.author && patch.author !== current.mod_authors) {
    values.mod_authors = patch.author;
    changed.push('author');
  }
  if (patch.description !== undefined) {
    const desc = patch.description.replace(/\n/g, ' ');
    if (desc !== current.mod_description) {
      values.mod_description = desc;
      changed.push('description');
    }
  }
  if (patch.version) {
    const version = patch.version.trim();
    if (version && version !== current.mod_version) {
      values.mod_version = version;
      changed.push('version');
    }
  }

  // mod_id rename: rebrand the project first, then record the new id/group.
  if (patch.modId) {
    const newId = slugifyModId(patch.modId);
    const fromId = current.mod_id || 'examplemod';
    if (newId !== fromId) {
      const fromGroup = current.mod_group_id || `com.modmixer.${fromId}`;
      const toGroup = `com.modmixer.${newId}`;
      await renameModId(modDir, fromId, fromGroup, newId, toGroup);
      values.mod_id = newId;
      values.mod_group_id = toGroup;
      changed.push('modId');
    }
  }

  if (Object.keys(values).length > 0) {
    const patched = patchGradleProperties(
      await fsp.readFile(propsPath, 'utf8'),
      values,
    );
    await fsp.writeFile(propsPath, patched, 'utf8');
  }
  return changed;
}

/** True when the MDK template is vendored (used to gate the MC create flow). */
export function isMinecraftTemplateAvailable(): boolean {
  return templateDir() !== null;
}

/** The vendored MDK template dir, or null. Used by the index workspace too. */
export function getMinecraftTemplateDir(): string | null {
  return templateDir();
}
