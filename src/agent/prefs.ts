import fsp from 'node:fs/promises';
import { detectRimWorldPaths } from './paths.js';
import { isRimWorldRunning } from './game.js';

export interface PrepareDebugSessionOptions {
  /** Pin these entries to the debug action palette. Format: 'Category\\Action Name' (single backslash). */
  paletteEntries?: string[];
  /** When true, write <quickStartDevPaletteOn>True</quickStartDevPaletteOn> so the palette is visible the moment the game loads in. Defaults to true. */
  autoOpenPalette?: boolean;
}

export interface PrepareDebugSessionResult {
  /**
   * True when Prefs.xml didn't exist yet (RimWorld has never been launched on
   * this machine, or the user wiped their config). The caller continues with
   * the launch — RimWorld creates Prefs.xml on first quit, and a follow-up
   * call after that will succeed. The remaining fields hold defaults.
   */
  skipped: boolean;
  /** Human-readable reason when `skipped` is true. */
  skipReason: string | null;
  /** Absolute path that would have been edited; null when Prefs.xml is absent. */
  prefsPath: string | null;
  devModeWasOn: boolean;
  autoOpenPaletteWasOn: boolean;
  pinnedNew: string[];
  pinnedAlready: string[];
}

/**
 * Edit RimWorld's Prefs.xml to:
 *  1. enable dev mode (`<devMode>True</devMode>`)
 *  2. optionally auto-open the debug action palette on game load
 *     (`<quickStartDevPaletteOn>True</quickStartDevPaletteOn>`)
 *  3. append the given entries to `<debugActionPalette>` so they show up
 *     pinned the moment the user lands in-game.
 *
 * If Prefs.xml doesn't exist (RimWorld never launched on this machine yet),
 * we return `skipped: true` instead of throwing — the test-in-game flow
 * still proceeds, the game creates Prefs.xml on its first quit, and a
 * subsequent call lands cleanly.
 *
 * RimWorld must be CLOSED — the game rewrites Prefs.xml on quit via
 * `Prefs.Save()`, the same hazard as ModsConfig.xml. That precondition is a
 * hard error (still throws), since proceeding would silently lose the edit.
 */
export async function prepareDebugSession(
  opts: PrepareDebugSessionOptions = {},
): Promise<PrepareDebugSessionResult> {
  const { prefsXml } = detectRimWorldPaths();
  if (!prefsXml) {
    return {
      skipped: true,
      skipReason:
        'Prefs.xml not found — RimWorld has not been launched on this machine yet. The game will create it on first quit; rerun this tool after that to enable dev mode.',
      prefsPath: null,
      devModeWasOn: false,
      autoOpenPaletteWasOn: false,
      pinnedNew: [],
      pinnedAlready: [],
    };
  }
  if (await isRimWorldRunning()) {
    throw new Error(
      "RimWorld is currently running. Edits to Prefs.xml are overwritten when the game quits. Quit RimWorld first, then retry.",
    );
  }

  const autoOpen = opts.autoOpenPalette ?? true;
  const entries = (opts.paletteEntries ?? []).filter((e) => e.trim().length > 0);

  let xml = await fsp.readFile(prefsXml, 'utf8');

  // 1. devMode → True. Either flip an existing False or insert a new element
  // before </PrefsData>.
  const devModeMatch = xml.match(/<devMode>(True|False)<\/devMode>/);
  const devModeWasOn = devModeMatch?.[1] === 'True';
  if (devModeMatch) {
    if (!devModeWasOn) {
      xml = xml.replace(/<devMode>False<\/devMode>/, '<devMode>True</devMode>');
    }
  } else {
    xml = insertBeforeClose(xml, '  <devMode>True</devMode>');
  }

  // 2. quickStartDevPaletteOn → True (when autoOpen is requested).
  const quickStartMatch = xml.match(
    /<quickStartDevPaletteOn>(True|False)<\/quickStartDevPaletteOn>/,
  );
  const autoOpenPaletteWasOn = quickStartMatch?.[1] === 'True';
  if (autoOpen) {
    if (quickStartMatch) {
      if (!autoOpenPaletteWasOn) {
        xml = xml.replace(
          /<quickStartDevPaletteOn>False<\/quickStartDevPaletteOn>/,
          '<quickStartDevPaletteOn>True</quickStartDevPaletteOn>',
        );
      }
    } else {
      xml = insertBeforeClose(
        xml,
        '  <quickStartDevPaletteOn>True</quickStartDevPaletteOn>',
      );
    }
  }

  // 3. Pin entries to <debugActionPalette>. The element may be missing,
  // self-closed, or populated.
  const pinnedNew: string[] = [];
  const pinnedAlready: string[] = [];
  if (entries.length > 0) {
    const existing = readPaletteEntries(xml);
    const existingSet = new Set(existing);
    const toAdd: string[] = [];
    for (const entry of entries) {
      if (existingSet.has(entry)) {
        pinnedAlready.push(entry);
      } else {
        toAdd.push(entry);
        pinnedNew.push(entry);
        existingSet.add(entry);
      }
    }
    if (toAdd.length > 0) {
      xml = appendPaletteEntries(xml, toAdd);
    }
  }

  await fsp.writeFile(prefsXml, xml);
  return {
    skipped: false,
    skipReason: null,
    prefsPath: prefsXml,
    devModeWasOn,
    autoOpenPaletteWasOn,
    pinnedNew,
    pinnedAlready,
  };
}

function insertBeforeClose(xml: string, line: string): string {
  return xml.replace(/(\s*)<\/PrefsData>/, `\n${line}$1</PrefsData>`);
}

function readPaletteEntries(xml: string): string[] {
  const block = xml.match(/<debugActionPalette>([\s\S]*?)<\/debugActionPalette>/);
  if (!block) return [];
  return Array.from(block[1].matchAll(/<li>([\s\S]*?)<\/li>/g)).map((m) =>
    m[1].trim(),
  );
}

function appendPaletteEntries(xml: string, entries: string[]): string {
  const lines = entries.map((e) => `    <li>${escapeXml(e)}</li>`).join('\n');
  // Self-closed form: <debugActionPalette />
  if (/<debugActionPalette\s*\/>/.test(xml)) {
    return xml.replace(
      /<debugActionPalette\s*\/>/,
      `<debugActionPalette>\n${lines}\n  </debugActionPalette>`,
    );
  }
  // Populated form: insert before </debugActionPalette>.
  if (/<debugActionPalette>[\s\S]*?<\/debugActionPalette>/.test(xml)) {
    return xml.replace(
      /(\s*)<\/debugActionPalette>/,
      `\n${lines}$1</debugActionPalette>`,
    );
  }
  // Element missing entirely: insert a fresh block before </PrefsData>.
  return insertBeforeClose(
    xml,
    `  <debugActionPalette>\n${lines}\n  </debugActionPalette>`,
  );
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
