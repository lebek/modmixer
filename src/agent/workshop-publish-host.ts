/**
 * Workshop publish host — runs in a short-lived Electron `utilityProcess`.
 *
 * Calling `SteamAPI_Init` registers the calling *process* with Steam as a
 * running instance of the app id you pass. We publish RimWorld Workshop
 * items, so that app id is RimWorld's (294100) — and while any process holds
 * that connection, Steam shows RimWorld as "running" and refuses to update
 * the user's Workshop subscriptions. steamworks.js exposes no
 * `SteamAPI_Shutdown`, so a connection opened in the main process would
 * linger for the entire Modmixer session.
 *
 * The fix: never init Steamworks in the main process. The main process forks
 * this helper for one publish and kills it the instant the publish settles.
 * When the helper exits, Steam sees the process gone and releases the lock,
 * so RimWorld is only "running" for the few seconds of an actual upload.
 *
 * Protocol (over `process.parentPort`, structured-clone messages — bigint OK):
 *   parent -> { id, op: 'init',       steamworksModule, appId, cwd }
 *   parent -> { id, op: 'createItem', appId }
 *   parent -> { id, op: 'updateItem', appId, itemId, updateDetails }
 *   child  -> { id, ok: true, result? }            (op completed)
 *   child  -> { id, ok: false, error }             (op failed)
 *   child  -> { progress: { status, uploaded, total } }   (updateItem only)
 */
import fs from 'node:fs';
import path from 'node:path';

const parent = process.parentPort;
if (!parent) {
  throw new Error('workshop-publish-host must run as a utilityProcess child');
}

/** Subset of steamworks.js's `workshop` namespace that we drive. */
interface WorkshopApi {
  createItem(appId: number): Promise<{
    itemId: bigint;
    needsToAcceptAgreement: boolean;
  }>;
  updateItemWithCallback(
    itemId: bigint,
    updateDetails: unknown,
    appId: number,
    onSuccess: () => void,
    onError: (err: unknown) => void,
    onProgress: (p: { status: number; progress: bigint; total: bigint }) => void,
    intervalMs: number,
  ): void;
}

let ws: WorkshopApi | null = null;

function initSteam(steamworksModule: string, appId: number, cwd: string): void {
  // Steamworks looks for steam_appid.txt in the process cwd when the host
  // wasn't launched by Steam itself. Drop the file in the dir the main
  // process picked (its userData) and chdir there before init.
  const appIdFile = path.join(cwd, 'steam_appid.txt');
  if (!fs.existsSync(appIdFile)) {
    fs.writeFileSync(appIdFile, String(appId), 'utf8');
  }
  process.chdir(cwd);
  // require() at runtime: steamworksModule is an absolute path in packaged
  // builds (process.resourcesPath/steamworks.js) and a bare specifier in dev.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const steamworks = require(steamworksModule) as {
    init: (appId?: number) => { workshop: WorkshopApi };
  };
  ws = steamworks.init(appId).workshop;
}

interface JobMessage {
  id: number;
  op: 'init' | 'createItem' | 'updateItem';
  steamworksModule?: string;
  appId?: number;
  cwd?: string;
  itemId?: bigint;
  updateDetails?: unknown;
}

async function handle(msg: JobMessage): Promise<void> {
  const { id, op } = msg;
  try {
    if (op === 'init') {
      initSteam(msg.steamworksModule!, msg.appId!, msg.cwd!);
      parent!.postMessage({ id, ok: true });
      return;
    }
    if (!ws) throw new Error('Steamworks not initialized');
    if (op === 'createItem') {
      const created = await ws.createItem(msg.appId!);
      parent!.postMessage({
        id,
        ok: true,
        result: {
          itemId: created.itemId,
          needsToAcceptAgreement: created.needsToAcceptAgreement,
        },
      });
      return;
    }
    if (op === 'updateItem') {
      await new Promise<void>((resolve, reject) => {
        ws!.updateItemWithCallback(
          msg.itemId!,
          msg.updateDetails,
          msg.appId!,
          () => resolve(),
          (err: unknown) =>
            reject(err instanceof Error ? err : new Error(String(err))),
          (p) => {
            parent!.postMessage({
              progress: {
                status: p.status,
                uploaded: Number(p.progress),
                total: Number(p.total),
              },
            });
          },
          250,
        );
      });
      parent!.postMessage({ id, ok: true });
      return;
    }
    parent!.postMessage({ id, ok: false, error: `Unknown op: ${String(op)}` });
  } catch (err) {
    parent!.postMessage({
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

parent.on('message', (e) => {
  void handle(e.data as JobMessage);
});
