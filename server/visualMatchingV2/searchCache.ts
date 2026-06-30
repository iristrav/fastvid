/** Visual Matching Engine V2 — Search Cache.
 *  The Candidate Fetcher depends only on the SearchCacheProvider interface (types.ts), never
 *  on a concrete backend. MemorySearchCacheProvider is the stage-2 default (process-local,
 *  TTL-based) — swapping in Redis/DB later means writing one new class and changing the
 *  provider passed to getSearchCacheProvider(), with zero changes to the Candidate Fetcher. */

import type { CandidateAsset, SearchCacheKey, SearchCacheProvider } from "./types";

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes

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

type CacheEntry = {
  candidates: CandidateAsset[];
  expiresAt: number;
};

/** Stage-2 default backend: in-process Map with TTL expiry. Not shared across workers —
 *  acceptable since the Candidate Fetcher isn't wired into the active (multi-worker)
 *  pipeline yet. A Redis-backed provider can implement the same interface later. */
export class MemorySearchCacheProvider implements SearchCacheProvider {
  private store = new Map<string, CacheEntry>();

  async get(key: SearchCacheKey): Promise<CandidateAsset[] | undefined> {
    const k = keyToString(key);
    const entry = this.store.get(k);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(k);
      return undefined;
    }
    return entry.candidates;
  }

  async set(key: SearchCacheKey, candidates: CandidateAsset[], ttlMs: number): Promise<void> {
    this.store.set(keyToString(key), { candidates, expiresAt: Date.now() + ttlMs });
  }

  async delete(key: SearchCacheKey): Promise<void> {
    this.store.delete(keyToString(key));
  }

  async clear(): Promise<void> {
    this.store.clear();
  }

  size(): number {
    return this.store.size;
  }
}

let provider: SearchCacheProvider = new MemorySearchCacheProvider();

/** Swap the active cache backend (e.g. a future RedisSearchCacheProvider). The Candidate
 *  Fetcher never needs to know which backend is active. */
export function setSearchCacheProvider(next: SearchCacheProvider): void {
  provider = next;
}

export function getSearchCacheProvider(): SearchCacheProvider {
  return provider;
}

export function getSearchCacheTtlMs(): number {
  const raw = process.env.VISUAL_MATCHING_V2_SEARCH_CACHE_TTL_MS;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TTL_MS;
}

export async function getCachedSearch(key: SearchCacheKey): Promise<CandidateAsset[] | undefined> {
  return provider.get(key);
}

export async function setCachedSearch(key: SearchCacheKey, candidates: CandidateAsset[], ttlMs: number = getSearchCacheTtlMs()): Promise<void> {
  return provider.set(key, candidates, ttlMs);
}

/** Test/debug helper — not used by production code paths. */
export async function clearSearchCache(): Promise<void> {
  return provider.clear();
}
