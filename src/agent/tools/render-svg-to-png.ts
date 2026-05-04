import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import path from 'node:path';
import fs from 'node:fs/promises';
import { assertPathAllowed } from '../security/path-policy.js';
import { getPathPolicyRoots } from '../security/policy-roots.js';
import { getWorkspacePaths } from '../workspace.js';

const Params = Type.Object({
  svg: Type.String({
    description:
      'SVG markup as a string (the actual <svg>…</svg> XML, not a path). Declare width/height (or a viewBox) so the renderer knows the natural dimensions.',
  }),
  outPath: Type.String({
    description:
      "Output PNG path. Relative paths resolve against the workspace cwd (e.g. 'MyMod/Textures/UI/Icon.png'). Parent directories are created automatically. Must be inside the workspace.",
  }),
  width: Type.Optional(
    Type.Number({
      description:
        "Output width in pixels. The SVG is scaled to fit this width preserving aspect ratio. Omit to use the SVG's declared dimensions.",
    }),
  ),
});

export interface RenderSvgToPngDetails {
  outPath: string;
  bytes: number;
  width: number;
  height: number;
}

interface ResvgRendered {
  asPng(): Uint8Array;
  readonly width: number;
  readonly height: number;
}
interface ResvgModule {
  initWasm(input: BufferSource | Promise<BufferSource>): Promise<void>;
  Resvg: new (
    svg: string | Uint8Array,
    opts?: {
      fitTo?:
        | { mode: 'original' }
        | { mode: 'width'; value: number }
        | { mode: 'height'; value: number }
        | { mode: 'zoom'; value: number };
    },
  ) => { render(): ResvgRendered };
}

// Mirrors the dual-resolve pattern in src/agent/index/csharp-indexer.ts: bare
// require for dev (where node_modules sits next to the source), resourcesPath
// fallback for packaged builds where Forge ships node_modules/@resvg/resvg-wasm
// via extraResource. Cached because Resvg's initWasm() can only run once per
// process.
let cached: { mod: ResvgModule; wasmPath: string } | null = null;
function loadResvg(): { mod: ResvgModule; wasmPath: string } {
  if (cached) return cached;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@resvg/resvg-wasm') as ResvgModule;
    const modDir = path.dirname(require.resolve('@resvg/resvg-wasm'));
    cached = { mod, wasmPath: path.join(modDir, 'index_bg.wasm') };
    return cached;
  } catch (devErr) {
    try {
      // electron-packager flattens extraResource paths to basename, so
      // 'node_modules/@resvg/resvg-wasm' lands at resources/resvg-wasm/
      // (matching the same behavior as @vscode/ripgrep → resources/ripgrep).
      const resolved = path.join(process.resourcesPath, 'resvg-wasm');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require(resolved) as ResvgModule;
      cached = { mod, wasmPath: path.join(resolved, 'index_bg.wasm') };
      return cached;
    } catch (prodErr) {
      throw prodErr instanceof Error ? prodErr : devErr;
    }
  }
}

let initPromise: Promise<void> | null = null;
function ensureInitialized(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      const { mod, wasmPath } = loadResvg();
      const bytes = await fs.readFile(wasmPath);
      await mod.initWasm(bytes);
    })();
  }
  return initPromise;
}

export const renderSvgToPngTool: AgentTool<typeof Params, RenderSvgToPngDetails> = {
  name: 'render_svg_to_png',
  label: 'Render SVG → PNG',
  description:
    "Rasterize an SVG to a PNG file on disk. Use this for any mod texture you generate (gizmo icons, ThingDef textures, UI buttons) — Modmixer ships only this renderer; imagemagick, inkscape, python/PIL, sharp, and canvas are NOT available, so do not shell out to them. Pass the SVG markup directly as a string. The output path resolves against the mod workspace and is path-policy-guarded.",
  parameters: Params,
  async execute(_id, params): Promise<AgentToolResult<RenderSvgToPngDetails>> {
    const { workspaceDir } = getWorkspacePaths();
    const absOutPath = path.isAbsolute(params.outPath)
      ? params.outPath
      : path.resolve(workspaceDir, params.outPath);
    assertPathAllowed(absOutPath, getPathPolicyRoots(), 'outPath');

    await ensureInitialized();
    const { mod } = loadResvg();

    const opts =
      typeof params.width === 'number'
        ? { fitTo: { mode: 'width' as const, value: params.width } }
        : undefined;
    const resvg = new mod.Resvg(params.svg, opts);
    const rendered = resvg.render();
    const png = rendered.asPng();

    await fs.mkdir(path.dirname(absOutPath), { recursive: true });
    await fs.writeFile(absOutPath, png);

    return {
      content: [
        {
          type: 'text',
          text: `Wrote ${png.length} bytes to ${absOutPath} (${rendered.width}×${rendered.height} PNG).`,
        },
      ],
      details: {
        outPath: absOutPath,
        bytes: png.length,
        width: rendered.width,
        height: rendered.height,
      },
    };
  },
};
