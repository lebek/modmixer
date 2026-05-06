// Renderer for the template-based Steam-Workshop preview pipeline.
//
// The agent picks a template ('classic', 'icon-left', 'banner') and supplies
// semantic slots (title, sprite, colors); real Chromium handles layout,
// font loading, and auto-fit text sizing.
//
// Window strategy: show:true at (0, 0) with opacity 0. Hidden windows
// (show:false + paintWhenInitiallyHidden) and far-offscreen positions
// (-10000, -10000) both cause Chromium to skip raster work — text or sprites
// end up missing in the captured PNG even when the DOM is ready. A visible
// window with zero opacity keeps the compositor running while staying out of
// the user's way.

import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import { normalizePreviewBuffer } from '../../assets/preview-normalize.js';

export type PreviewTemplate = 'classic' | 'icon-left' | 'banner';
export type TitleEffect = 'none' | 'shadow' | 'outline' | 'glow';
export type TitleFont = 'inter' | 'rimworld';

export interface PreviewParams {
  template: PreviewTemplate;
  title: string;
  subtitle?: string;
  /** Absolute or workspace-relative path. Read and inlined as a data URL. */
  spritePath?: string;
  /** CSS color or `linear-gradient(...)` / `radial-gradient(...)` string. */
  background?: string;
  titleColor?: string;
  subtitleColor?: string;
  titleFont?: TitleFont;
  titleEffect?: TitleEffect;
  /** Used by the `glow` effect; CSS color. */
  accentColor?: string;
}

export interface RenderOptions {
  /** Output PNG width. Default 1280. */
  width?: number;
  /** Output PNG height. Default 720. */
  height?: number;
  /** Workspace root for resolving relative spritePath. */
  workspaceDir?: string;
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

function templatesDir(): string {
  const devCandidate = path.join(app.getAppPath(), 'assets', 'preview-templates');
  if (fssync.existsSync(devCandidate)) return devCandidate;
  return path.join(process.resourcesPath, 'preview-templates');
}

async function spriteToDataUrl(
  spritePath: string,
  workspaceDir: string | undefined,
): Promise<string> {
  const abs = path.isAbsolute(spritePath)
    ? spritePath
    : workspaceDir
      ? path.resolve(workspaceDir, spritePath)
      : path.resolve(spritePath);
  const ext = path.extname(abs).toLowerCase();
  const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream';
  const buf = await fs.readFile(abs);
  return `data:${mime};base64,${buf.toString('base64')}`;
}

export async function renderPreview(
  params: PreviewParams,
  outPath: string,
  opts: RenderOptions = {},
): Promise<{ width: number; height: number; bytes: number }> {
  const W = opts.width ?? 1280;
  const H = opts.height ?? 720;

  const tplPath = path.join(templatesDir(), `${params.template}.html`);
  if (!fssync.existsSync(tplPath)) {
    throw new Error(`Unknown preview template: ${params.template}`);
  }

  // Inline the sprite as a data URL. The file:// path goes through
  // Chromium's network stack and capturePage occasionally captures the
  // image slot empty even after img.decode() resolves. Inlining bypasses
  // the fetch path entirely.
  const spriteUrl = params.spritePath
    ? await spriteToDataUrl(params.spritePath, opts.workspaceDir)
    : undefined;

  const slot = { ...params, spriteUrl };

  const win = new BrowserWindow({
    width: W,
    height: H,
    x: 0,
    y: 0,
    show: true,
    frame: false,
    focusable: false,
    skipTaskbar: true,
    useContentSize: true,
    backgroundColor: '#000000',
    opacity: 0,
    webPreferences: {
      offscreen: false,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  try {
    await win.loadFile(tplPath);
    win.webContents.setZoomFactor(1);

    await win.webContents.executeJavaScript(
      `window.applyPreview(${JSON.stringify(slot)}).then(() =>
         new Promise((r) => {
           if (window.__PREVIEW_READY) r();
           else window.addEventListener('preview-ready', () => r(), { once: true });
         })
       )`,
      true,
    );

    // capturePage occasionally races the compositor on Windows and returns
    // an empty (all-zero) framebuffer even though the DOM is ready. Retry
    // a few times with growing delay; if every channel of every pixel is
    // zero we know the capture missed.
    let png: Buffer | undefined;
    for (let attempt = 0; attempt < 6; attempt++) {
      await new Promise((r) => setTimeout(r, 150 + attempt * 100));
      const img = await win.webContents.capturePage({ x: 0, y: 0, width: W, height: H });
      const buf = img.toBitmap();
      let nonZero = false;
      for (let i = 0; i < buf.length; i += 4) {
        if (buf[i] || buf[i + 1] || buf[i + 2]) {
          nonZero = true;
          break;
        }
      }
      if (nonZero) {
        png = img.toPNG();
        break;
      }
    }
    if (!png) throw new Error('capturePage returned blank after retries');

    // Steam Workshop rejects preview images > 1 MiB; the renderer's PNG can
    // exceed that for busy gradients/photographic sprites. Run every output
    // through the shared normalizer so the file on disk is always uploadable.
    const normalized = await normalizePreviewBuffer(png);

    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, normalized.buffer);

    return {
      width: normalized.width,
      height: normalized.height,
      bytes: normalized.buffer.length,
    };
  } finally {
    win.destroy();
  }
}
