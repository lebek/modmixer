import path from 'node:path';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import { XMLParser } from 'fast-xml-parser';

/**
 * Post-build lints for common RimWorld footguns. These are gotchas where the
 * build is green but the mod is broken at runtime in a non-obvious way (no
 * error in Player.log, behavior just silently doesn't happen). Each lesson
 * here is something the agent had to discover live during a test session in
 * a previous run; surfacing them at build time saves a quit→relaunch cycle.
 *
 * The lint is best-effort and side-effect-free: we read XML + .cs files, log
 * findings, and append them to the build output. We do NOT mutate anything.
 * If a check fails to run (malformed XML, IO error), we skip it silently —
 * the build itself is the source of truth for "did this compile."
 */

export interface LintFinding {
  /** Short rule id, e.g. "tickerType-missing". */
  rule: string;
  /** One-line problem description. */
  message: string;
  /** Workspace-relative file the finding points at. */
  file?: string;
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
  allowBooleanAttributes: true,
  trimValues: true,
});

/**
 * Walk a directory recursively, returning every file matching one of the
 * given extensions. Skips `bin/`, `obj/`, and `.git/` since those contain
 * build outputs we don't want to scan.
 */
async function walkFiles(
  root: string,
  extensions: string[],
): Promise<string[]> {
  const out: string[] = [];
  if (!fs.existsSync(root)) return out;
  async function recurse(dir: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory()) {
        if (entry.name === 'bin' || entry.name === 'obj') continue;
        await recurse(path.join(dir, entry.name));
        continue;
      }
      if (
        entry.isFile() &&
        extensions.some((ext) => entry.name.endsWith(ext))
      ) {
        out.push(path.join(dir, entry.name));
      }
    }
  }
  await recurse(root);
  return out;
}

/**
 * Find every C# class that names CompProperties_* in its CompProperties
 * subclass. Pairs with `findThingDefsUsingCompClass` so we can detect a
 * ThingDef that uses one of these comps but doesn't set a tickerType.
 *
 * The match is intentionally loose — we look for class declarations whose
 * names contain `CompProperties_`, then walk back to the override list.
 * False positives here lint a real ThingDef and hint at the wrong comp; the
 * fix (add tickerType) is the same either way, so the cost is low.
 */
interface CompClassInfo {
  /** Comp class name, e.g. "CompPhantomCamera". */
  compClass: string;
  /** Matching properties class, e.g. "CompProperties_PhantomCamera". */
  compPropertiesClass: string;
  /** "Rare" if the comp overrides CompTickRare, "Normal" if CompTick, null otherwise. */
  needsTickerType: 'Rare' | 'Normal' | null;
}

const COMP_CLASS_RE =
  /\bclass\s+(Comp[A-Za-z0-9_]+)\s*:\s*(?:Verse\.|RimWorld\.)?(ThingComp|CompPower\w*|CompFlickable|CompForbiddable|Comp[A-Z][A-Za-z0-9_]*)\b/g;
const COMP_PROPERTIES_CLASS_RE =
  /\bclass\s+(CompProperties_[A-Za-z0-9_]+)\s*:\s*(?:Verse\.|RimWorld\.)?CompProperties\b/g;
const COMP_CLASS_NAME_INSIDE_PROPS_RE =
  /\bcompClass\s*=\s*typeof\s*\(\s*([A-Za-z0-9_.]+)\s*\)/;
const TICK_RARE_OVERRIDE_RE = /\boverride\s+\w+\s+CompTickRare\s*\(/;
const TICK_OVERRIDE_RE = /\boverride\s+\w+\s+CompTick\s*\(/;
const TICK_LONG_OVERRIDE_RE = /\boverride\s+\w+\s+CompTickLong\s*\(/;

/**
 * Read every .cs file under sourceDir and identify CompProperties classes
 * whose paired Comp class overrides CompTick / CompTickRare / CompTickLong.
 * The map key is the CompProperties class name (which is what the ThingDef
 * XML references via `Class="..."`).
 */
async function findTickRequiringComps(
  sourceDir: string,
): Promise<Map<string, CompClassInfo>> {
  const out = new Map<string, CompClassInfo>();
  const files = await walkFiles(sourceDir, ['.cs']);
  for (const file of files) {
    let text: string;
    try {
      text = await fsp.readFile(file, 'utf8');
    } catch {
      continue;
    }
    // Strip line + block comments so we don't trip on commented-out
    // overrides. Cheap text scrub; a real C# parser would be overkill.
    const stripped = text
      .replace(/\/\/[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    // Walk every CompProperties subclass and find its compClass typeof(...)
    // assignment. If the matching Comp class overrides a tick method, mark
    // it.
    let m: RegExpExecArray | null;
    COMP_PROPERTIES_CLASS_RE.lastIndex = 0;
    while ((m = COMP_PROPERTIES_CLASS_RE.exec(stripped)) !== null) {
      const propsName = m[1];
      // Find the body of this class to look for compClass=typeof(X). Take a
      // window of the next ~600 chars after the match — sufficient for the
      // typical "compClass = typeof(...)" line in the field initializer.
      const windowStart = m.index;
      const windowEnd = Math.min(stripped.length, windowStart + 600);
      const window = stripped.slice(windowStart, windowEnd);
      const compMatch = COMP_CLASS_NAME_INSIDE_PROPS_RE.exec(window);
      if (!compMatch) continue;
      const compClass = compMatch[1].split('.').pop() ?? compMatch[1];
      // Find the comp class anywhere in the corpus and check overrides.
      // Re-scan files; cheap because we already loaded them.
      let needs: 'Rare' | 'Normal' | null = null;
      for (const otherFile of files) {
        let other: string;
        try {
          other = await fsp.readFile(otherFile, 'utf8');
        } catch {
          continue;
        }
        const otherStripped = other
          .replace(/\/\/[^\n]*/g, '')
          .replace(/\/\*[\s\S]*?\*\//g, '');
        const classRe = new RegExp(
          `\\bclass\\s+${compClass}\\s*:`,
        );
        const classMatch = classRe.exec(otherStripped);
        if (!classMatch) continue;
        // Look at the rest of the file from this match for tick overrides.
        const body = otherStripped.slice(classMatch.index);
        if (TICK_RARE_OVERRIDE_RE.test(body)) needs = 'Rare';
        else if (TICK_OVERRIDE_RE.test(body)) needs = 'Normal';
        else if (TICK_LONG_OVERRIDE_RE.test(body)) needs = 'Rare'; // Long requires non-Never too
        break;
      }
      if (needs) {
        out.set(propsName, {
          compClass,
          compPropertiesClass: propsName,
          needsTickerType: needs,
        });
      }
    }
  }
  // Reset the global regex lastIndex so subsequent calls start clean.
  COMP_CLASS_RE.lastIndex = 0;
  return out;
}

/**
 * Walk Defs/**.xml and check every ThingDef for the tickerType-vs-comp
 * mismatch: if it references a tick-requiring comp via `<comps><li
 * Class="CompProperties_X">` but has no `<tickerType>` (default = Never),
 * the comp will silently never tick.
 */
async function checkTickerType(
  defsDir: string,
  modDir: string,
  tickComps: Map<string, CompClassInfo>,
  findings: LintFinding[],
): Promise<void> {
  if (tickComps.size === 0) return;
  const xmlFiles = await walkFiles(defsDir, ['.xml']);
  for (const file of xmlFiles) {
    let raw: string;
    try {
      raw = await fsp.readFile(file, 'utf8');
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = xmlParser.parse(raw);
    } catch {
      continue;
    }
    const root = (parsed as Record<string, unknown> | undefined)?.Defs;
    if (!root || typeof root !== 'object') continue;
    for (const [defType, value] of Object.entries(
      root as Record<string, unknown>,
    )) {
      // ThingDefs are the common case; SpecialThingFilterDef etc. don't tick.
      if (defType !== 'ThingDef') continue;
      const items = Array.isArray(value) ? value : [value];
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const obj = item as Record<string, unknown>;
        const isAbstract = obj['@_Abstract'] === 'True' || obj['@_Abstract'] === true;
        if (isAbstract) continue; // abstract bases can omit tickerType
        const comps = obj.comps;
        if (!comps || typeof comps !== 'object') continue;
        const li = (comps as Record<string, unknown>).li;
        const liArr = Array.isArray(li) ? li : li ? [li] : [];
        const usedTickComp = liArr.find((entry) => {
          if (!entry || typeof entry !== 'object') return false;
          const cls = (entry as Record<string, unknown>)['@_Class'];
          if (typeof cls !== 'string') return false;
          // Strip "Namespace." prefix — XML allows fully-qualified Class names.
          const bare = cls.split('.').pop() ?? cls;
          return tickComps.has(bare);
        });
        if (!usedTickComp) continue;
        const tickerType = obj.tickerType;
        if (
          typeof tickerType === 'string' &&
          tickerType.trim().length > 0 &&
          tickerType.trim().toLowerCase() !== 'never'
        ) {
          continue;
        }
        const compClassRaw = (
          (usedTickComp as Record<string, unknown>)['@_Class'] as string
        );
        const compName = compClassRaw.split('.').pop() ?? compClassRaw;
        const tickInfo = tickComps.get(compName);
        // The find() above already confirmed this comp is in the map, but
        // narrow once more so we don't carry a non-null assertion.
        if (!tickInfo) continue;
        const defName = typeof obj.defName === 'string' ? obj.defName : '(unnamed)';
        findings.push({
          rule: 'tickerType-missing',
          file: path.relative(modDir, file),
          message: `ThingDef ${defName} uses ${compName} (which overrides CompTick${
            tickInfo.needsTickerType === 'Rare' ? 'Rare' : ''
          }) but has no <tickerType>. Default is Never, so the comp will load and PostSpawnSetup will run, but tick callbacks will never fire — the comp's behavior will silently do nothing. Add <tickerType>${tickInfo.needsTickerType}</tickerType> to the def.`,
        });
      }
    }
  }
}

/**
 * Scan the .csproj for `<TargetFramework>netstandard*</TargetFramework>`.
 * RimWorld 1.6's Assembly-CSharp targets netstandard2.1 and the mismatch
 * will surface as a runtime version conflict; net472 is the right answer.
 * Most scaffolds get this right, but the agent occasionally regenerates
 * a csproj from memory and lands on netstandard2.0.
 */
async function checkTargetFramework(
  sourceDir: string,
  modDir: string,
  findings: LintFinding[],
): Promise<void> {
  const csprojFiles = await walkFiles(sourceDir, ['.csproj']);
  for (const file of csprojFiles) {
    let text: string;
    try {
      text = await fsp.readFile(file, 'utf8');
    } catch {
      continue;
    }
    const m = /<TargetFramework>([^<]+)<\/TargetFramework>/.exec(text);
    if (!m) continue;
    const tfm = m[1].trim();
    if (/^netstandard/i.test(tfm)) {
      findings.push({
        rule: 'wrong-target-framework',
        file: path.relative(modDir, file),
        message: `TargetFramework is ${tfm}. RimWorld mods must target net472 (the runtime is Unity Mono with the .NET Framework 4.7.2 surface). netstandard targets will load but will hit version conflicts against RimWorld's netstandard2.1 Assembly-CSharp.`,
      });
    }
  }
}

/**
 * Run all lints. Returns a list of findings (possibly empty). The build
 * tool calls this and appends a section to the build output.
 */
export async function lintMod(modDir: string): Promise<LintFinding[]> {
  const findings: LintFinding[] = [];
  const sourceDir = path.join(modDir, 'Source');
  const defsDir = path.join(modDir, 'Defs');

  try {
    await checkTargetFramework(sourceDir, modDir, findings);
  } catch (err) {
    console.warn('[build-lint] target-framework check failed:', err);
  }

  try {
    const tickComps = await findTickRequiringComps(sourceDir);
    await checkTickerType(defsDir, modDir, tickComps, findings);
  } catch (err) {
    console.warn('[build-lint] tickerType check failed:', err);
  }

  return findings;
}

/**
 * Format findings as a human-readable block. Returns an empty string when
 * there are no findings so the build tool can short-circuit.
 */
export function formatFindings(findings: LintFinding[]): string {
  if (findings.length === 0) return '';
  const header = `\n--- modmixer lint (${findings.length} ${
    findings.length === 1 ? 'finding' : 'findings'
  }) ---\n`;
  const body = findings
    .map((f, i) => {
      const loc = f.file ? ` [${f.file}]` : '';
      return `${i + 1}. ${f.rule}${loc}: ${f.message}`;
    })
    .join('\n');
  const footer =
    '\n\nThese are non-fatal warnings — your build is unchanged. They flag patterns that compile cleanly but break at runtime.';
  return `${header}${body}${footer}\n`;
}
