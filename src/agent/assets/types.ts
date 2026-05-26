// Shared types for the assets feature. Importable from both main and renderer.

export type AssetKind = 'texture' | 'audio' | 'icon';

export interface TextureSpec {
  kind: 'texture' | 'icon';
  format: 'png';
  /** Hint for typical sizing — purely informational. */
  sizeHint?: string;
}

export interface AudioSpec {
  kind: 'audio';
  format: 'ogg';
}

export type AssetSpec = TextureSpec | AudioSpec;

/**
 * A single ref site in the mod's source — one <texPath>, one ContentFinder<>.Get,
 * one expanded directional sprite. Identifies the exact byte offset of the
 * underlying token so the fork rewriter can edit just this one occurrence
 * without having to re-disambiguate by defName + path text.
 */
export interface AssetReference {
  defType: string;
  defName: string;
  /**
   * Display name for the slot — the def's `<label>` for XML refs, or the
   * variable name assigned the ContentFinder call for C# refs. Undefined
   * when neither is recoverable; callers fall back to defName, then stem.
   * Two refs with identical labels are allowed (e.g. two ContentFinder calls
   * in the same class assigning to different field-typed members named
   * the same — the slot is still distinguished by its on-disk path).
   */
  label?: string;
  /** Field path within the def, e.g. "graphicData.texPath". */
  field: string;
  /** Path relative to mod root, e.g. "Defs/ThingDefs_Items/Stalker.xml". */
  sourceFile: string;
  /** Byte offset of the XML tag / C# call that produced this ref, within the source file. */
  tokenOffset: number;
  /** Length of the source token (the full `<tag>value</tag>` or `ContentFinder<…>.Get("…")` span). */
  tokenLength: number;
  /**
   * The path string as written in the source token (the BASE for directional
   * expansions). Slots derived from a Graphic_Multi or wornGraphicPath share a
   * single token whose written value is the base — individual slot stems carry
   * the `_north/_south/_east` suffix the scanner appended. Fork rewrites edit
   * this base in the source file; all sibling directional slots follow.
   */
  sourceStem: string;
}

export interface AssetFileMeta {
  size: number;
  width?: number;
  height?: number;
  /** Sniffed format if it could be determined. */
  detectedFormat?: string;
}

export interface AssetFilePresence {
  /** Path relative to mod root. */
  path: string;
  absPath: string;
  meta: AssetFileMeta;
  issues: string[];
}

/**
 * Marks a slot whose path RimWorld will resolve against vanilla art at runtime.
 * Detected by scanning loose `Data/<pack>/Defs/**\/*.xml` for matching path
 * refs — RimWorld bundles the actual `.png`/`.ogg` into Unity asset archives,
 * so we can't preview the file, but we can prove the path is genuinely
 * served by Core/DLC and tell the stub system to leave it alone.
 */
export interface VanillaSource {
  /** Pack folder name that ships the def referencing this stem, e.g. "Core". */
  pack: string;
}

/**
 * One asset slot in the mod — exactly one ref site (def field or C# call). Two
 * defs pointing at the same `<texPath>` produce two slots, each with its own
 * id and its own `ref`. They share `path` (the on-disk destination); the
 * upload IPC auto-forks when that happens.
 */
export interface AssetRequirement {
  id: string;
  kind: AssetKind;
  /**
   * Path relative to mod root that the canonical file lives at, e.g.
   * "Textures/Things/Stalker.png". May be shared with sibling slots that
   * declare the same stem.
   */
  path: string;
  /** Path without extension. */
  stem: string;
  spec: AssetSpec;
  /** The single ref this slot represents. */
  ref: AssetReference;
  status: 'present' | 'missing' | 'invalid';
  /**
   * True when the file at `path` exists but is a modmixer-generated placeholder
   * (magenta-checker PNG / silent OGG). The status is still `missing` so the UI
   * shows it as empty.
   */
  stubbed?: boolean;
  current?: AssetFilePresence;
  /**
   * Vanilla-pack file the path resolves to when no custom file exists in the
   * mod. Set independently of `current`/`status` — both can be populated when
   * the user has uploaded a custom file that overrides a vanilla original.
   */
  vanilla?: VanillaSource;
}

export interface AssetCounts {
  missing: number;
  invalid: number;
  present: number;
}

export interface AssetScan {
  folder: string;
  requirements: AssetRequirement[];
  counts: AssetCounts;
  countsByKind: Record<AssetKind, AssetCounts>;
  /**
   * Drift-check messages — literals in .cs that aren't in the cs-assets
   * manifest, or manifest entries that don't appear as literals anywhere.
   * Not blocking; surfaced for the agent to read and reconcile.
   */
  warnings: string[];
}

/**
 * Identifies a specific slot to the addAsset IPC, which uses it to find the
 * exact ref site to rewrite when forking a shared path. The slot's `id` would
 * be enough on its own if the scanner state were stable, but the IPC re-scans
 * to find the slot, so we pass the identifying tuple explicitly.
 */
export interface AssetSlotRef {
  kind: AssetKind;
  path: string;
  sourceFile: string;
  tokenOffset: number;
}
