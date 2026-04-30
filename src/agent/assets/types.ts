// Shared types for the assets feature. Importable from both main and renderer.

export type AssetKind = 'texture' | 'audio' | 'icon';

export interface TextureSpec {
  kind: 'texture' | 'icon';
  format: 'png';
  /** Whether the slot accepts an optional team-color mask sibling at <stem>_m.png. */
  acceptsMask: boolean;
  /** Human description of what this texture is used for. */
  description: string;
  /** Hint for typical sizing — purely informational. */
  sizeHint?: string;
}

export interface AudioSpec {
  kind: 'audio';
  format: 'ogg';
  description: string;
}

export type AssetSpec = TextureSpec | AudioSpec;

export interface AssetReference {
  defType: string;
  defName: string;
  /** Field path within the def, e.g. "graphicData.texPath". */
  field: string;
  /** Path relative to mod root, e.g. "Defs/ThingDefs_Items/Stalker.xml". */
  sourceFile: string;
  /** Optional human description pulled from an XML comment adjacent to the path tag. */
  note?: string;
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

export interface AssetRequirement {
  id: string;
  kind: AssetKind;
  /** Path relative to mod root that the canonical file should live at, e.g. "Textures/Things/Stalker.png". */
  path: string;
  /** Path without extension, used for mask sibling lookup. */
  stem: string;
  spec: AssetSpec;
  referencedBy: AssetReference[];
  /** Aggregated, deduped notes pulled from XML comments — first entry is the primary description if present. */
  notes: string[];
  status: 'present' | 'missing' | 'invalid';
  /**
   * True when the file at `path` exists but is a modmixer-generated placeholder
   * (magenta-checker PNG / silent OGG). The status is still `missing` so the UI
   * shows it as empty; this flag lets the UI add a "stubbed" hint.
   */
  stubbed?: boolean;
  current?: AssetFilePresence;
  /** Optional team-color mask sibling for textures with acceptsMask=true. */
  mask?: {
    path: string;
    /** mask is never "required" — present means a file exists; missing is OK. */
    status: 'present' | 'missing';
    current?: AssetFilePresence;
  };
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
