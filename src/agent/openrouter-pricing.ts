import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

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

/** How long a cached pricing snapshot is considered fresh. */
const FRESH_AFTER_MS = 24 * 60 * 60 * 1000;

interface CacheFile {
  fetchedAt: number;
  models: OpenRouterPricingMap;
}

let cached: CacheFile | null | undefined;
let inflight: Promise<OpenRouterPricingMap> | null = null;

function cachePath(): string {
  return path.join(app.getPath('userData'), 'openrouter-pricing.json');
}

function readCache(): CacheFile | null {
  if (cached !== undefined) return cached;
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath(), 'utf8')) as unknown;
    if (
      raw &&
      typeof raw === 'object' &&
      typeof (raw as CacheFile).fetchedAt === 'number' &&
      (raw as CacheFile).models &&
      typeof (raw as CacheFile).models === 'object'
    ) {
      cached = raw as CacheFile;
      return cached;
    }
  } catch {
    // missing / corrupt — fall through
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
 * Fetch the OpenRouter catalogue and update the on-disk cache. Single-flight:
 * concurrent callers share one in-flight promise.
 */
export async function fetchOpenRouterPricing(): Promise<OpenRouterPricingMap> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/models');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { data?: unknown };
      const list = Array.isArray(body.data) ? body.data : [];
      const models: OpenRouterPricingMap = {};
      for (const entry of list) {
        if (!entry || typeof entry !== 'object') continue;
        const m = entry as { id?: unknown; pricing?: Record<string, unknown> };
        if (typeof m.id !== 'string' || !m.pricing) continue;
        models[m.id] = {
          input: parseRate(m.pricing.prompt),
          output: parseRate(m.pricing.completion),
          cacheRead: parseRate(m.pricing.input_cache_read),
          cacheWrite: parseRate(m.pricing.input_cache_write),
        };
      }
      writeCache({ fetchedAt: Date.now(), models });
      return models;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function getCachedOpenRouterPricing(): OpenRouterPricingMap | null {
  return readCache()?.models ?? null;
}

export function isOpenRouterPricingStale(): boolean {
  const file = readCache();
  if (!file) return true;
  return Date.now() - file.fetchedAt > FRESH_AFTER_MS;
}
