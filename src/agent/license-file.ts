// Main-process helper: materialize a mod's chosen license as a LICENSE file in
// the mod folder. Shared by both games — the RimWorld publish stager ships the
// file to the Steam Workshop, and for Minecraft it lives in the project/source
// tree alongside the gradle mod_license that goes into the jar manifest.
import path from 'node:path';
import fsp from 'node:fs/promises';
import { renderLicenseText } from './license-text.js';

const LICENSE_FILENAME = 'LICENSE';
// The vendored NeoForge MDK ships its own MIT license file under this name. Once
// we write a real LICENSE we drop it so a mod never carries two license files
// that can disagree (part of fixing the Minecraft license divergence).
const MDK_TEMPLATE_LICENSE = 'TEMPLATE_LICENSE.txt';

/**
 * Write <modDir>/LICENSE to match `licenseId`, or leave the folder untouched
 * when we don't ship a file for that id (All-Rights-Reserved, a custom/unknown
 * SPDX id, or no license). Returns true when a file was written.
 *
 * `author`/`year` fill MIT's copyright line and are ignored by the verbatim
 * licenses. Best-effort and idempotent — safe to call on every save/publish.
 */
export async function syncLicenseFile(
  modDir: string,
  licenseId: string,
  opts: { author: string; year: number },
): Promise<boolean> {
  const text = renderLicenseText(licenseId, {
    author: opts.author,
    year: opts.year,
  });
  if (text == null) return false;
  await fsp.writeFile(path.join(modDir, LICENSE_FILENAME), text, 'utf8');
  // Drop the MDK's bundled template license so it can't disagree with ours.
  await fsp
    .rm(path.join(modDir, MDK_TEMPLATE_LICENSE), { force: true })
    .catch(() => undefined);
  return true;
}
