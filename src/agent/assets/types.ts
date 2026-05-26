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
 * Source of a vanilla-asset fallback — Core or a DLC pack. When set, the slot
 * has no custom file in the mod but RimWorld will resolve the path against
 * this base-game file at runtime. The UI previews the vanilla file; the stub
 * system skips writing a placeholder (which would otherwise shadow vanilla).
 */
export interface VanillaSource {
  /** Pack folder name, e.g. "Core" or "Royalty". */
  pack: string;
  /** Absolute path to the vanilla file. */
  absPath: string;
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
