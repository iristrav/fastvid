/** Visual Matching Engine V2 — Search Cache.
 *  In-process TTL cache keyed on (source, query, language, filters) so identical searches
 *  within the configured TTL window skip the network call entirely. Stage 2 scope: result
 *  caching only — no embedding cache. Process-local (not shared across workers); intentional
 *  for stage 2 since the Candidate Fetcher isn't wired into the active pipeline yet. */

import type { CandidateAsset, CandidateSource } from "./types";

export type SearchCacheKey = {
  source: CandidateSource;
  query: string;
  language?: string;
  filters?: Record<string, unknown>;
};

type CacheEntry = {
  candidates: CandidateAsset[];
  expiresAt: number;
};

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes

const store = new Map<string, CacheEntry>();

function keyToString(key: SearchCacheKey): string {
  const filtersJson = key.filters ? JSON.stringify(sortKeys(key.filters)) : "{}";
  return `${key.source}::${key.language ?? ""}::${key.query.trim().toLowerCase()}::${filtersJson}`;
}

function sortKeys(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.keys(obj)
    .sort()
    .reduce((acc, k) => {
      acc[k] = obj[k];
      return acc;
    }, {} as Record<string, unknown>);
}

export function getSearchCacheTtlMs(): number {
  const raw = process.env.VISUAL_MATCHING_V2_SEARCH_CACHE_TTL_MS;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TTL_MS;
}

export function getCachedSearch(key: SearchCacheKey): CandidateAsset[] | undefined {
  const entry = store.get(keyToString(key));
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    store.delete(keyToString(key));
    return undefined;
  }
  return entry.candidates;
}

export function setCachedSearch(key: SearchCacheKey, candidates: CandidateAsset[], ttlMs: number = getSearchCacheTtlMs()): void {
  store.set(keyToString(key), { candidates, expiresAt: Date.now() + ttlMs });
}

/** Test/debug helper — not used by production code paths. */
export function clearSearchCache(): void {
  store.clear();
}

export function searchCacheSize(): number {
  return store.size;
}
