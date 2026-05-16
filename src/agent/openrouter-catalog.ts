import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

/**
 * A snapshot of the OpenRouter model catalogue (https://openrouter.ai/api/v1/models).
 *
 * We pull two things off each entry:
 *  - pricing — per-million-token rates, mapped onto pi-ai's `Model.cost`.
 *  - input modalities — whether the model accepts images, mapped onto
 *    pi-ai's `Model.input`.
 *
 * Both are cached together on disk so a single daily fetch covers both.
 */

/**
 * Per-million-token rates in the shape pi-ai expects on `Model.cost`.
 * (pi-ai divides by 1e6 to compute per-message dollar cost.)
 */
export interface OpenRouterCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export type OpenRouterPricingMap = Record<string, OpenRouterCost>;

/** Input modalities a model accepts, in the shape pi-ai expects on `Model.input`. */
export type OpenRouterInput = ('text' | 'image')[];

export type OpenRouterInputMap = Record<string, OpenRouterInput>;

/** How long a cached catalogue snapshot is considered fresh. */
const FRESH_AFTER_MS = 24 * 60 * 60 * 1000;

interface CacheFile {
  fetchedAt: number;
  pricing: OpenRouterPricingMap;
  inputs: OpenRouterInputMap;
}

let cached: CacheFile | null | undefined;
let inflight: Promise<CacheFile> | null = null;

function cachePath(): string {
  return path.join(app.getPath('userData'), 'openrouter-catalog.json');
}

function readCache(): CacheFile | null {
  if (cached !== undefined) return cached;
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath(), 'utf8')) as unknown;
    if (
      raw &&
      typeof raw === 'object' &&
      typeof (raw as CacheFile).fetchedAt === 'number' &&
      (raw as CacheFile).pricing &&
      typeof (raw as CacheFile).pricing === 'object' &&
      (raw as CacheFile).inputs &&
      typeof (raw as CacheFile).inputs === 'object'
    ) {
      cached = raw as CacheFile;
      return cached;
    }
  } catch {
    // missing / corrupt / old-shape — fall through and refetch
  }
  cached = null;
  return cached;
}

function writeCache(file: CacheFile): void {
  try {
    fs.mkdirSync(path.dirname(cachePath()), { recursive: true });
    fs.writeFileSync(cachePath(), JSON.stringify(file));
    cached = file;
  } catch {
    // best-effort cache; failures shouldn't block startup
  }
}

/** OpenRouter sends prices as USD-per-token strings; we store USD-per-million. */
function parseRate(v: unknown): number {
  const n =
    typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
  if (!Number.isFinite(n) || n < 0) return 0;
  return n * 1_000_000;
}

/**
 * Map an OpenRouter `architecture.input_modalities` array onto pi-ai's
 * `Model.input`. Text is always assumed; `image` is added only when the
 * catalogue advertises it. Anything missing/malformed degrades to text-only.
 */
function parseInput(architecture: unknown): OpenRouterInput {
  const out: OpenRouterInput = ['text'];
  const mods =
    architecture && typeof architecture === 'object'
      ? (architecture as { input_modalities?: unknown }).input_modalities
      : undefined;
  if (Array.isArray(mods) && mods.includes('image')) out.push('image');
  return out;
}

/**
 * Fetch the OpenRouter catalogue and update the on-disk cache. Single-flight:
 * concurrent callers share one in-flight promise.
 */
export async function fetchOpenRouterCatalog(): Promise<CacheFile> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/models');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { data?: unknown };
      const list = Array.isArray(body.data) ? body.data : [];
      const pricing: OpenRouterPricingMap = {};
      const inputs: OpenRouterInputMap = {};
      for (const entry of list) {
        if (!entry || typeof entry !== 'object') continue;
        const m = entry as {
          id?: unknown;
          pricing?: Record<string, unknown>;
          architecture?: unknown;
        };
        if (typeof m.id !== 'string') continue;
        if (m.pricing) {
          pricing[m.id] = {
            input: parseRate(m.pricing.prompt),
            output: parseRate(m.pricing.completion),
            cacheRead: parseRate(m.pricing.input_cache_read),
            cacheWrite: parseRate(m.pricing.input_cache_write),
          };
        }
        inputs[m.id] = parseInput(m.architecture);
      }
      const file: CacheFile = { fetchedAt: Date.now(), pricing, inputs };
      writeCache(file);
      return file;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function getCachedOpenRouterPricing(): OpenRouterPricingMap | null {
  return readCache()?.pricing ?? null;
}

export function getCachedOpenRouterInputs(): OpenRouterInputMap | null {
  return readCache()?.inputs ?? null;
}

export function isOpenRouterCatalogStale(): boolean {
  const file = readCache();
  if (!file) return true;
  return Date.now() - file.fetchedAt > FRESH_AFTER_MS;
}
