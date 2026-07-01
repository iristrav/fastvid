/**
 * Persistent Scene Candidate Cache — P3 extra optimisation.
 *
 * Caches search API responses (Wikimedia, Archive.org) per normalised query so
 * external providers are not re-queried for the same topic across videos.
 * Pexels file URLs expire quickly so they are stored by ID only (not directly
 * served from cache without re-fetching the file URL).
 *
 * API:
 *   getCandidatePool(query, source) → CachedCandidate[] | null
 *   putCandidatePool(query, source, candidates) → void (best-effort)
 *
 * Active only when sceneCandidateCacheEnabled() returns true.
 */

import { createHash } from "crypto";
import { and, eq, gt } from "drizzle-orm";
import { getDb } from "./db";
import { sceneCandidateCache } from "../drizzle/schema";
import { sceneCandidateCacheEnabled } from "./sourcingPolicy";

export const CANDIDATE_CACHE_VERSION = "1";

/** Seven-day TTL for candidate pools. Visual content on Wikimedia/Archive
 *  changes slowly enough that week-old results are still valid. */
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type CandidateSource = "wikimedia" | "archive" | "pixabay";

/** Stable metadata for one candidate asset — no presigned URLs. */
export type CachedCandidate = {
  /** Stable asset identifier (Wikimedia title, Archive identifier, Pixabay ID). */
  assetId: string;
  /** Human-readable title. */
  title: string;
  /** Direct, stable URL (null when only the assetId is stable). */
  url: string | null;
  /** Thumbnail URL for CLIP scoring without full download (may be null). */
  thumbnailUrl: string | null;
  /** MIME type. */
  contentType: string;
  /** Duration in seconds for video assets. */
  durationSec: number | null;
  /** Source-specific metadata for re-fetching file URLs when needed. */
  meta: Record<string, unknown>;
};

// ─── Internals ────────────────────────────────────────────────────────────────

function buildQueryHash(query: string, source: CandidateSource): string {
  const normalised = query.toLowerCase().trim().replace(/\s+/g, " ");
  return createHash("sha256")
    .update(`${normalised}|${source}|${CANDIDATE_CACHE_VERSION}`)
    .digest("hex");
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns cached candidates for (query, source), or null on miss/expiry/error.
 * Callers should fall through to the live API on null.
 */
export async function getCandidatePool(
  query: string,
  source: CandidateSource
): Promise<CachedCandidate[] | null> {
  if (!sceneCandidateCacheEnabled()) return null;
  try {
    const db = await getDb();
    if (!db) return null;
    const hash = buildQueryHash(query, source);
    const now = new Date();
    const rows = await db
      .select()
      .from(sceneCandidateCache)
      .where(
        and(
          eq(sceneCandidateCache.queryHash, hash),
          eq(sceneCandidateCache.source, source),
          gt(sceneCandidateCache.expiresAt, now)
        )
      )
      .limit(1);
    if (!rows.length) return null;
    const row = rows[0];
    void db
      .update(sceneCandidateCache)
      .set({ hitCount: row.hitCount + 1 })
      .where(eq(sceneCandidateCache.id, row.id))
      .catch(() => {});
    return JSON.parse(row.candidatesJson) as CachedCandidate[];
  } catch {
    return null;
  }
}

/**
 * Stores candidates for (query, source). Best-effort — never throws.
 */
export async function putCandidatePool(
  query: string,
  source: CandidateSource,
  candidates: CachedCandidate[]
): Promise<void> {
  if (!sceneCandidateCacheEnabled() || candidates.length === 0) return;
  try {
    const db = await getDb();
    if (!db) return;
    const hash = buildQueryHash(query, source);
    const expiresAt = new Date(Date.now() + TTL_MS);
    await db
      .insert(sceneCandidateCache)
      .values({
        queryHash: hash,
        queryText: query.slice(0, 512),
        source,
        cacheVersion: CANDIDATE_CACHE_VERSION,
        candidatesJson: JSON.stringify(candidates),
        expiresAt,
      })
      .onDuplicateKeyUpdate({
        set: {
          candidatesJson: JSON.stringify(candidates),
          expiresAt,
          cacheVersion: CANDIDATE_CACHE_VERSION,
        },
      });
  } catch {
    /* best-effort */
  }
}
