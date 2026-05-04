import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import path from 'node:path';
import fs from 'node:fs/promises';
import { assertPathAllowed } from '../security/path-policy.js';
import { getPathPolicyRoots } from '../security/policy-roots.js';
import { getWorkspacePaths } from '../workspace.js';
import { rasterizeSvg } from './lib/resvg-init.js';

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

    const opts =
      typeof params.width === 'number'
        ? { fitTo: { mode: 'width' as const, value: params.width } }
        : undefined;
    const { png, width, height } = await rasterizeSvg(params.svg, opts);

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
