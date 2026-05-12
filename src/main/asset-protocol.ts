// Custom `modmixer-asset://` protocol — lets the renderer load mod-folder
// assets (currently only About/Preview.png for library row thumbnails) via
// <img src> instead of inlining base64 data URLs. Chromium then handles
// caching/decoding, which matters for the library list where the same
// preview can render in active+inactive columns and re-render frequently.
//
// URL form: modmixer-asset://preview/<source>/<encoded-folder>
// The renderer never sees absolute paths; we resolve `(source, folder)` via
// the live registry snapshot so any "where do mods live" logic stays in
// main.

import fs from 'node:fs';
import path from 'node:path';
import { net, protocol } from 'electron';
import { pathToFileURL } from 'node:url';
import { getRegistry } from '../agent/registry/index.js';
import type { ModSource } from '../agent/registry/index.js';

const SCHEME = 'modmixer-asset';

/**
 * Register the privileged scheme. Must be called before `app.whenReady()`
 * so `<img src="modmixer-asset://...">` is permitted from the renderer.
 */
export function registerAssetSchemeAsPrivileged(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: false,
        bypassCSP: false,
        stream: false,
      },
    },
  ]);
}

/**
 * Install the protocol handler. Must be called after `app.whenReady()`.
 */
export function installAssetProtocolHandler(): void {
  protocol.handle(SCHEME, async (request) => {
    const filePath = resolveRequest(request.url);
    if (!filePath) return new Response(null, { status: 404 });
    try {
      await fs.promises.access(filePath, fs.constants.R_OK);
    } catch {
      return new Response(null, { status: 404 });
    }
    const response = await net.fetch(pathToFileURL(filePath).toString());
    // Without explicit caching, Chromium re-fetches and re-decodes on every
    // <img> remount (which happens constantly with row virtualization).
    // Library preview files are immutable from our side, so an aggressive
    // long-lived cache is safe.
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  });
}

const VALID_SOURCES: ReadonlySet<ModSource> = new Set([
  'official',
  'local',
  'workshop',
  'workspace',
]);

function resolveRequest(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${SCHEME}:`) return null;
  // URL.hostname is the segment after `://`; for "preview" we expect
  //   modmixer-asset://preview/<source>/<folder>
  if (url.hostname !== 'preview') return null;

  // pathname is "/<source>/<folder>" — split and decode.
  const segments = url.pathname
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => decodeURIComponent(s));
  if (segments.length !== 2) return null;
  const [source, folder] = segments;
  if (!VALID_SOURCES.has(source as ModSource)) return null;

  const snapshot = getRegistry().getSnapshot();
  const mod = snapshot.mods.find(
    (m) => m.source === source && m.folder === folder,
  );
  if (!mod) return null;

  // Hardcoded to Preview.png. If we ever add more asset relpaths, guard
  // against traversal by checking the resolved path stays under mod.path.
  return path.join(mod.path, 'About', 'Preview.png');
}
