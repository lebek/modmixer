import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { getWorkspacePaths } from './workspace.js';

/**
 * The Schematic is the agent's running spec for a mod — what it includes,
 * how it works, and a one-sentence pitch. It is the agent's, not the user's:
 * the UI surfaces it read-only, and it lives in a sidecar instead of
 * About.xml so it never ships to the Steam Workshop.
 */
export interface SchematicData {
  /**
   * One-sentence summary (~300 chars max) shown in the mod browser and chat
   * header. Kept in sync by the agent as the mod's pitch evolves.
   */
  shortDescription: string;
  /**
   * Markdown body explaining every feature the mod adds and how it works.
   * The Schematic page also renders a live Definitions list pulled from the
   * mod's Defs/ folder, so the body should describe behavior, not restate
   * raw XML.
   */
  body: string;
}

const SIDECAR_DIR = '.modmixer';
const SIDECAR_FILE = 'schematic.json';

function sidecarPath(folder: string): string {
  const { workspaceDir } = getWorkspacePaths();
  return path.join(workspaceDir, folder, SIDECAR_DIR, SIDECAR_FILE);
}

function emptySchematic(): SchematicData {
  return { shortDescription: '', body: '' };
}

function parseSchematic(raw: string): SchematicData {
  try {
    const parsed = JSON.parse(raw) as Partial<SchematicData>;
    return {
      shortDescription:
        typeof parsed.shortDescription === 'string'
          ? parsed.shortDescription
          : '',
      body: typeof parsed.body === 'string' ? parsed.body : '',
    };
  } catch {
    return emptySchematic();
  }
}

/**
 * Read the schematic for a workspace mod. Returns null only if the mod
 * folder itself doesn't exist; if the folder exists but the sidecar doesn't,
 * returns an empty schematic so callers always get a usable shape.
 */
export async function readSchematic(folder: string): Promise<SchematicData | null> {
  const { workspaceDir } = getWorkspacePaths();
  const modDir = path.join(workspaceDir, folder);
  if (!fs.existsSync(modDir)) return null;
  const file = sidecarPath(folder);
  if (!fs.existsSync(file)) return emptySchematic();
  // Corrupt/unreadable sidecar — treat as empty rather than blowing up the
  // mod browser. The next agent write will overwrite cleanly.
  try {
    return parseSchematic(await fsp.readFile(file, 'utf8'));
  } catch {
    return emptySchematic();
  }
}

// Sync variant for callers that have to remain synchronous (currently
// `buildSystemPrompt`, which is treated as a stable conversation identifier
// and intentionally avoids async fan-out).
export function readSchematicSync(folder: string): SchematicData | null {
  const { workspaceDir } = getWorkspacePaths();
  const modDir = path.join(workspaceDir, folder);
  if (!fs.existsSync(modDir)) return null;
  const file = sidecarPath(folder);
  if (!fs.existsSync(file)) return emptySchematic();
  try {
    return parseSchematic(fs.readFileSync(file, 'utf8'));
  } catch {
    return emptySchematic();
  }
}

export async function writeSchematic(
  folder: string,
  patch: Partial<SchematicData>,
): Promise<SchematicData | null> {
  const { workspaceDir } = getWorkspacePaths();
  const modDir = path.join(workspaceDir, folder);
  if (!fs.existsSync(modDir)) return null;
  const current = (await readSchematic(folder)) ?? emptySchematic();
  const next: SchematicData = {
    shortDescription:
      typeof patch.shortDescription === 'string'
        ? patch.shortDescription
        : current.shortDescription,
    body: typeof patch.body === 'string' ? patch.body : current.body,
  };
  await fsp.mkdir(path.join(modDir, SIDECAR_DIR), { recursive: true });
  await fsp.writeFile(sidecarPath(folder), JSON.stringify(next, null, 2), 'utf8');
  return next;
}
