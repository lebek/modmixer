// Publish vendor/modmixer-live to the Steam Workshop as the official
// "Modmixer Live" item. Dev-side, manual, run with Steam running on an
// account that owns RimWorld:
//
//   npm run publish:live-mod -- --notes "v0.2.0: ..."
//   npm run publish:live-mod -- --set-visibility public
//
// First run mints the Workshop item (PRIVATE visibility) and writes
// vendor/modmixer-live/About/PublishedFileId.txt — commit that file and copy
// the id into LIVE_WORKSHOP_ID in src/agent/live/install.ts. Later runs
// upload content/preview/change-note only, so title/description/tag edits
// made on the Steam page survive (same policy as src/agent/workshop.ts).
//
// This is a plain Node script rather than the app's publish host: the
// "Steam shows RimWorld as running while the process that called
// SteamAPI_Init is alive" lock (see src/agent/workshop-publish-host.ts) is
// released when this script exits.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const RIMWORLD_APP_ID = 294100;
const MOD_DIR = path.join(repoRoot, 'vendor', 'modmixer-live');
const ABOUT_XML = path.join(MOD_DIR, 'About', 'About.xml');
const PREVIEW_PNG = path.join(MOD_DIR, 'About', 'Preview.png');
const ASSEMBLY = path.join(MOD_DIR, 'Assemblies', 'ModMixerLive.dll');
const FILE_ID_TXT = path.join(MOD_DIR, 'About', 'PublishedFileId.txt');
const INSTALL_TS = path.join(repoRoot, 'src', 'agent', 'live', 'install.ts');
// Steam rejects oversize previews with an opaque LimitExceeded — same cap as
// STEAM_PREVIEW_LIMIT_BYTES in src/agent/assets/preview-normalize.ts.
const PREVIEW_LIMIT_BYTES = 1024 * 1024;

const VISIBILITY = { public: 0, friends: 1, private: 2, unlisted: 3 };

function parseArgs(argv) {
  const args = { notes: null, setVisibility: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--notes') args.notes = argv[++i];
    else if (a === '--set-visibility') args.setVisibility = argv[++i];
    else fail(`Unknown argument: ${a}`);
  }
  if (args.setVisibility != null && !(args.setVisibility in VISIBILITY)) {
    fail(`--set-visibility must be one of: ${Object.keys(VISIBILITY).join(', ')}`);
  }
  return args;
}

function fail(msg) {
  console.error(`[publish-live-mod] ${msg}`);
  process.exit(1);
}

function extractScalar(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return (m?.[1] ?? '').trim();
}

function extractList(xml, parentTag) {
  const wrap = extractScalar(xml, parentTag);
  return [...wrap.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => m[1].trim());
}

async function preflight() {
  if (!fs.existsSync(ASSEMBLY)) {
    fail(
      'Assemblies/ModMixerLive.dll is missing — build it first:\n' +
        '  dotnet build vendor/modmixer-live/Source/ModMixerLive.csproj',
    );
  }
  // Stale-build tripwire: the DLL should be newer than every .cs file.
  const dllMtime = (await fsp.stat(ASSEMBLY)).mtimeMs;
  const sourceDir = path.join(MOD_DIR, 'Source');
  for (const f of await fsp.readdir(sourceDir)) {
    if (!f.endsWith('.cs')) continue;
    if ((await fsp.stat(path.join(sourceDir, f))).mtimeMs > dllMtime) {
      fail(`Source/${f} is newer than the built DLL — rebuild before publishing.`);
    }
  }

  const aboutXml = await fsp.readFile(ABOUT_XML, 'utf8');
  const modVersion = extractScalar(aboutXml, 'modVersion');
  if (!modVersion) fail('About.xml has no <modVersion> — add one before publishing.');
  const name = extractScalar(aboutXml, 'name');
  const description = extractScalar(aboutXml, 'description');
  const tags = ['Mod', ...extractList(aboutXml, 'supportedVersions')];

  if (!fs.existsSync(PREVIEW_PNG)) {
    console.warn(
      '[publish-live-mod] WARNING: About/Preview.png is missing — the Workshop page will have no image.',
    );
  } else if ((await fsp.stat(PREVIEW_PNG)).size > PREVIEW_LIMIT_BYTES) {
    fail("About/Preview.png exceeds Steam's 1 MiB preview limit — shrink it first.");
  }

  const existingId = fs.existsSync(FILE_ID_TXT)
    ? (await fsp.readFile(FILE_ID_TXT, 'utf8')).trim()
    : null;

  // Keep the app's hardcoded id honest. '0' is the pre-first-publish
  // placeholder in install.ts; any real id must match PublishedFileId.txt.
  const installTs = await fsp.readFile(INSTALL_TS, 'utf8');
  const idLiteral = installTs.match(/LIVE_WORKSHOP_ID = '(\d+)'/)?.[1];
  if (!idLiteral) {
    fail('Could not find LIVE_WORKSHOP_ID in src/agent/live/install.ts');
  }
  if (existingId && idLiteral !== existingId) {
    if (idLiteral === '0') {
      console.warn(
        `[publish-live-mod] REMINDER: set LIVE_WORKSHOP_ID = '${existingId}' in src/agent/live/install.ts`,
      );
    } else {
      fail(
        `LIVE_WORKSHOP_ID in install.ts (${idLiteral}) does not match About/PublishedFileId.txt (${existingId}).`,
      );
    }
  }

  return { modVersion, name, description, tags, existingId };
}

/** Copy the loadable mod folders + LICENSE into a temp dir; never Source/. */
async function stageContent() {
  const stageRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'modmixer-live-publish-'));
  const dest = path.join(stageRoot, 'ModmixerLive');
  for (const sub of ['About', 'Assemblies', 'Defs', 'Textures', 'Languages', 'Patches']) {
    const src = path.join(MOD_DIR, sub);
    if (!fs.existsSync(src)) continue;
    await fsp.cp(src, path.join(dest, sub), { recursive: true });
  }
  const license = path.join(MOD_DIR, 'LICENSE');
  if (fs.existsSync(license)) {
    await fsp.cp(license, path.join(dest, 'LICENSE'));
  }
  return { dest, cleanup: () => fsp.rm(stageRoot, { recursive: true, force: true }) };
}

function initSteam() {
  // Steamworks looks for steam_appid.txt in the process cwd when not
  // launched by Steam itself.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'modmixer-live-steam-'));
  fs.writeFileSync(path.join(cwd, 'steam_appid.txt'), String(RIMWORLD_APP_ID), 'utf8');
  process.chdir(cwd);
  const steamworks = require('steamworks.js');
  try {
    return steamworks.init(RIMWORLD_APP_ID).workshop;
  } catch (err) {
    fail(
      `Steamworks init failed (is Steam running, and does this account own RimWorld?): ${err}`,
    );
  }
}

function updateItem(ws, itemId, updateDetails) {
  return new Promise((resolve, reject) => {
    let lastStatus = -1;
    ws.updateItemWithCallback(
      itemId,
      updateDetails,
      RIMWORLD_APP_ID,
      () => resolve(),
      (err) => reject(err instanceof Error ? err : new Error(String(err))),
      (p) => {
        if (p.status !== lastStatus) {
          lastStatus = p.status;
          // Mirrors steamworks.js workshop.UpdateStatus.
          const label =
            { 1: 'preparing config', 2: 'preparing content', 3: 'uploading content', 4: 'uploading preview', 5: 'committing' }[p.status] ?? `status ${p.status}`;
          console.log(`[publish-live-mod] ${label}…`);
        }
      },
      500,
    );
  });
}

async function main() {
  const args = parseArgs(process.argv);
  const meta = await preflight();
  console.log(`[publish-live-mod] publishing Modmixer Live v${meta.modVersion}`);

  const staged = await stageContent();
  const ws = initSteam();

  try {
    let itemId;
    const firstPublish = !meta.existingId;
    if (firstPublish) {
      console.log('[publish-live-mod] no PublishedFileId.txt — creating Workshop item…');
      const created = await ws.createItem(RIMWORLD_APP_ID);
      itemId = created.itemId;
      await fsp.writeFile(FILE_ID_TXT, itemId.toString(), 'utf8');
      // Restage so the uploaded content includes PublishedFileId.txt.
      await staged.cleanup();
      const restaged = await stageContent();
      staged.dest = restaged.dest;
      staged.cleanup = restaged.cleanup;
      if (created.needsToAcceptAgreement) {
        console.log(
          '[publish-live-mod] NOTE: Steam requires accepting the Workshop legal agreement before the item is visible — a prompt will appear on the item page.',
        );
      }
    } else {
      itemId = BigInt(meta.existingId);
    }

    const updateDetails = {
      contentPath: staged.dest,
      changeNote: args.notes ?? `v${meta.modVersion}`,
    };
    if (fs.existsSync(PREVIEW_PNG)) updateDetails.previewPath = PREVIEW_PNG;
    if (firstPublish) {
      // Seed the page from About.xml, start PRIVATE: the item goes public
      // via --set-visibility once the matching app release ships. Later
      // runs omit these fields so Steam-side page edits survive.
      updateDetails.title = meta.name;
      updateDetails.description = meta.description;
      updateDetails.tags = meta.tags;
      updateDetails.visibility = VISIBILITY.private;
    } else if (args.setVisibility != null) {
      updateDetails.visibility = VISIBILITY[args.setVisibility];
    }

    await updateItem(ws, itemId, updateDetails);

    console.log(`[publish-live-mod] done: https://steamcommunity.com/sharedfiles/filedetails/?id=${itemId}`);
    if (firstPublish) {
      console.log(
        `[publish-live-mod] NEXT STEPS:\n` +
          `  1. commit vendor/modmixer-live/About/PublishedFileId.txt\n` +
          `  2. set LIVE_WORKSHOP_ID = '${itemId}' in src/agent/live/install.ts\n` +
          `  3. flip visibility at release: npm run publish:live-mod -- --set-visibility public`,
      );
    }
  } finally {
    await staged.cleanup();
  }
  // Steamworks keeps the event loop alive; exiting is also what releases
  // Steam's "RimWorld is running" lock.
  process.exit(0);
}

main().catch((err) => {
  console.error('[publish-live-mod] failed:', err);
  process.exit(1);
});
