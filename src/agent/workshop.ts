import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { app } from 'electron';
import { getWorkspacePaths, readModAbout } from './workspace.js';
import { track } from './telemetry.js';

// steamworks.js's `init()` strips `init`, `runCallbacks`, and `restartAppIfNecessary`
// from the binding before returning. We keep the full namespace shape here and only
// reach into `.workshop`.
type SteamClient = typeof import('steamworks.js/client');

// RimWorld's Steam app ID. Workshop items live under this consumer/creator app.
const RIMWORLD_APP_ID = 294100;

// UgcItemVisibility from steamworks.js. We use the numeric literal so the
// renderer/main can reference the same value without a runtime enum import
// (steamworks.js is externalized from the main bundle).
const VISIBILITY_PUBLIC = 0;

// Tag every upload with "Mod" plus the supportedVersions from About.xml. RimWorld's
// in-game uploader uses the same convention so Workshop's version filter works.
const BASE_TAG = 'Mod';

export type PublishStatus =
  | 'preparing'
  | 'creating-item'
  | 'agreement-required'
  | 'uploading-content'
  | 'uploading-preview'
  | 'committing'
  | 'done'
  | 'error';

export interface PublishProgressEvent {
  folder: string;
  status: PublishStatus;
  /** Bytes uploaded for the current step (where applicable). */
  uploaded?: number;
  /** Total bytes for the current step (where applicable). */
  total?: number;
  /** Resolved Workshop item id, available once createItem returns. */
  itemId?: string;
  /** Steam community page for the item, set when status === 'done'. */
  url?: string;
  /** Set when status === 'agreement-required'. */
  agreementUrl?: string;
  /** Set when status === 'error'. */
  error?: string;
}

const events = new EventEmitter();

export function onPublishProgress(
  handler: (event: PublishProgressEvent) => void,
): () => void {
  events.on('progress', handler);
  return () => events.off('progress', handler);
}

let cachedClient: SteamClient | null = null;
let initError: Error | null = null;

/**
 * Lazy-init the Steamworks client. Throws a descriptive error if Steam isn't
 * running or the SDK fails to load — the caller surfaces that in the UI.
 */
function ensureSteamInit(): SteamClient {
  if (cachedClient) return cachedClient;
  if (initError) throw initError;
  try {
    // In packaged builds the Forge Vite plugin doesn't ship node_modules; we
    // route to the copy placed in Contents/Resources/ via packagerConfig.extraResource.
    const steamworksModule = app.isPackaged
      ? path.join(process.resourcesPath, 'steamworks.js')
      : 'steamworks.js';
    // require() lazily so app launch doesn't depend on Steam being installed.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const steamworks = require(steamworksModule) as {
      init: (appId?: number) => SteamClient;
    };
    cachedClient = steamworks.init(RIMWORLD_APP_ID);
    return cachedClient;
  } catch (err) {
    initError = new Error(
      'Could not connect to Steam. Make sure Steam is running and you own RimWorld, then try again.',
      { cause: err },
    );
    throw initError;
  }
}

function publishedFileIdPath(folder: string): string {
  const { workspaceDir } = getWorkspacePaths();
  return path.join(workspaceDir, folder, 'About', 'PublishedFileId.txt');
}

async function readPublishedFileId(folder: string): Promise<bigint | null> {
  const file = publishedFileIdPath(folder);
  if (!fs.existsSync(file)) return null;
  const raw = (await fsp.readFile(file, 'utf8')).trim();
  if (!raw) return null;
  try {
    return BigInt(raw);
  } catch {
    return null;
  }
}

async function writePublishedFileId(folder: string, id: bigint): Promise<void> {
  const file = publishedFileIdPath(folder);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, id.toString(), 'utf8');
}

/**
 * Remove About/PublishedFileId.txt, severing the link between this workspace
 * mod and a Steam Workshop item. The next publish will create a fresh
 * Workshop item rather than updating the old one. The Workshop item itself
 * is untouched — the user can still find and manage it on Steam.
 */
export async function unlinkWorkshopItem(folder: string): Promise<void> {
  const file = publishedFileIdPath(folder);
  try {
    await fsp.unlink(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/**
 * Manually associate this workspace mod with an existing Steam Workshop
 * item by writing About/PublishedFileId.txt. Use case: the user published
 * outside Modmixer (or imported a mod whose PublishedFileId.txt was lost)
 * and wants future publishes from Modmixer to update that same item.
 *
 * Steam doesn't validate ownership at this layer — that happens at publish
 * time, where Steam will reject updates from anyone who isn't the original
 * uploader.
 */
export async function linkWorkshopItem(
  folder: string,
  rawId: string,
): Promise<void> {
  const trimmed = rawId.trim();
  if (!trimmed) throw new Error('Workshop ID is required.');
  if (!/^\d+$/.test(trimmed)) {
    throw new Error('Workshop ID must be a positive integer.');
  }
  let id: bigint;
  try {
    id = BigInt(trimmed);
  } catch {
    throw new Error('Workshop ID must be a positive integer.');
  }
  if (id <= 0n) {
    throw new Error('Workshop ID must be a positive integer.');
  }
  await writePublishedFileId(folder, id);
}

function previewPathFor(folder: string): string | undefined {
  const { workspaceDir } = getWorkspacePaths();
  const candidate = path.join(workspaceDir, folder, 'About', 'Preview.png');
  return fs.existsSync(candidate) ? candidate : undefined;
}

function autoChangeNote(): string {
  // Format: "Updated YYYY-MM-DD HH:MM" — short, sortable, no timezone noise.
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `Updated ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

function statusFromUpdateStatus(code: number): PublishStatus {
  // Mirrors steamworks.js workshop.UpdateStatus enum.
  switch (code) {
    case 1: return 'preparing';            // PreparingConfig
    case 2: return 'preparing';            // PreparingContent
    case 3: return 'uploading-content';    // UploadingContent
    case 4: return 'uploading-preview';    // UploadingPreviewFile
    case 5: return 'committing';           // CommittingChanges
    default: return 'preparing';           // Invalid (0) — treated as preparing
  }
}

export interface PublishResult {
  itemId: string;
  url: string;
  needsToAcceptAgreement: boolean;
  agreementUrl?: string;
}

export async function publishToWorkshop(folder: string): Promise<PublishResult> {
  const emit = (e: Omit<PublishProgressEvent, 'folder'>) =>
    events.emit('progress', { folder, ...e });

  emit({ status: 'preparing' });

  const about = await readModAbout(folder);
  if (!about) throw new Error(`Mod not found: ${folder}`);
  if (!about.name.trim()) throw new Error('Set a name in About.xml before publishing.');
  if (!about.description.trim()) {
    throw new Error('Set a description in About.xml before publishing.');
  }

  const { workspaceDir } = getWorkspacePaths();
  const contentPath = path.join(workspaceDir, folder);
  const previewPath = previewPathFor(folder);

  const tags = [BASE_TAG, ...about.supportedVersions];
  const changeNote = autoChangeNote();

  const ws = ensureSteamInit().workshop;

  const existing = await readPublishedFileId(folder);
  let needsToAcceptAgreement = false;
  let agreementUrl: string | undefined;

  let itemId: bigint;
  if (existing) {
    itemId = existing;
  } else {
    emit({ status: 'creating-item' });
    const created = await ws.createItem(RIMWORLD_APP_ID);
    itemId = created.itemId;
    needsToAcceptAgreement = created.needsToAcceptAgreement;
    await writePublishedFileId(folder, itemId);
    if (needsToAcceptAgreement) {
      agreementUrl = `steam://url/CommunityFilePage/${itemId.toString()}`;
      emit({
        status: 'agreement-required',
        itemId: itemId.toString(),
        agreementUrl,
      });
    }
  }

  emit({ status: 'uploading-content', itemId: itemId.toString() });

  await new Promise<void>((resolve, reject) => {
    ws.updateItemWithCallback(
      itemId,
      {
        title: about.name,
        description: about.description,
        changeNote,
        previewPath,
        contentPath,
        tags,
        visibility: VISIBILITY_PUBLIC,
      },
      RIMWORLD_APP_ID,
      () => resolve(),
      (err: unknown) => reject(err instanceof Error ? err : new Error(String(err))),
      (progress: { status: number; progress: bigint; total: bigint }) => {
        emit({
          status: statusFromUpdateStatus(progress.status),
          uploaded: Number(progress.progress),
          total: Number(progress.total),
          itemId: itemId.toString(),
        });
      },
      250,
    );
  });

  const url = `https://steamcommunity.com/sharedfiles/filedetails/?id=${itemId.toString()}`;
  emit({
    status: 'done',
    itemId: itemId.toString(),
    url,
    agreementUrl,
  });

  track({ name: 'mod_published' });

  return {
    itemId: itemId.toString(),
    url,
    needsToAcceptAgreement,
    agreementUrl,
  };
}
