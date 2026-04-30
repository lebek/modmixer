import { XMLParser } from 'fast-xml-parser';
import type { DefEntry } from './defs-scan.js';

export type DefEdgeKind = 'gameplay' | 'inherits' | 'stat' | 'other';

export interface DefGraphNode {
  /** defName for concrete defs, the abstract Name="..." for abstracts. */
  defName: string;
  /** "" for external nodes — defs the mod references but does not define. */
  defType: string;
  /** Display label. Falls back to defName when no <label> is set. */
  label: string;
  /** True for refs that don't resolve to any in-mod def. */
  isExternal: boolean;
  /** Marked by `Abstract="True"` on the source def. */
  abstract: boolean;
}

export interface DefGraphEdge {
  fromDefName: string;
  toDefName: string;
  /** Player-friendly verb describing the relationship from `from` to `to`. */
  label: string;
  /** Bucket for UI filtering. Most players only care about `gameplay`. */
  kind: DefEdgeKind;
}

export interface DefGraph {
  nodes: DefGraphNode[];
  edges: DefGraphEdge[];
}

/**
 * Direction of the gameplay relationship relative to the XML reference.
 *
 * - `forward`: XML direction matches gameplay flow. The def that owns the XML
 *   produces / has / fires / yields the referenced def. Edge: owner → ref.
 *   Example: `<harvestedThingDef>AcaiBerry</...>` on AcaiPalm — AcaiPalm
 *   produces AcaiBerry, so AcaiPalm → AcaiBerry.
 *
 * - `reverse`: XML direction is opposite of gameplay flow. The referenced def
 *   is a prerequisite/input of the owner. Edge: ref → owner.
 *   Example: `<researchPrerequisites><li>Batteries</li></...>` on Battery —
 *   Batteries unlocks Battery, so Batteries → Battery.
 *
 * Reverse-direction edges let a layered LR layout place inputs to the left
 * of the def and outputs to the right, instead of fanning everything right.
 */
type EdgeDirection = 'forward' | 'reverse';

interface TagSpec {
  kind: DefEdgeKind;
  direction: EdgeDirection;
  label: string;
}

/**
 * Lookup for parent tags whose CHILD value (a leaf string, possibly via `<li>`)
 * is the def reference. Tags not in this table fall through to `other` with
 * the raw tag name as the label.
 */
const LEAF_TAG_SPECS: Record<string, TagSpec> = {
  // What a thing produces / drops / decomposes into.
  harvestedThingDef: { kind: 'gameplay', direction: 'forward', label: 'harvests' },
  meatDef: { kind: 'gameplay', direction: 'forward', label: 'meat' },
  leatherDef: { kind: 'gameplay', direction: 'forward', label: 'leather' },
  corpseDef: { kind: 'gameplay', direction: 'forward', label: 'corpse' },
  eggUnfertilizedDef: { kind: 'gameplay', direction: 'forward', label: 'lays' },
  eggFertilizedDef: { kind: 'gameplay', direction: 'forward', label: 'lays (fertile)' },
  filthLeaving: { kind: 'gameplay', direction: 'forward', label: 'leaves filth' },
  spawnedDefs: { kind: 'gameplay', direction: 'forward', label: 'spawns' },

  // Recipes / ingredients. `thingDefs` and `categories` appear inside an
  // ingredient filter — they're inputs of the owning recipe.
  thingDefs: { kind: 'gameplay', direction: 'reverse', label: 'ingredient of' },
  categories: { kind: 'gameplay', direction: 'reverse', label: 'ingredient of' },
  thingCategories: { kind: 'gameplay', direction: 'forward', label: 'in category' },
  recipeUsers: { kind: 'gameplay', direction: 'reverse', label: 'has recipe' },
  recipes: { kind: 'gameplay', direction: 'forward', label: 'has recipe' },

  // Crafting / construction.
  defaultStuff: { kind: 'gameplay', direction: 'forward', label: 'default material' },
  stuffCategories: { kind: 'gameplay', direction: 'forward', label: 'material' },

  // Research.
  researchPrerequisites: { kind: 'gameplay', direction: 'reverse', label: 'unlocks' },
  requiredResearch: { kind: 'gameplay', direction: 'reverse', label: 'unlocks' },
  prerequisites: { kind: 'gameplay', direction: 'reverse', label: 'unlocks' },

  // Buildings / weapons / projectiles.
  turretGunDef: { kind: 'gameplay', direction: 'forward', label: 'uses gun' },
  // Workbench lists the facilities that boost it; gameplay flow is
  // facility → workbench ("ToolCabinet boosts Workbench").
  linkableFacilities: { kind: 'gameplay', direction: 'reverse', label: 'boosts' },
  // Facility lists the buildings it boosts; same flow direction.
  linkableBuildings: { kind: 'gameplay', direction: 'forward', label: 'boosts' },
  defaultProjectile: { kind: 'gameplay', direction: 'forward', label: 'fires' },
  projectile: { kind: 'gameplay', direction: 'forward', label: 'fires' },
  damageDef: { kind: 'gameplay', direction: 'forward', label: 'damage' },

  // Hediffs — health conditions, drug effects, addictions, prosthetics.
  // The bare `<hediff>` form appears inside HediffGiver / HediffComp lists.
  hediff: { kind: 'gameplay', direction: 'forward', label: 'gives' },
  hediffDef: { kind: 'gameplay', direction: 'forward', label: 'gives' },
  targetHediff: { kind: 'gameplay', direction: 'forward', label: 'gives' },
  addictionHediff: { kind: 'gameplay', direction: 'forward', label: 'causes addiction' },
  toleranceHediff: { kind: 'gameplay', direction: 'forward', label: 'causes tolerance' },
  chemical: { kind: 'gameplay', direction: 'forward', label: 'chemical' },
  replacesPart: { kind: 'gameplay', direction: 'forward', label: 'replaces' },
  spawnThingOnRemoved: { kind: 'gameplay', direction: 'forward', label: 'drops' },
  causesNeed: { kind: 'gameplay', direction: 'forward', label: 'causes need' },
  makesSickThought: { kind: 'gameplay', direction: 'forward', label: 'thought' },
};

/**
 * Lookup for parent tags whose CHILD KEY (PascalCase, leaf value) is the def
 * reference. e.g. `<costList><Steel>20</Steel></costList>` — `Steel` is the
 * def, `20` is the quantity.
 */
const DICT_CONTAINER_SPECS: Record<string, TagSpec> = {
  // Construction / crafting cost — material is a prerequisite of the building.
  costList: { kind: 'gameplay', direction: 'reverse', label: 'builds' },
  costListAdjusted: { kind: 'gameplay', direction: 'reverse', label: 'builds' },

  // Outputs.
  products: { kind: 'gameplay', direction: 'forward', label: 'produces' },
  butcherProducts: { kind: 'gameplay', direction: 'forward', label: 'butcher yields' },
  killedLeavings: { kind: 'gameplay', direction: 'forward', label: 'leaves' },
  smeltProducts: { kind: 'gameplay', direction: 'forward', label: 'smelts to' },

  // Stat dictionaries — meaningful but technical, hidden by default.
  statBases: { kind: 'stat', direction: 'forward', label: 'stat' },
  statOffsets: { kind: 'stat', direction: 'forward', label: 'stat' },
  statFactors: { kind: 'stat', direction: 'forward', label: 'stat' },
  equippedStatOffsets: { kind: 'stat', direction: 'forward', label: 'stat' },
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
  allowBooleanAttributes: true,
  trimValues: true,
});

export function buildDefGraph(defs: DefEntry[]): DefGraph {
  const inModNodes = new Map<string, DefGraphNode>();
  for (const d of defs) {
    const name = d.defName || d.inheritName;
    if (!name) continue;
    if (inModNodes.has(name)) continue;
    inModNodes.set(name, {
      defName: name,
      defType: d.defType,
      label: d.label || name,
      isExternal: false,
      abstract: d.abstract,
    });
  }

  const externalNodes = new Map<string, DefGraphNode>();
  const edgeKeys = new Set<string>();
  const edges: DefGraphEdge[] = [];

  const ensureNode = (name: string) => {
    if (!inModNodes.has(name) && !externalNodes.has(name)) {
      externalNodes.set(name, {
        defName: name,
        defType: '',
        label: name,
        isExternal: true,
        abstract: false,
      });
    }
  };

  const addEdge = (owner: string, ref: string, spec: TagSpec) => {
    if (!owner || !ref || owner === ref) return;
    const [from, to] =
      spec.direction === 'forward' ? [owner, ref] : [ref, owner];
    const key = `${from}\t${to}\t${spec.label}\t${spec.kind}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ fromDefName: from, toDefName: to, label: spec.label, kind: spec.kind });
    ensureNode(to);
    ensureNode(from);
  };

  for (const d of defs) {
    const owner = d.defName || d.inheritName;
    if (!owner) continue;

    if (d.parentName) {
      addEdge(owner, d.parentName, {
        kind: 'inherits',
        direction: 'forward',
        label: 'inherits',
      });
    }

    let parsed: unknown;
    try {
      parsed = parser.parse(d.xml);
    } catch {
      continue;
    }
    const root = (parsed as Record<string, unknown> | undefined)?.[d.defType];
    if (!root || typeof root !== 'object') continue;

    walk(root, null, (target, spec) => addEdge(owner, target, spec));
  }

  return {
    nodes: [...inModNodes.values(), ...externalNodes.values()],
    edges,
  };
}

/**
 * Walk an XML object tree, calling `onRef` for every leaf string OR
 * dictionary key that looks like a def reference. `onRef` receives the
 * looked-up TagSpec for the parent tag, which encodes kind, direction, and
 * a player-friendly label.
 *
 * Two extraction patterns:
 *  1. Leaf-string under a tag ending in `Def`/`Defs` (incl. through `<li>`).
 *  2. PascalCase dict-key with a leaf value (e.g. `<costList><Steel>20`).
 */
function walk(
  value: unknown,
  parentTag: string | null,
  onRef: (target: string, spec: TagSpec) => void,
): void {
  if (value == null) return;
  if (typeof value === 'string') {
    if (!parentTag) return;
    if (!isLeafCandidateTag(parentTag)) return;
    const trimmed = value.trim();
    if (!isPlausibleDefName(trimmed)) return;
    onRef(trimmed, leafSpec(parentTag));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walk(item, parentTag, onRef);
    return;
  }
  if (typeof value !== 'object') return;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k.startsWith('@_')) continue; // attribute
    if (k === '#text') {
      walk(v, parentTag, onRef);
      continue;
    }
    if (parentTag && isPascalCase(k) && isLeafValue(v) && isPlausibleDefName(k)) {
      onRef(k, dictSpec(parentTag));
      continue;
    }
    // For <li> elements, keep the surrounding tag as the relationship label
    // so `<costList><li>Steel</li></costList>` reports "costList".
    const nextTag = k === 'li' ? parentTag : k;
    walk(v, nextTag, onRef);
  }
}

function leafSpec(tag: string): TagSpec {
  return (
    LEAF_TAG_SPECS[tag] ?? { kind: 'other', direction: 'forward', label: tag }
  );
}

function dictSpec(tag: string): TagSpec {
  return (
    DICT_CONTAINER_SPECS[tag] ?? {
      kind: 'other',
      direction: 'forward',
      label: tag,
    }
  );
}

function isPascalCase(s: string): boolean {
  return /^[A-Z][A-Za-z0-9_]*$/.test(s);
}

function isLeafValue(v: unknown): boolean {
  return (
    v == null ||
    typeof v === 'string' ||
    typeof v === 'number' ||
    typeof v === 'boolean'
  );
}

/**
 * Whether a leaf string under this parent tag should be considered a possible
 * def reference. Tags ending in `Def`/`Defs` are caught by the generic
 * heuristic (and become `other` if not curated). Tags in the curated
 * allowlist are accepted regardless of suffix — that's how non-Def-ending
 * tags like `chemical`, `replacesPart`, `addictionHediff` enter the graph.
 */
function isLeafCandidateTag(tag: string): boolean {
  if (Object.prototype.hasOwnProperty.call(LEAF_TAG_SPECS, tag)) return true;
  return /Defs?$/.test(tag);
}

function isPlausibleDefName(s: string): boolean {
  // RimWorld defNames are identifier-like: letters, digits, underscores.
  // Reject empties, whitespace, and obvious non-defs like sentences or numbers.
  if (s.length === 0 || s.length > 100) return false;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) return false;
  return true;
}
