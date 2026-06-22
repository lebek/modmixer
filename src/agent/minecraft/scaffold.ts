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

/** Coerce arbitrary text into a valid NeoForge mod id. */
export function slugifyModId(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '')
    .slice(0, 64);
  if (slug.length >= 2) return slug;
  // Pad/guarantee a usable id when the name has too few valid chars.
  return (`mod${slug}`).slice(0, 64).padEnd(2, 'mod');
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
  await renameScaffoldedMod(modDir, modId, groupId);

  await appendBridgeWiring(path.join(modDir, 'build.gradle'));

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
 * Append the ModMixer diagnostics-bridge wiring to a scaffolded mod's
 * build.gradle. It is inert during a normal `gradlew build` and only activates
 * for the test loop's `runClient -PmodmixerBridgeJar=<jar> -Dmodmixer.port=…`:
 *  - the bridge jar (a real FML mod) is put on the run's runtime classpath so
 *    NeoForge discovers and loads it alongside the user's mod; and
 *  - the `modmixer.*` system properties are forwarded to the game JVM so the
 *    bridge can connect back to ModMixer's monitor.
 * Idempotent — skips if the marker is already present.
 */
const BRIDGE_WIRING_MARKER = '// --- ModMixer diagnostics bridge';

async function appendBridgeWiring(buildGradlePath: string): Promise<void> {
  if (!fs.existsSync(buildGradlePath)) return;
  const existing = await fsp.readFile(buildGradlePath, 'utf8');
  if (existing.includes(BRIDGE_WIRING_MARKER)) return;
  const snippet = `

${BRIDGE_WIRING_MARKER} (added by Modmixer) -----------------
// Loaded only for the agent test loop:
//   gradlew runClient -PmodmixerBridgeJar=<jar> -Dmodmixer.port=<port>
if (project.hasProperty('modmixerBridgeJar')) {
    dependencies {
        localRuntime files(project.property('modmixerBridgeJar'))
    }
}
neoForge {
    runs {
        client {
            ['port', 'token', 'testTimeoutMs', 'reportFile'].each { k ->
                def v = System.getProperty("modmixer.\${k}")
                if (v != null) {
                    systemProperty("modmixer.\${k}", v)
                }
            }
        }
    }
}
`;
  await fsp.writeFile(buildGradlePath, existing + snippet, 'utf8');
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
 * Rebrand the MDK's bundled example from `examplemod` / `com.example.examplemod`
 * to the scaffolded mod's id + group across all sources and resources, and move
 * the Java package + resource namespace dirs to match. This is the standard MDK
 * rename, done programmatically so a fresh mod loads instead of erroring on a
 * mod-id mismatch.
 */
async function renameScaffoldedMod(
  modDir: string,
  modId: string,
  groupId: string,
): Promise<void> {
  const srcDir = path.join(modDir, 'src');
  if (!fs.existsSync(srcDir)) return;

  // 1. Text replacements. Replace the fully-qualified group FIRST (it contains
  //    the bare id as a substring), then the standalone mod id.
  await walkFiles(srcDir, async (file) => {
    if (!RENAME_TEXT_EXT.has(path.extname(file))) return;
    const orig = await fsp.readFile(file, 'utf8');
    const next = orig.split(EXAMPLE_GROUP).join(groupId).split(EXAMPLE_ID).join(modId);
    if (next !== orig) await fsp.writeFile(file, next, 'utf8');
  });

  // 2. Move the Java package dir to match the new group.
  const javaRoot = path.join(modDir, 'src', 'main', 'java');
  const oldPkg = path.join(javaRoot, ...EXAMPLE_GROUP.split('.'));
  const newPkg = path.join(javaRoot, ...groupId.split('.'));
  if (fs.existsSync(oldPkg) && path.resolve(oldPkg) !== path.resolve(newPkg)) {
    await fsp.mkdir(path.dirname(newPkg), { recursive: true });
    await fsp.rename(oldPkg, newPkg);
    await pruneEmptyDirs(path.join(javaRoot, 'com'));
  }

  // 3. Rename resource namespaces (assets/<id>, data/<id>).
  for (const kind of ['assets', 'data']) {
    const oldNs = path.join(modDir, 'src', 'main', 'resources', kind, EXAMPLE_ID);
    const newNs = path.join(modDir, 'src', 'main', 'resources', kind, modId);
    if (fs.existsSync(oldNs) && path.resolve(oldNs) !== path.resolve(newNs)) {
      await fsp.rename(oldNs, newNs);
    }
  }
}

/** True when the MDK template is vendored (used to gate the MC create flow). */
export function isMinecraftTemplateAvailable(): boolean {
  return templateDir() !== null;
}
