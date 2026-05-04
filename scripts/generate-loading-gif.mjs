// Renders assets/logo.svg centered on a black canvas with three pulsing
// dots underneath, and writes assets/loading.gif. Used by MakerSquirrel as
// the install/update splash. Re-run after editing logo.svg.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import gifenc from 'gifenc';
const { GIFEncoder, quantize, applyPalette } = gifenc;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SVG = path.join(ROOT, 'assets/logo.svg');
const OUT = path.join(ROOT, 'assets/loading.gif');

const W = 640;
const H = 400;
const LOGO_WIDTH = 480;
const FRAMES = 18;
const DELAY_MS = 80;

const DOT_RADIUS = 6;
const DOT_SPACING = 32;
const DOTS_W = 2 * DOT_SPACING + 2 * DOT_RADIUS + 4;
const DOTS_H = 2 * DOT_RADIUS + 4;
const DOT_FILL = '#f4f4f0';

const svg = await fs.readFile(SVG);
const logo = await sharp(svg, { density: 600 })
  .resize({ width: LOGO_WIDTH })
  .png()
  .toBuffer();
const { width: lw, height: lh } = await sharp(logo).metadata();
const logoTop = Math.round((H - lh) / 2) - 30;
const logoLeft = Math.round((W - lw) / 2);
const dotsTop = logoTop + lh + 40;
const dotsLeft = Math.round((W - DOTS_W) / 2);

function dotsSvg(opacities) {
  const cy = DOTS_H / 2;
  const cx0 = DOT_RADIUS + 2;
  const circles = opacities
    .map(
      (op, i) =>
        `<circle cx="${cx0 + i * DOT_SPACING}" cy="${cy}" r="${DOT_RADIUS}" fill="${DOT_FILL}" opacity="${op.toFixed(3)}"/>`,
    )
    .join('');
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${DOTS_W}" height="${DOTS_H}">${circles}</svg>`,
  );
}

// Wave: each dot peaks at a different phase of the loop, smooth gaussian
// falloff so the brightness sweeps left→right then wraps.
function dotOpacity(frameIdx, dotIdx) {
  const phase = frameIdx / FRAMES;
  const dotPhase = dotIdx / 3;
  let d = (phase - dotPhase + 1) % 1;
  d = Math.min(d, 1 - d);
  return 0.2 + 0.8 * Math.exp(-15 * d * d);
}

async function buildFrame(frameIdx) {
  const dots = dotsSvg([0, 1, 2].map((i) => dotOpacity(frameIdx, i)));
  return sharp({
    create: {
      width: W,
      height: H,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 1 },
    },
  })
    .composite([
      { input: logo, top: logoTop, left: logoLeft },
      { input: dots, top: dotsTop, left: dotsLeft },
    ])
    .raw()
    .toBuffer();
}

const frames = [];
for (let f = 0; f < FRAMES; f++) {
  frames.push(await buildFrame(f));
}

// Build a single global palette from all frame pixels — keeps the GIF small
// and avoids inter-frame palette flicker on the dot edges.
const palette = quantize(new Uint8Array(Buffer.concat(frames)), 64);

const gif = GIFEncoder();
for (const frame of frames) {
  const indexed = applyPalette(new Uint8Array(frame), palette);
  gif.writeFrame(indexed, W, H, { palette, delay: DELAY_MS });
}
gif.finish();
await fs.writeFile(OUT, Buffer.from(gif.bytes()));

console.log(
  `Wrote ${OUT} (${W}x${H}, ${FRAMES} frames @ ${DELAY_MS}ms = ${(FRAMES * DELAY_MS) / 1000}s loop)`,
);
