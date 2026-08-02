/**
 * Persistent Beat Semantic Profile Cache.
 *
 * The in-process Map cache in semanticVisualMatching.ts (profileCache) only lives for the
 * lifetime of one server process — every redeploy, crash, or landing on a different worker
 * replica resets it. A video retried after any of those re-pays full LLM cost for every beat's
 * semantic analysis (entities, search tiers, topic domain) even though the identical beat text
 * was already analyzed minutes or hours earlier. Confirmed as a real cost driver in the
 * 2026-08-02 audit: one video's retries burned 100+ LLM calls per attempt, repeatedly, because
 * every redeploy during that debugging session reset this exact cache.
 *
 * Mirrors sceneCandidateCache.ts's pattern: a hash-keyed row per (beat text, video title,
 * literal visual, cache version), shared across all videos/processes — not scoped to one video,
 * since identical beat text (a common retry case) should hit regardless of which video record
 * it came from.
 *
 * API:
 *   getCachedBeatProfile(cacheKey) → BeatSemanticProfile | null
 *   putCachedBeatProfile(cacheKey, profile) → void (best-effort)
 *
 * Active unless beatSemanticCacheEnabled() returns false.
 */

import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { beatSemanticCache } from "../drizzle/schema";
import { beatSemanticCacheEnabled } from "./sourcingPolicy";
import type { BeatSemanticProfile } from "./semanticVisualMatching";

/** Bump to invalidate all cached entries when the extraction prompt/shape changes. */
export const BEAT_SEMANTIC_CACHE_VERSION = "1";

/**
 * Returns the cached profile for this exact cache key, or null on miss/error.
 * Callers should fall through to the live LLM call on null.
 */
export async function getCachedBeatProfile(cacheKey: string): Promise<BeatSemanticProfile | null> {
  if (!beatSemanticCacheEnabled()) return null;
  try {
    const db = await getDb();
    if (!db) return null;
    const rows = await db
      .select()
      .from(beatSemanticCache)
      .where(eq(beatSemanticCache.cacheKey, cacheKey))
      .limit(1);
    if (!rows.length) return null;
    const row = rows[0]!;
    if (row.cacheVersion !== BEAT_SEMANTIC_CACHE_VERSION) return null;
    void db
      .update(beatSemanticCache)
      .set({ hitCount: row.hitCount + 1 })
      .where(eq(beatSemanticCache.id, row.id))
      .catch(() => {});
    return JSON.parse(row.profileJson) as BeatSemanticProfile;
  } catch {
    return null;
  }
}

/** Stores a profile for this cache key. Best-effort — never throws. */
export async function putCachedBeatProfile(
  cacheKey: string,
  profile: BeatSemanticProfile
): Promise<void> {
  if (!beatSemanticCacheEnabled()) return;
  try {
    const db = await getDb();
    if (!db) return;
    await db
      .insert(beatSemanticCache)
      .values({
        cacheKey,
        cacheVersion: BEAT_SEMANTIC_CACHE_VERSION,
        profileJson: JSON.stringify(profile),
      })
      .onDuplicateKeyUpdate({
        set: {
          profileJson: JSON.stringify(profile),
          cacheVersion: BEAT_SEMANTIC_CACHE_VERSION,
        },
      });
  } catch {
    /* best-effort */
  }
}
