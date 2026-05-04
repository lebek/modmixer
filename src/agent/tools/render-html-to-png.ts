import { app } from 'electron';
import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import path from 'node:path';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import satori from 'satori';
import { html as htmlToVNode } from 'satori-html';
import { assertPathAllowed } from '../security/path-policy.js';
import { getPathPolicyRoots } from '../security/policy-roots.js';
import { getWorkspacePaths } from '../workspace.js';
import { rasterizeSvg } from './lib/resvg-init.js';

const Params = Type.Object({
  html: Type.String({
    description:
      "HTML markup with inline CSS. The root element should size itself to fill the canvas (e.g. `display:flex; width:100%; height:100%`). Satori requires every text node to live inside a `display:flex` (or block-with-display:flex children) container — bare text inside a div without `display:flex` errors out. Local image paths in `<img src=\"…\">` are auto-resolved against the workspace cwd; the agent does NOT need to base64 sprites manually.",
  }),
  outPath: Type.String({
    description:
      "Output PNG path. Relative paths resolve against the workspace cwd (e.g. 'MyMod/About/Preview.png'). Parent directories are created automatically. Must be inside the workspace.",
  }),
  width: Type.Number({
    description:
      'PNG width in pixels. The satori canvas is exactly this size, so root pixel dimensions and `width:100%` both fill the canvas correctly.',
  }),
  height: Type.Number({
    description: 'PNG height in pixels.',
  }),
});

export interface RenderHtmlToPngDetails {
  outPath: string;
  bytes: number;
  width: number;
  height: number;
}

interface VNode {
  type: string;
  props: {
    style?: Record<string, unknown>;
    children?: string | VNode | (string | VNode)[];
    [prop: string]: unknown;
  };
}

const FONT_FILES = [
  { file: 'Inter-Regular.ttf', name: 'Inter', weight: 400 as const, style: 'normal' as const },
  { file: 'Inter-Bold.ttf', name: 'Inter', weight: 700 as const, style: 'normal' as const },
  // Upstream TTF is misspelled as "RimWordFont" — preserve the filename, expose
  // the family as "RimWorld" since that's what the agent will reach for.
  { file: 'RimWordFont.ttf', name: 'RimWorld', weight: 400 as const, style: 'normal' as const },
];

interface LoadedFont {
  name: string;
  data: ArrayBuffer;
  weight: 400 | 700;
  style: 'normal';
}

// Mirrors the dev/prod resolution comment in src/agent/index/paths.ts:
// `app.isPackaged` is unreliable when running through `electron-forge start`,
// so try the dev path first (project-root/assets/fonts) and fall back to the
// extraResource flatten location (resources/fonts/) for packaged builds.
function fontsDir(): string {
  const devCandidate = path.join(app.getAppPath(), 'assets', 'fonts');
  if (fssync.existsSync(devCandidate)) return devCandidate;
  return path.join(process.resourcesPath, 'fonts');
}

let fontsCache: Promise<LoadedFont[]> | null = null;
function loadFonts(): Promise<LoadedFont[]> {
  if (!fontsCache) {
    fontsCache = (async () => {
      const dir = fontsDir();
      const out: LoadedFont[] = [];
      for (const entry of FONT_FILES) {
        const buf = await fs.readFile(path.join(dir, entry.file));
        // Satori accepts Buffer | ArrayBuffer; detach an ArrayBuffer copy so
        // the cached data isn't tied to a specific Buffer pool slice.
        const ab = buf.buffer.slice(
          buf.byteOffset,
          buf.byteOffset + buf.byteLength,
        );
        out.push({ name: entry.name, data: ab, weight: entry.weight, style: entry.style });
      }
      return out;
    })();
  }
  return fontsCache;
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

async function srcToDataUri(src: string, workspaceDir: string): Promise<string> {
  if (
    src.startsWith('data:') ||
    src.startsWith('http://') ||
    src.startsWith('https://')
  ) {
    return src;
  }
  const abs = path.isAbsolute(src) ? src : path.resolve(workspaceDir, src);
  assertPathAllowed(abs, getPathPolicyRoots(), 'img src');
  const ext = path.extname(abs).toLowerCase();
  const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream';
  const buf = await fs.readFile(abs);
  return `data:${mime};base64,${buf.toString('base64')}`;
}

// Satori-html returns a React-like VNode tree. Walk it, find every <img>,
// and rewrite local path src= to a data URI so satori's loadAdditionalAsset
// hook isn't needed. We mutate in place because the tree isn't shared.
async function resolveImageSources(
  node: VNode | string | (VNode | string)[] | undefined,
  workspaceDir: string,
): Promise<void> {
  if (!node || typeof node === 'string') return;
  if (Array.isArray(node)) {
    await Promise.all(node.map((n) => resolveImageSources(n, workspaceDir)));
    return;
  }
  if (node.type === 'img' && typeof node.props.src === 'string') {
    node.props.src = await srcToDataUri(node.props.src, workspaceDir);
  }
  if (node.props.children !== undefined) {
    await resolveImageSources(
      node.props.children as VNode | string | (VNode | string)[],
      workspaceDir,
    );
  }
}

export const renderHtmlToPngTool: AgentTool<typeof Params, RenderHtmlToPngDetails> = {
  name: 'render_html_to_png',
  label: 'Render HTML → PNG',
  description:
    "Rasterize an HTML+CSS layout to a PNG file via Satori. Use this for the Steam Workshop preview image (About/Preview.png), banners, About-page art, or any composed image where typography and layout matter — it's much easier to hand-write than equivalent SVG. Bundled fonts: Inter (400, 700) and RimWorld (a RimWorld-style display font, 400). Local <img src> paths auto-resolve against the workspace. Satori supports a flexbox CSS subset: flex layout, linear/radial gradients, text-shadow, border-radius, transform, opacity, mix-blend-mode (partial). NOT supported: CSS grid, position:absolute auto-sizing quirks, filter:, pseudo-elements, @media. Every text node must be inside a flex container. SIZING: this output is viewed at thumbnail scale (typically downscaled to 200–300px wide), so type must be 3–5× larger than feels natural — on a 1280×720 canvas, titles are 110–180px, subtitles 36–56px, never below 32px. Hero sprites should be 350–550px tall. Squint test: if it's not legible at 1/4 size, the type is too small. TEXT-SHADOW: keep blur radius small — roughly ≤10% of font-size, and never above ~24px. Large blurs (e.g. `0 0 100px`) make resvg's filter region miscompute and the text vanishes from the output. For a soft halo behind big type, put a radial-gradient on a sibling div instead.",
  parameters: Params,
  async execute(_id, params): Promise<AgentToolResult<RenderHtmlToPngDetails>> {
    const { workspaceDir } = getWorkspacePaths();
    const absOutPath = path.isAbsolute(params.outPath)
      ? params.outPath
      : path.resolve(workspaceDir, params.outPath);
    assertPathAllowed(absOutPath, getPathPolicyRoots(), 'outPath');

    const fonts = await loadFonts();
    const tree = htmlToVNode(params.html) as VNode;
    await resolveImageSources(tree, workspaceDir);

    // Satori canvas matches the requested PNG size 1:1 — earlier the canvas
    // was rendered at 2× and downsampled for crisper text, but that meant
    // any agent-emitted root with literal `width: 1280px` only filled the
    // top-left quarter of a 2560×1440 canvas. Glyphs are vector paths so
    // 1× rasterization still looks fine at thumbnail scale.
    const svg = await satori(tree as never, {
      width: params.width,
      height: params.height,
      fonts: fonts.map((f) => ({
        name: f.name,
        data: f.data,
        weight: f.weight,
        style: f.style,
      })),
    });

    const { png, width, height } = await rasterizeSvg(svg, {
      fitTo: { mode: 'width', value: params.width },
    });

    await fs.mkdir(path.dirname(absOutPath), { recursive: true });
    await fs.writeFile(absOutPath, png);

    return {
      content: [
        {
          type: 'text',
          text: `Wrote ${png.length} bytes to ${absOutPath} (${width}×${height} PNG).`,
        },
      ],
      details: {
        outPath: absOutPath,
        bytes: png.length,
        width,
        height,
      },
    };
  },
};
