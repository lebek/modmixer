// Community sorting rules — third-party knowledge that maps "this mod loads
// before/after that one" beyond what's declared in About.xml. The de facto
// source is the RimSort Community-Rules-DB (MIT-licensed), which RimSort and
// RimPy use for autosort.
//
// We fetch the JSON on first run, cache it under userData with a TTL, and use
// the cached copy as soft constraints during autosort. Hard About.xml deps
// always win.
//
// This module is deliberately tolerant: if the network is unavailable, the
// JSON has changed shape, or the user is offline, the registry still works —
// autosort just falls back to About.xml-only rules.

import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { app } from 'electron';

const RULES_URL =
  'https://raw.githubusercontent.com/RimSort/Community-Rules-DB/main/communityRules.json';
const CACHE_FILENAME = 'community-rules.json';
const CACHE_META_FILENAME = 'community-rules.meta.json';
const TTL_HOURS = 24;
const FETCH_TIMEOUT_MS = 10_000;

export interface CommunityRule {
  /** Lowercased packageId. */
  packageId: string;
  /** Lowercased packageIds we should load AFTER (i.e. these come before us). */
  loadAfter: string[];
  /** Lowercased packageIds we should load BEFORE (i.e. these come after us). */
  loadBefore: string[];
  /** Whether the community asserts this mod should load near the bottom. */
  loadBottom: boolean;
}

export interface CommunityRulesSnapshot {
  fetchedAt: string | null;
  source: 'cache' | 'fetched' | 'bundled' | 'empty';
  byPackageId: Map<string, CommunityRule>;
}

let cached: CommunityRulesSnapshot | null = null;
let inflight: Promise<CommunityRulesSnapshot> | null = null;

function cachePath(): string {
  return path.join(app.getPath('userData'), CACHE_FILENAME);
}

function metaPath(): string {
  return path.join(app.getPath('userData'), CACHE_META_FILENAME);
}

export async function getCommunityRules(): Promise<CommunityRulesSnapshot> {
  if (cached) return cached;
  if (inflight) return inflight;
  inflight = loadOrFetch().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** Force a refresh from the network. */
export async function refreshCommunityRules(): Promise<CommunityRulesSnapshot> {
  cached = null;
  try {
    const fetched = await fetchRules();
    await persist(fetched);
    cached = {
      fetchedAt: new Date().toISOString(),
      source: 'fetched',
      byPackageId: fetched,
    };
    return cached;
  } catch {
    return getCommunityRules();
  }
}

async function loadOrFetch(): Promise<CommunityRulesSnapshot> {
  const onDisk = await readCache();
  if (onDisk && !isStale(onDisk.fetchedAt)) {
    cached = {
      fetchedAt: onDisk.fetchedAt,
      source: 'cache',
      byPackageId: onDisk.byPackageId,
    };
    // Kick off a background refresh, but don't await it.
    void backgroundRefresh();
    return cached;
  }
  // Either no cache or stale — try to fetch. Fall back to whatever we have.
  try {
    const fetched = await fetchRules();
    await persist(fetched);
    cached = {
      fetchedAt: new Date().toISOString(),
      source: 'fetched',
      byPackageId: fetched,
    };
    return cached;
  } catch {
    if (onDisk) {
      cached = {
        fetchedAt: onDisk.fetchedAt,
        source: 'cache',
        byPackageId: onDisk.byPackageId,
      };
      return cached;
    }
    cached = { fetchedAt: null, source: 'empty', byPackageId: new Map() };
    return cached;
  }
}

async function backgroundRefresh(): Promise<void> {
  try {
    const fetched = await fetchRules();
    await persist(fetched);
    cached = {
      fetchedAt: new Date().toISOString(),
      source: 'fetched',
      byPackageId: fetched,
    };
  } catch {
    // ignore — keep the cached version
  }
}

function isStale(fetchedAt: string | null): boolean {
  if (!fetchedAt) return true;
  const age = Date.now() - new Date(fetchedAt).getTime();
  return age > TTL_HOURS * 3600 * 1000;
}

async function readCache(): Promise<{
  fetchedAt: string;
  byPackageId: Map<string, CommunityRule>;
} | null> {
  try {
    if (!fs.existsSync(cachePath()) || !fs.existsSync(metaPath())) return null;
    const meta = JSON.parse(await fsp.readFile(metaPath(), 'utf8'));
    const json = JSON.parse(await fsp.readFile(cachePath(), 'utf8'));
    return {
      fetchedAt: meta.fetchedAt ?? new Date(0).toISOString(),
      byPackageId: parseRulesJson(json),
    };
  } catch {
    return null;
  }
}

async function persist(rules: Map<string, CommunityRule>): Promise<void> {
  const obj: Record<string, CommunityRule> = {};
  for (const [k, v] of rules) obj[k] = v;
  try {
    await fsp.writeFile(cachePath(), JSON.stringify(obj, null, 2), 'utf8');
    await fsp.writeFile(
      metaPath(),
      JSON.stringify({ fetchedAt: new Date().toISOString() }, null, 2),
      'utf8',
    );
  } catch {
    // best-effort
  }
}

async function fetchRules(): Promise<Map<string, CommunityRule>> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(RULES_URL, { signal: ac.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return parseRulesJson(json);
  } finally {
    clearTimeout(t);
  }
}

/**
 * The RimSort schema looks like:
 *   { "rules": { "<packageId>": { "loadBefore": { ... }, "loadAfter": { ... }, "loadBottom": { "value": true } } } }
 * keys inside loadBefore/loadAfter are themselves objects (with comments etc.)
 * keyed by referenced packageId. We flatten that to plain string arrays.
 *
 * We're tolerant of variations because the upstream DB has historically
 * shifted shape across rewrites (rimsort, rimpy, rimworld-tooling forks).
 */
function parseRulesJson(json: unknown): Map<string, CommunityRule> {
  const out = new Map<string, CommunityRule>();
  if (!json || typeof json !== 'object') return out;
  const root = json as Record<string, unknown>;
  const rules =
    (root.rules as Record<string, unknown> | undefined) ??
    (root as Record<string, unknown>);
  if (!rules || typeof rules !== 'object') return out;

  for (const [pid, raw] of Object.entries(rules)) {
    if (!raw || typeof raw !== 'object') continue;
    const lc = pid.toLowerCase();
    const r = raw as Record<string, unknown>;
    const loadAfter = collectKeys(r.loadAfter);
    const loadBefore = collectKeys(r.loadBefore);
    const loadBottom = parseLoadBottom(r.loadBottom);
    out.set(lc, {
      packageId: lc,
      loadAfter,
      loadBefore,
      loadBottom,
    });
  }
  return out;
}

function collectKeys(node: unknown): string[] {
  if (!node || typeof node !== 'object') return [];
  // Some entries are arrays; many are objects with packageIds as keys.
  if (Array.isArray(node)) {
    return node
      .filter((v): v is string => typeof v === 'string')
      .map((s) => s.toLowerCase());
  }
  return Object.keys(node as Record<string, unknown>).map((k) =>
    k.toLowerCase(),
  );
}

function parseLoadBottom(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false;
  const obj = node as Record<string, unknown>;
  if (typeof obj.value === 'boolean') return obj.value;
  return false;
}
