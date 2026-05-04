// One-shot smoke test: load the bundled fonts, run satori on a sample
// HTML doc, pipe through resvg, write a PNG. Exists so a developer can
// verify the rendering pipeline works without spinning up Electron.
//
// Run: node scripts/smoke-satori.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import satori from 'satori';
import { html as toVNode } from 'satori-html';
import { Resvg, initWasm } from '@resvg/resvg-wasm';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const fontsDir = path.join(repoRoot, 'assets', 'fonts');

await initWasm(
  readFileSync(
    path.join(repoRoot, 'node_modules', '@resvg', 'resvg-wasm', 'index_bg.wasm'),
  ),
);

const fonts = [
  { file: 'Inter-Regular.ttf', name: 'Inter', weight: 400, style: 'normal' },
  { file: 'Inter-Bold.ttf', name: 'Inter', weight: 700, style: 'normal' },
  { file: 'RimWordFont.ttf', name: 'RimWorld', weight: 400, style: 'normal' },
].map((f) => ({ ...f, data: readFileSync(path.join(fontsDir, f.file)) }));

const sampleHtml = `
<div style="display:flex;flex-direction:column;width:100%;height:100%;background:linear-gradient(135deg,#2a1810 0%,#5a3a1a 100%);padding:48px;color:#fff;font-family:Inter">
  <div style="display:flex;font-family:RimWorld;font-size:96px;line-height:1.1;text-shadow:4px 4px 0 rgba(0,0,0,0.4)">Stalkrim Anomalies</div>
  <div style="display:flex;font-size:32px;margin-top:24px;color:#e8d3a8">A bestiary of irradiated wildlife.</div>
  <div style="display:flex;flex:1;align-items:flex-end;justify-content:flex-end">
    <div style="display:flex;font-family:Inter;font-weight:700;font-size:20px;letter-spacing:8px;text-transform:uppercase;color:#caa462">RIMWORLD MOD</div>
  </div>
</div>`;

const tree = toVNode(sampleHtml);
const svg = await satori(tree, { width: 2560, height: 1440, fonts });
const png = new Resvg(svg, { fitTo: { mode: 'width', value: 1280 } })
  .render()
  .asPng();

const outPath = path.join(repoRoot, 'dist', 'smoke-satori.png');
writeFileSync(outPath, png);
console.log(
  `[smoke-satori] wrote ${outPath} (${png.length} bytes, SVG ${svg.length} chars)`,
);
