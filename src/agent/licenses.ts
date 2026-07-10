// Shared, renderer-safe license metadata. Both games treat a mod's license as a
// mod-level property: the RimWorld panel and the Minecraft/Modrinth dialog both
// render the same picker from LICENSE_OPTIONS, and the value (an SPDX id) drives
// the LICENSE file written into the mod folder, Modrinth's license_id, the jar's
// gradle mod_license, and the Steam description footer.
//
// This module holds ONLY lightweight strings so it's cheap to import in the
// renderer. The (large) LICENSE file bodies live in ./license-text.ts, which is
// main-process-only.

export interface LicenseOption {
  /**
   * SPDX id — the stored value, Modrinth's license_id, and gradle's mod_license.
   * '' is never an option id (empty means "no license", handled by the picker's
   * custom/"Other" field).
   */
  id: string;
  /** Label shown in the dropdown. */
  name: string;
  /** One-line plain-language explanation shown under the picker. */
  blurb: string;
  /** Whether ModMixer ships a real LICENSE file for this id (see license-text.ts). */
  writesFile: boolean;
}

/** Default for a new mod: permissive, but still disclaims liability. */
export const DEFAULT_LICENSE_ID = 'MIT';

/** Modrinth's id for a closed, all-rights-reserved project. */
export const ALL_RIGHTS_RESERVED_ID = 'All-Rights-Reserved';

/**
 * The curated list, ordered most-to-least permissive with the closed option
 * last. Kept deliberately short — the picker's "Other…" field covers any other
 * SPDX id (e.g. GPL-3.0-only) for the rare user who wants one.
 */
export const LICENSE_OPTIONS: LicenseOption[] = [
  {
    id: 'MIT',
    name: 'MIT',
    blurb:
      'Permissive — anyone may reuse your code, they just keep the copyright line. The modding standard.',
    writesFile: true,
  },
  {
    id: 'CC0-1.0',
    name: 'CC0 1.0 (Public Domain)',
    blurb:
      'No rights reserved — anyone may use it for anything, no attribution needed. The most permissive.',
    writesFile: true,
  },
  {
    id: 'Apache-2.0',
    name: 'Apache 2.0',
    blurb: 'Permissive like MIT, plus an explicit patent grant.',
    writesFile: true,
  },
  {
    id: ALL_RIGHTS_RESERVED_ID,
    name: 'All Rights Reserved',
    blurb: "Closed — others can't legally reuse your work. Not an open license.",
    writesFile: false,
  },
];

/** Sentinel the picker uses for its free-text "Other…" option. Never stored. */
export const CUSTOM_LICENSE_ID = '__custom__';

const KNOWN_IDS = new Set(LICENSE_OPTIONS.map((o) => o.id));

/** Whether an id is one of the curated dropdown options (vs a custom SPDX id). */
export function isKnownLicense(id: string): boolean {
  return KNOWN_IDS.has(id);
}

export function findLicense(id: string): LicenseOption | undefined {
  return LICENSE_OPTIONS.find((o) => o.id === id);
}

/**
 * A one-line license footer for the Steam Workshop description (Steam has no
 * license field of its own). Empty when there's no license to state.
 */
export function licenseFooter(id: string | undefined | null): string {
  if (!id) return '';
  if (id === ALL_RIGHTS_RESERVED_ID) return 'License: All Rights Reserved';
  const name = findLicense(id)?.name ?? id;
  return `License: ${name} — https://spdx.org/licenses/${id}.html`;
}
