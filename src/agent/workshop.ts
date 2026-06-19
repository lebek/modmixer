import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { app, utilityProcess, type UtilityProcess } from 'electron';
import { getWorkspacePaths, readModAbout } from './workspace.js';
import { writeModPrefs } from './mod-prefs.js';
import { STEAM_PREVIEW_LIMIT_BYTES } from './assets/preview-normalize.js';
import { commitTurn } from './snapshots.js';
import { track } from './telemetry.js';

// RimWorld's Steam app ID. Workshop items live under this consumer/creator app.
const RIMWORLD_APP_ID = 294100;

// UgcItemVisibility from steamworks.js. We use numeric literals so the
// renderer/main can reference the same values without a runtime enum import
// (steamworks.js is externalized from the main bundle).
// 0 Public · 1 FriendsOnly · 2 Private · 3 Unlisted.
const VISIBILITY_PUBLIC = 0;
const VISIBILITY_VALUES = new Set([0, 1, 2, 3]);

// Tag every upload with "Mod" plus the supportedVersions from About.xml. RimWorld's
// in-game uploader uses the same convention so Workshop's version filter works.
const BASE_TAG = 'Mod';

// Filenames matched anywhere under the mod folder that we strip before
// uploading to Steam. .modmixer is the agent's sidecar (schematic etc.) and
// must never ship; the rest is build cruft / editor noise that has no
// business on the Workshop. Steamworks has no exclude API, so we stage a
// filtered copy instead of pointing it at the workspace folder.
const PUBLISH_EXCLUDES = new Set<string>([
  '.modmixer',
  '.git',
  '.DS_Store',
  '.vs',
  'bin',
  'obj',
  'node_modules',
]);

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

/** Fields of steamworks.js's `UgcUpdate` that a Workshop publish sets. */
interface WorkshopUpdateDetails {
  changeNote?: string;
  previewPath?: string;
  contentPath: string;
  title?: string;
  description?: string;
  tags?: string[];
  visibility?: number;
}

interface HostMessage {
  id?: number;
  ok?: boolean;
  result?: unknown;
  error?: string;
  progress?: { status: number; uploaded: number; total: number };
}

/**
 * RPC client for the Workshop publish host (src/agent/workshop-publish-host.ts).
 *
 * Steamworks marks RimWorld as "running" for as long as the process that
 * called `SteamAPI_Init` holds the connection, and steamworks.js has no
 * `SteamAPI_Shutdown`. If the main process initialized Steamworks, Steam
 * would treat RimWorld as running for the whole Modmixer session and refuse
 * to update the user's Workshop subscriptions. So we fork a `utilityProcess`,
 * do the publish there, and `dispose()` it — killing the process is what
 * tells Steam the game stopped, releasing the lock.
 *
 * One host is created per `publishToWorkshop` call and torn down in a
 * `finally`, so Steam only sees RimWorld "running" during the upload itself.
 */
class PublishHost {
  private readonly child: UtilityProcess;
  private readonly ready: Promise<void>;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private onProgress:
    | ((p: { status: number; uploaded: number; total: number }) => void)
    | undefined;
  private exited = false;

  constructor() {
    // workshop-publish-host is bundled as its own Forge Vite `main` entry, so
    // it sits next to this code's main.js bundle in .vite/build/.
    const script = path.join(__dirname, 'workshop-publish-host.js');
    this.child = utilityProcess.fork(script, [], {
      serviceName: 'modmixer-workshop-publish',
    });
    this.ready = new Promise<void>((resolve, reject) => {
      this.child.once('spawn', () => resolve());
      // If the process dies before it ever spawns, `spawn` never fires —
      // fail `ready` instead of leaving callers awaiting it forever.
      this.child.once('exit', () =>
        reject(new Error('Workshop publish host failed to start')),
      );
    });
    // A spawned host settles `ready` via `spawn`; the later `exit` rejection
    // is then a no-op, but still counts as unhandled unless we swallow it.
    this.ready.catch(() => {});
    this.child.on('message', (msg: HostMessage) => {
      if (msg.progress) {
        this.onProgress?.(msg.progress);
        return;
      }
      if (typeof msg.id !== 'number') return;
      const slot = this.pending.get(msg.id);
      if (!slot) return;
      this.pending.delete(msg.id);
      if (msg.ok) slot.resolve(msg.result);
      else slot.reject(new Error(msg.error ?? 'Workshop publish host error'));
    });
    this.child.on('exit', () => {
      this.exited = true;
      const err = new Error('Workshop publish host exited unexpectedly');
      for (const slot of this.pending.values()) slot.reject(err);
      this.pending.clear();
    });
  }

  private async call<T>(payload: Record<string, unknown>): Promise<T> {
    await this.ready;
    if (this.exited) throw new Error('Workshop publish host is not running');
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      this.child.postMessage({ id, ...payload });
    });
  }

  setProgressHandler(
    fn: (p: { status: number; uploaded: number; total: number }) => void,
  ): void {
    this.onProgress = fn;
  }

  /** Init Steamworks inside the host. Throws if Steam isn't reachable. */
  async init(): Promise<void> {
    // In packaged builds the Forge Vite plugin doesn't ship node_modules; the
    // host loads steamworks.js from the Contents/Resources/ copy placed there
    // via packagerConfig.extraResource. In dev, a bare specifier resolves to
    // the project's node_modules.
    const steamworksModule = app.isPackaged
      ? path.join(process.resourcesPath, 'steamworks.js')
      : 'steamworks.js';
    try {
      await this.call<void>({
        op: 'init',
        steamworksModule,
        appId: RIMWORLD_APP_ID,
        cwd: app.getPath('userData'),
      });
    } catch (err) {
      console.error('[workshop] steamworks init failed:', err);
      throw new Error(
        'Could not connect to Steam. Make sure Steam is running and you own RimWorld, then try again.',
        { cause: err },
      );
    }
  }

  createItem(): Promise<{ itemId: bigint; needsToAcceptAgreement: boolean }> {
    return this.call({ op: 'createItem', appId: RIMWORLD_APP_ID });
  }

  updateItem(itemId: bigint, updateDetails: WorkshopUpdateDetails): Promise<void> {
    return this.call({
      op: 'updateItem',
      appId: RIMWORLD_APP_ID,
      itemId,
      updateDetails,
    });
  }

  /**
   * Kill the host process. This is what releases Steam's "RimWorld is
   * running" lock — Steam detects the process is gone. Idempotent.
   */
  dispose(): void {
    if (!this.exited) this.child.kill();
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

/**
 * Copy the mod folder into a fresh temp directory, omitting anything in
 * PUBLISH_EXCLUDES at any depth. Returns the staged content path plus a
 * cleanup hook the caller MUST run in a finally block — otherwise a failed
 * upload leaves the staged copy behind in the OS temp dir.
 */
async function stageContentForPublish(srcFolder: string): Promise<{
  contentPath: string;
  cleanup: () => Promise<void>;
}> {
  const stageRoot = await fsp.mkdtemp(
    path.join(os.tmpdir(), 'modmixer-publish-'),
  );
  const dest = path.join(stageRoot, path.basename(srcFolder));
  await fsp.cp(srcFolder, dest, {
    recursive: true,
    filter: (source) => !PUBLISH_EXCLUDES.has(path.basename(source)),
  });
  return {
    contentPath: dest,
    cleanup: async () => {
      try {
        await fsp.rm(stageRoot, { recursive: true, force: true });
      } catch (err) {
        console.warn('[workshop] staged content cleanup failed:', err);
      }
    },
  };
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

// Where a published mod gets registered on the Modmixer leaderboard.
const LEADERBOARD_REGISTER_URL =
  'https://modmixer.com/api/workshop-mods/register';

/**
 * Best-effort: add a freshly-published mod to the Modmixer leaderboard. The
 * server validates the id against Steam, so posting just the id is enough.
 * Fire-and-forget — a leaderboard hiccup must never fail or delay a Workshop
 * publish, so every error is swallowed with a warning.
 */
async function registerOnLeaderboard(itemId: string): Promise<void> {
  try {
    const res = await fetch(LEADERBOARD_REGISTER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ published_file_id: itemId }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.warn(`[workshop] leaderboard register failed: HTTP ${res.status}`);
    }
  } catch (err) {
    console.warn('[workshop] leaderboard register failed:', err);
  }
}

export async function publishToWorkshop(
  folder: string,
  visibility: number = VISIBILITY_PUBLIC,
  changeNote?: string,
  trackOnLeaderboard: boolean = true,
): Promise<PublishResult> {
  // Guard a malformed value: visibility is only ever applied on the first
  // publish (see below), so a bad number would otherwise stick permanently.
  const itemVisibility = VISIBILITY_VALUES.has(visibility)
    ? visibility
    : VISIBILITY_PUBLIC;

  const emit = (e: Omit<PublishProgressEvent, 'folder'>) =>
    events.emit('progress', { folder, ...e });

  emit({ status: 'preparing' });

  const about = await readModAbout(folder);
  if (!about) throw new Error(`Mod not found: ${folder}`);
  if (!about.name.trim()) throw new Error('Set a name in About.xml before publishing.');
  if (!about.description.trim()) {
    throw new Error('Set a description in About.xml before publishing.');
  }

  // Remember the user's leaderboard choice for next time (persist-on-publish).
  // Written before the upload so the preference sticks even if Steam fails.
  await writeModPrefs(folder, { trackOnLeaderboard });

  const { workspaceDir } = getWorkspacePaths();
  const modFolder = path.join(workspaceDir, folder);
  const previewPath = previewPathFor(folder);

  // Preflight: Steam caps preview images at 1 MiB and rejects oversize uploads
  // with an opaque k_EResultLimitExceeded. Our generate/browse paths normalize
  // below the cap, but a hand-placed or imported Preview.png can still exceed
  // it — catch that here with a readable message instead of a Steam failure.
  if (previewPath) {
    const { size } = await fsp.stat(previewPath);
    if (size > STEAM_PREVIEW_LIMIT_BYTES) {
      const mb = (size / 1024 / 1024).toFixed(2);
      throw new Error(
        `Preview image is ${mb} MB — Steam's limit is 1 MB. Re-pick it with ` +
          'Browse… or use Generate; Modmixer will resize it to fit.',
      );
    }
  }

  const tags = [BASE_TAG, ...about.supportedVersions];
  // Use the modder's notes when they typed any; otherwise fall back to a
  // timestamp so the Workshop change history always has a non-empty entry.
  const note = changeNote?.trim() || autoChangeNote();

  const existing = await readPublishedFileId(folder);
  let needsToAcceptAgreement = false;
  let agreementUrl: string | undefined;
  let itemId: bigint;

  // Steamworks runs in a forked host process, not here — see PublishHost. The
  // host is killed in the `finally` below so Steam stops treating RimWorld as
  // "running" the moment the publish settles.
  const host = new PublishHost();
  host.setProgressHandler((p) =>
    emit({
      status: statusFromUpdateStatus(p.status),
      uploaded: p.uploaded,
      total: p.total,
      itemId: itemId.toString(),
    }),
  );

  try {
    await host.init();

    if (existing) {
      itemId = existing;
    } else {
      emit({ status: 'creating-item' });
      const created = await host.createItem();
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

    // Stage *after* writePublishedFileId so the staged copy includes the
    // freshly-minted About/PublishedFileId.txt for newly-created items.
    const staged = await stageContentForPublish(modFolder);

    // The first publish seeds the Workshop page's title, description, and tags
    // from About.xml. On later updates we send only content/preview/changeNote
    // and omit those fields — Steam preserves any UgcUpdate field we leave out,
    // so a modder's Steam-side edits (BBCode description, rename, tag tweaks)
    // survive a republish from Modmixer instead of being clobbered.
    const updateDetails: WorkshopUpdateDetails = {
      changeNote: note,
      previewPath,
      contentPath: staged.contentPath,
    };
    if (!existing) {
      updateDetails.title = about.name;
      updateDetails.description = about.description;
      updateDetails.tags = tags;
      updateDetails.visibility = itemVisibility;
    }

    try {
      await host.updateItem(itemId, updateDetails);
    } finally {
      await staged.cleanup();
    }

    const url = `https://steamcommunity.com/sharedfiles/filedetails/?id=${itemId.toString()}`;
    emit({
      status: 'done',
      itemId: itemId.toString(),
      url,
      agreementUrl,
    });

    // Stamp the publish time so the panel can show "last published". Best-effort:
    // the upload already succeeded, so a prefs-write hiccup must not fail it.
    try {
      await writeModPrefs(folder, { lastPublishedAt: Date.now() });
    } catch (err) {
      console.warn('[workshop] failed to record publish time:', err);
    }

    // Register on the Modmixer leaderboard if the user opted in. Fire-and-forget
    // (not awaited) so it never holds up the publish — the main process stays
    // alive long enough for the request to land.
    if (trackOnLeaderboard) {
      void registerOnLeaderboard(itemId.toString());
    }

    track({ name: 'mod_published' });

    // Mark the publish in History so the user can roll back to "the version
    // I shipped" without having to remember which auto-save it was. force:
    // true gives the publish its own row even when no files changed since
    // the last save (common: agent finishes work → auto-save → publish).
    try {
      await commitTurn(folder, {
        kind: 'manual',
        label: 'Steam Publish',
        force: true,
      });
    } catch (err) {
      console.warn('[workshop] post-publish snapshot failed:', err);
    }

    return {
      itemId: itemId.toString(),
      url,
      needsToAcceptAgreement,
      agreementUrl,
    };
  } finally {
    host.dispose();
  }
}
