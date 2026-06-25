import { parse as parseToml } from 'smol-toml';

/**
 * Pure parsing of a mod jar's manifest into mod descriptors — deliberately
 * free of any filesystem / Electron imports so it's unit-testable in isolation.
 * The I/O (reading the entry out of a jar, attaching jar/instance context) lives
 * in mods-registry.ts. A jar can declare more than one mod, so this returns an
 * array.
 */

export type ModLoader = 'neoforge' | 'forge' | 'fabric' | 'unknown';

export interface MinecraftModDependency {
  modId: string;
  /** required | optional | incompatible | discouraged (forge's mandatory bool maps to required/optional). */
  type: string;
  versionRange?: string;
  ordering?: string;
  side?: string;
}

export interface ParsedMod {
  modId: string;
  displayName: string;
  version: string;
  authors: string | null;
  description: string | null;
  loader: ModLoader;
  dependencies: MinecraftModDependency[];
}

export interface ManifestInput {
  /** META-INF/neoforge.mods.toml contents, if present. */
  neoforgeToml?: string | null;
  /** META-INF/mods.toml (legacy Forge) contents, if present. */
  modsToml?: string | null;
  /** fabric.mod.json contents, if present. */
  fabricJson?: string | null;
  /** Id/name to use when no manifest parses (typically the jar's filename stem). */
  fallbackId: string;
}

// --- tolerant coercion (manifests are user-authored; never trust the shape) --

function asStr(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}
function normDesc(v: unknown): string | null {
  const s = asStr(v)?.trim();
  return s && s.length > 0 ? s : null;
}
function normAuthors(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() || null;
  if (Array.isArray(v)) {
    const names = v
      .map((a) => (typeof a === 'string' ? a : asStr(asRecord(a).name)))
      .filter((n): n is string => !!n && n.trim().length > 0);
    return names.length ? names.join(', ') : null;
  }
  return null;
}

function mapTomlDeps(raw: unknown[]): MinecraftModDependency[] {
  return raw.map((d) => {
    const r = asRecord(d);
    let type = asStr(r.type) ?? undefined;
    // Legacy Forge used a `mandatory` boolean instead of NeoForge's `type`.
    if (!type && typeof r.mandatory === 'boolean') {
      type = r.mandatory ? 'required' : 'optional';
    }
    return {
      modId: asStr(r.modId) ?? 'unknown',
      type: type ?? 'required',
      versionRange: asStr(r.versionRange) ?? undefined,
      ordering: asStr(r.ordering) ?? undefined,
      side: asStr(r.side) ?? undefined,
    };
  });
}

function safeParseToml(raw: string): Record<string, unknown> | null {
  try {
    return parseToml(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** NeoForge / legacy-Forge `*.mods.toml`: a `[[mods]]` array + `[dependencies.<id>]` tables. */
function tomlMods(
  parsed: Record<string, unknown>,
  loader: ModLoader,
  fallbackId: string,
): ParsedMod[] {
  const mods = asArray(parsed.mods);
  const depsTable = asRecord(parsed.dependencies);
  return mods.map((mRaw) => {
    const m = asRecord(mRaw);
    const modId = asStr(m.modId) ?? fallbackId;
    return {
      modId,
      displayName: asStr(m.displayName) ?? modId,
      version: asStr(m.version) ?? 'unknown',
      authors: normAuthors(m.authors),
      description: normDesc(m.description),
      loader,
      dependencies: mapTomlDeps(asArray(depsTable[modId])),
    };
  });
}

function fabricMod(raw: string, fallbackId: string): ParsedMod | null {
  let json: Record<string, unknown>;
  try {
    json = asRecord(JSON.parse(raw));
  } catch {
    return null;
  }
  const modId = asStr(json.id) ?? fallbackId;
  const depends = asRecord(json.depends);
  const deps: MinecraftModDependency[] = Object.entries(depends).map(
    ([id, range]) => ({
      modId: id,
      type: 'required',
      versionRange:
        typeof range === 'string'
          ? range
          : Array.isArray(range)
            ? range.map(String).join(' || ')
            : undefined,
    }),
  );
  return {
    modId,
    displayName: asStr(json.name) ?? modId,
    version: asStr(json.version) ?? 'unknown',
    authors: normAuthors(json.authors),
    description: normDesc(json.description),
    loader: 'fabric',
    dependencies: deps,
  };
}

/**
 * Resolve a jar's manifest to mod descriptors, trying NeoForge → legacy Forge →
 * Fabric → an "unknown" filename-only fallback (so even a plain library jar is
 * still listable and inspectable).
 */
export function parseModManifest(input: ManifestInput): ParsedMod[] {
  for (const [raw, loader] of [
    [input.neoforgeToml, 'neoforge'],
    [input.modsToml, 'forge'],
  ] as const) {
    if (!raw) continue;
    const parsed = safeParseToml(raw);
    if (!parsed) continue;
    const mods = tomlMods(parsed, loader, input.fallbackId);
    if (mods.length > 0) return mods;
  }
  if (input.fabricJson) {
    const fab = fabricMod(input.fabricJson, input.fallbackId);
    if (fab) return [fab];
  }
  return [
    {
      modId: input.fallbackId,
      displayName: input.fallbackId,
      version: 'unknown',
      authors: null,
      description: null,
      loader: 'unknown',
      dependencies: [],
    },
  ];
}
