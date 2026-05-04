import path from 'node:path';
import fs from 'node:fs/promises';

interface ResvgRendered {
  asPng(): Uint8Array;
  readonly width: number;
  readonly height: number;
}

export interface ResvgFitTo {
  fitTo?:
    | { mode: 'original' }
    | { mode: 'width'; value: number }
    | { mode: 'height'; value: number }
    | { mode: 'zoom'; value: number };
}

interface ResvgModule {
  initWasm(input: BufferSource | Promise<BufferSource>): Promise<void>;
  Resvg: new (
    svg: string | Uint8Array,
    opts?: ResvgFitTo,
  ) => { render(): ResvgRendered };
}

// Mirrors the dual-resolve pattern used elsewhere: bare require for dev
// (where node_modules sits next to the source), resourcesPath fallback for
// packaged builds where Forge ships node_modules/@resvg/resvg-wasm via
// extraResource (flattened to resources/resvg-wasm/). Resvg.initWasm() can
// only run once per process, so the cache + once-only init are SHARED across
// every tool that rasterizes SVGs.
let cached: { mod: ResvgModule; wasmPath: string } | null = null;
function loadResvg(): { mod: ResvgModule; wasmPath: string } {
  if (cached) return cached;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const mod = require('@resvg/resvg-wasm') as ResvgModule;
    const modDir = path.dirname(require.resolve('@resvg/resvg-wasm'));
    cached = { mod, wasmPath: path.join(modDir, 'index_bg.wasm') };
    return cached;
  } catch (devErr) {
    try {
      const resolved = path.join(process.resourcesPath, 'resvg-wasm');
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
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

export interface RasterizedPng {
  png: Uint8Array;
  width: number;
  height: number;
}

export async function rasterizeSvg(
  svg: string,
  opts?: ResvgFitTo,
): Promise<RasterizedPng> {
  await ensureInitialized();
  const { mod } = loadResvg();
  const resvg = new mod.Resvg(svg, opts);
  const rendered = resvg.render();
  return {
    png: rendered.asPng(),
    width: rendered.width,
    height: rendered.height,
  };
}
