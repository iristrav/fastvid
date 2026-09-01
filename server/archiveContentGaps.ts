/**
 * Archive content gap tracking.
 *
 * Every time the pipeline falls back from the media archive to Pexels/Pixabay
 * because no good archive match was found, the search keywords are recorded
 * here. The Media Archive admin surfaces the most frequent gaps so uploads
 * can be targeted at what's actually missing instead of guessed at.
 */

import { createHash } from "crypto";
import { desc, sql } from "drizzle-orm";
import { getDb } from "./db";
import { archiveContentGaps, type ArchiveContentGap } from "../drizzle/schema";
import { gapRowLooksLikePerson } from "./archiveGapNames";

function keywordHash(keyword: string): string {
  return createHash("sha256").update(keyword).digest("hex");
}

/** Best-effort — never throws, never blocks the pipeline. */
export async function recordArchiveContentGap(keyword: string, sampleBeatText?: string): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    const normalized = keyword.trim().toLowerCase().slice(0, 256);
    if (!normalized) return;
    const hash = keywordHash(normalized);
    await db
      .insert(archiveContentGaps)
      .values({
        keywordHash: hash,
        keyword: normalized,
        sampleBeatText: sampleBeatText?.trim().slice(0, 512) || undefined,
        hitCount: 1,
      })
      .onDuplicateKeyUpdate({
        set: {
          hitCount: sql`${archiveContentGaps.hitCount} + 1`,
          lastSeenAt: new Date(),
        },
      });
  } catch (err) {
    console.warn("[ArchiveContentGaps] record failed:", (err as Error).message?.slice(0, 120));
  }
}

/**
 * RONDE 127 — the admin list shows PEOPLE, not search phrases.
 *
 * The recording side only writes person names from now on, but the table already holds rows like
 * "berlin street 1930s documentary" from before this round. Filtering the list rather than
 * clearing the table keeps their hit counts intact in case they are ever wanted again, while the
 * page shows what it is for: the names an archive has no footage of.
 *
 * Over-fetches so the filter can still fill the requested limit.
 */
export async function listArchiveContentGaps(limit = 50): Promise<ArchiveContentGap[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select()
    .from(archiveContentGaps)
    .orderBy(desc(archiveContentGaps.hitCount))
    .limit(Math.min(1000, limit * 10));
  return rows.filter((r) => gapRowLooksLikePerson(r.keyword)).slice(0, limit);
}

export async function clearArchiveContentGaps(): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const result = await db.delete(archiveContentGaps);
  return (result as unknown as [{ affectedRows: number }])[0]?.affectedRows ?? 0;
}
