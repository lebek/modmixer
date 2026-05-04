// Tolerant About.xml parser for the mod registry. We match RimWorld's own
// behavior more than strict XML: case-insensitive tags, BOM-tolerant, ignores
// XML comments inside lists, never throws on malformed input.
//
// This file is the canonical source of truth for parsing About.xml — both the
// registry (for third-party mods) and the workspace (for user-built mods)
// route through it.

export interface AboutXml {
  name: string;
  packageId: string;
  /** Lowercased, deduped, in declaration order. RimWorld matches on lowercase. */
  packageIdLc: string;
  author: string;
  description: string;
  /** Major.Minor strings, e.g. "1.4", "1.5", "1.6". */
  supportedVersions: string[];
  /** Hard dependencies — mod won't load without these. */
  modDependencies: ModDependency[];
  /**
   * Soft "load this mod after X" hints. Used as ordering constraints during
   * autosort but not failure conditions if X is absent.
   */
  loadAfter: string[];
  loadBefore: string[];
  /** Mods this one declares incompatible. Lowercased. */
  incompatibleWith: string[];
}

export interface ModDependency {
  packageId: string;
  packageIdLc: string;
  /** Display name from About.xml, may be empty. */
  displayName: string;
  /** Steam Workshop URL or other distribution link, may be empty. */
  steamWorkshopUrl: string;
  downloadUrl: string;
}

const EMPTY: AboutXml = {
  name: '',
  packageId: '',
  packageIdLc: '',
  author: '',
  description: '',
  supportedVersions: [],
  modDependencies: [],
  loadAfter: [],
  loadBefore: [],
  incompatibleWith: [],
};

export function parseAboutXml(rawXml: string): AboutXml {
  if (!rawXml || typeof rawXml !== 'string') return { ...EMPTY };
  // Strip BOM. RimWorld writes UTF-8 with BOM via Unity's XmlSerializer.
  const xml = rawXml.replace(/^\uFEFF/, '');
  // Mask out nested dependency blocks so a non-greedy <packageId> regex
  // doesn't grab a dep's id (e.g. Zombieland declares <modDependencies>
  // before its own <packageId>).
  const topLevel = stripNestedBlocks(xml);

  const name = extractScalar(topLevel, 'name');
  const packageId = extractScalar(topLevel, 'packageId');
  const author = extractScalar(topLevel, 'author') || extractList(topLevel, 'authors').join(', ');
  const description = extractScalar(topLevel, 'description');
  const supportedVersions = normalizeVersions(extractList(topLevel, 'supportedVersions'));

  return {
    name,
    packageId,
    packageIdLc: packageId.toLowerCase(),
    author,
    description,
    supportedVersions,
    modDependencies: parseDependencies(xml),
    loadAfter: parseListWithVersions(xml, 'loadAfter'),
    loadBefore: parseListWithVersions(xml, 'loadBefore'),
    incompatibleWith: parseListWithVersions(xml, 'incompatibleWith'),
  };
}

// Merge <foo> with <fooByVersion><v1.x>...</v1.x></fooByVersion>. We flatten
// across versions since ModMixer doesn't yet target a specific game version
// per profile — same policy as parseDependencies.
function parseListWithVersions(xml: string, tag: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const v = raw.toLowerCase();
    if (!v || seen.has(v)) return;
    seen.add(v);
    out.push(v);
  };
  for (const v of extractList(xml, tag)) push(v);
  const byVersion = matchOuter(xml, `${tag}ByVersion`);
  if (byVersion) {
    const re = /<v[\d.]+\b[^>]*>([\s\S]*?)<\/v[\d.]+>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(byVersion)) !== null) {
      for (const v of collectItems(m[1])) push(v);
    }
  }
  return out;
}

function stripNestedBlocks(xml: string): string {
  return xml.replace(
    /<(modDependencies|modDependenciesByVersion)\b[^>]*>[\s\S]*?<\/\1>/gi,
    '',
  );
}

function extractScalar(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const m = xml.match(re);
  return decodeEntities((m?.[1] ?? '').trim());
}

function extractList(xml: string, parentTag: string): string[] {
  const wrap = matchOuter(xml, parentTag);
  if (!wrap) return [];
  return collectItems(wrap);
}

function extractListLc(xml: string, parentTag: string): string[] {
  return extractList(xml, parentTag).map((s) => s.toLowerCase());
}

function matchOuter(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const m = xml.match(re);
  return m?.[1] ?? null;
}

function collectItems(inner: string): string[] {
  const items: string[] = [];
  // Strip XML comments so commented-out <li> doesn't sneak in.
  const stripped = inner.replace(/<!--[\s\S]*?-->/g, '');
  const re = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    const v = decodeEntities(m[1].trim());
    if (v) items.push(v);
  }
  return items;
}

function parseDependencies(xml: string): ModDependency[] {
  // Mods declare deps under one of: <modDependencies>, <modDependenciesByVersion>.
  // ByVersion has <v1.5><li>...</li></v1.5> children; we flatten everything for
  // now since ModMixer doesn't yet target a specific game version per profile.
  const deps: ModDependency[] = [];
  const seen = new Set<string>();

  const flat = matchOuter(xml, 'modDependencies');
  if (flat) {
    for (const block of splitListBlocks(flat)) {
      const dep = parseDependencyBlock(block);
      if (dep && !seen.has(dep.packageIdLc)) {
        deps.push(dep);
        seen.add(dep.packageIdLc);
      }
    }
  }
  const byVersion = matchOuter(xml, 'modDependenciesByVersion');
  if (byVersion) {
    // Each child is a version key like <v1.5>...</v1.5> containing <li>blocks.
    const re = /<v[\d.]+\b[^>]*>([\s\S]*?)<\/v[\d.]+>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(byVersion)) !== null) {
      for (const block of splitListBlocks(m[1])) {
        const dep = parseDependencyBlock(block);
        if (dep && !seen.has(dep.packageIdLc)) {
          deps.push(dep);
          seen.add(dep.packageIdLc);
        }
      }
    }
  }
  return deps;
}

function splitListBlocks(inner: string): string[] {
  const stripped = inner.replace(/<!--[\s\S]*?-->/g, '');
  const blocks: string[] = [];
  const re = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    blocks.push(m[1]);
  }
  return blocks;
}

function parseDependencyBlock(block: string): ModDependency | null {
  const packageId = extractScalar(block, 'packageId');
  if (!packageId) return null;
  return {
    packageId,
    packageIdLc: packageId.toLowerCase(),
    displayName: extractScalar(block, 'displayName'),
    steamWorkshopUrl: extractScalar(block, 'steamWorkshopUrl'),
    downloadUrl: extractScalar(block, 'downloadUrl'),
  };
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, n) => String.fromCharCode(parseInt(n, 16)))
    // Decode &amp; LAST so we don't mangle entities like &amp;lt;
    .replace(/&amp;/g, '&');
}

function normalizeVersions(raw: string[]): string[] {
  const out: string[] = [];
  for (const v of raw) {
    // RimWorld accepts "1.5" or "1.5.0". Trim trailing patch since the game
    // matches on major.minor.
    const m = v.match(/^(\d+)\.(\d+)/);
    if (m) out.push(`${m[1]}.${m[2]}`);
  }
  return Array.from(new Set(out));
}
