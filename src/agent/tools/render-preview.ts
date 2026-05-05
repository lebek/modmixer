import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import path from 'node:path';
import { assertPathAllowed } from '../security/path-policy.js';
import { getPathPolicyRoots } from '../security/policy-roots.js';
import { getWorkspacePaths } from '../workspace.js';
import {
  renderPreview,
  type PreviewParams,
} from './lib/preview-template-renderer.js';

const Params = Type.Object({
  template: Type.Union(
    [
      Type.Literal('classic'),
      Type.Literal('icon-left'),
      Type.Literal('banner'),
    ],
    {
      description:
        "Layout template. 'classic' = sprite + title + optional subtitle stacked centered (the default for most mods). 'icon-left' = sprite on the left, title and subtitle right (good when the sprite is iconic and you want title beside it). 'banner' = full-bleed sprite with the title in a footer band over a dark scrim (use for hero art / total-conversion vibes).",
    },
  ),
  title: Type.String({
    description:
      'The mod title. Required. Auto-fits to span the available width — short titles scale up huge, long titles wrap and shrink. Do not pre-truncate.',
  }),
  subtitle: Type.Optional(
    Type.String({
      description:
        'Optional small uppercase subtitle. Use sparingly: only when it adds genuine info ("Compatible with 1.5", "32 species", "Iron-age tech tweaks"). Omit otherwise. Never use it for "by Author".',
    }),
  ),
  outPath: Type.String({
    description:
      "Output PNG path. Relative paths resolve against the workspace cwd (e.g. 'MyMod/About/Preview.png'). Parent dirs are created. Must be inside the workspace.",
  }),
  spritePath: Type.Optional(
    Type.String({
      description:
        "Path to a sprite/icon image (PNG/JPG/etc.). Relative paths resolve against the workspace; absolute paths are also accepted. Must be inside the workspace. Omit for title-only on a gradient (e.g. an XML-only mod with no art).",
    }),
  ),
  background: Type.Optional(
    Type.String({
      description:
        "CSS background — either a color (`#1c2030`) or a gradient (`linear-gradient(160deg,#3a1d10 0%,#0d0d10 100%)`, `radial-gradient(circle at 30% 20%, #ff7a1a 0%, #7a1f00 55%, #0d0d10 100%)`). Pick a hue that fits the mod's tone. Defaults to a dark neutral.",
    }),
  ),
  titleColor: Type.Optional(
    Type.String({
      description:
        "CSS color for the title. Default white. Pair with `background`: warm titles (#fff2c2, #ffd6a0) on warm/dark backgrounds; cool (#dde7ff, #cfeaff) on cool. High contrast against background is non-negotiable.",
    }),
  ),
  subtitleColor: Type.Optional(
    Type.String({
      description: 'CSS color for the subtitle. Defaults to ~85% white.',
    }),
  ),
  titleFont: Type.Optional(
    Type.Union([Type.Literal('inter'), Type.Literal('rimworld')], {
      description:
        "Title font. 'rimworld' is the game-flavored display face — use it whenever the mod has a RimWorld feel (the default choice for most mods). 'inter' is a clean sans — use it for sci-fi, minimal, or modern-tech mods.",
    }),
  ),
  titleEffect: Type.Optional(
    Type.Union(
      [
        Type.Literal('none'),
        Type.Literal('shadow'),
        Type.Literal('outline'),
        Type.Literal('glow'),
      ],
      {
        description:
          "Title legibility treatment. 'outline' (dark stroke) is the most readable over busy/light backgrounds and pairs very well with the rimworld font. 'shadow' is a soft drop shadow — the safe default. 'glow' uses `accentColor` for a colored halo (good for sci-fi/sparks-flying vibes). 'none' only when the background is uniform and contrast is already strong.",
      },
    ),
  ),
  accentColor: Type.Optional(
    Type.String({
      description:
        "Accent color used by the `glow` effect. Pick a saturated color that complements the background (e.g. an orange glow on a dark scene).",
    }),
  ),
});

export interface RenderPreviewDetails {
  outPath: string;
  bytes: number;
  width: number;
  height: number;
  template: PreviewParams['template'];
}

export const renderPreviewTool: AgentTool<typeof Params, RenderPreviewDetails> = {
  name: 'render_preview',
  label: 'Render preview image',
  description:
    "Render a Steam Workshop preview image (1280×720) using a curated template. Pick 'classic', 'icon-left', or 'banner'; supply the title, an optional sprite path, background, and color/effect choices. The template handles layout, font loading, intelligent wrapping, and auto-fit text sizing — short titles scale up to ~200px, long titles shrink and wrap to fit. Bundled fonts: Inter (400/700) and RimWorld (a RimWorld-style display font). Use this for the Steam Workshop preview image at <ModFolder>/About/Preview.png. The agent does NOT control raw HTML or font sizes — it picks a template and slots. This is the only image-composition tool: do not shell out to imagemagick / inkscape / python / sharp; they are not bundled.",
  parameters: Params,
  async execute(_id, params): Promise<AgentToolResult<RenderPreviewDetails>> {
    const { workspaceDir } = getWorkspacePaths();

    const absOutPath = path.isAbsolute(params.outPath)
      ? params.outPath
      : path.resolve(workspaceDir, params.outPath);
    assertPathAllowed(absOutPath, getPathPolicyRoots(), 'outPath');

    let absSpritePath: string | undefined;
    if (params.spritePath) {
      absSpritePath = path.isAbsolute(params.spritePath)
        ? params.spritePath
        : path.resolve(workspaceDir, params.spritePath);
      assertPathAllowed(absSpritePath, getPathPolicyRoots(), 'spritePath');
    }

    const { width, height, bytes } = await renderPreview(
      {
        template: params.template,
        title: params.title,
        subtitle: params.subtitle,
        spritePath: absSpritePath,
        background: params.background,
        titleColor: params.titleColor,
        subtitleColor: params.subtitleColor,
        titleFont: params.titleFont,
        titleEffect: params.titleEffect,
        accentColor: params.accentColor,
      },
      absOutPath,
      { workspaceDir },
    );

    return {
      content: [
        {
          type: 'text',
          text: `Wrote ${bytes} bytes to ${absOutPath} (${width}×${height} PNG, template=${params.template}).`,
        },
      ],
      details: {
        outPath: absOutPath,
        bytes,
        width,
        height,
        template: params.template,
      },
    };
  },
};
