import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { XMLParser, XMLBuilder } from 'fast-xml-parser';
import { getWorkspacePaths } from './workspace.js';

export interface DefEntry {
  /** XML element name, e.g. "ThingDef", "JobDef", "RecipeDef". */
  defType: string;
  /** Empty for abstract bases that use Name="..." instead. */
  defName: string;
  /** RimWorld convention for the in-game display name. */
  label: string;
  /** Player-facing description from the def. May be multiline. */
  description: string;
  /** XML attribute `ParentName="..."` if this def extends another. */
  parentName: string | null;
  /** XML attribute `Name="..."` for abstract bases that other defs extend. */
  inheritName: string | null;
  /** XML attribute `Abstract="True"`. */
  abstract: boolean;
  /** Path relative to the mod root, e.g. "Defs/ThingDefs/MyThing.xml". */
  file: string;
  /** Re-serialized XML for this single def, suitable for read-only display. */
  xml: string;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
  allowBooleanAttributes: true,
  trimValues: true,
});

const builder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  format: true,
  indentBy: '  ',
  suppressEmptyNode: false,
});

export async function scanDefs(folder: string): Promise<DefEntry[]> {
  const { workspaceDir } = getWorkspacePaths();
  const modDir = path.join(workspaceDir, folder);
  const defsRoot = path.join(modDir, 'Defs');
  if (!fs.existsSync(defsRoot)) return [];

  const files = await walkXml(defsRoot);
  const out: DefEntry[] = [];
  for (const file of files) {
    let raw: string;
    try {
      raw = await fsp.readFile(file, 'utf8');
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = parser.parse(raw);
    } catch {
      // Skip malformed XML rather than failing the whole scan.
      continue;
    }
    const root = (parsed as Record<string, unknown> | undefined)?.Defs;
    if (!root || typeof root !== 'object') continue;
    const rel = path.relative(modDir, file);
    for (const [defType, value] of Object.entries(
      root as Record<string, unknown>,
    )) {
      const items = Array.isArray(value) ? value : [value];
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const obj = item as Record<string, unknown>;
        const xml = builder.build({ [defType]: obj }).toString().trim();
        out.push({
          defType,
          defName: stringField(obj.defName),
          label: stringField(obj.label),
          description: stringField(obj.description),
          parentName: stringAttr(obj['@_ParentName']),
          inheritName: stringAttr(obj['@_Name']),
          abstract: boolAttr(obj['@_Abstract']),
          file: rel,
          xml,
        });
      }
    }
  }
  out.sort((a, b) => {
    if (a.defType !== b.defType) return a.defType.localeCompare(b.defType);
    const aKey = a.defName || a.inheritName || a.label;
    const bKey = b.defName || b.inheritName || b.label;
    return aKey.localeCompare(bKey);
  });
  return out;
}

function stringField(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

function stringAttr(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function boolAttr(v: unknown): boolean {
  return v === true || v === 'True' || v === 'true';
}

async function walkXml(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function go(d: string) {
    let entries;
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) await go(p);
      else if (e.isFile() && e.name.toLowerCase().endsWith('.xml')) out.push(p);
    }
  }
  await go(dir);
  return out;
}
