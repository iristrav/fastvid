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

export async function listArchiveContentGaps(limit = 50): Promise<ArchiveContentGap[]> {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(archiveContentGaps)
    .orderBy(desc(archiveContentGaps.hitCount))
    .limit(limit);
}

export async function clearArchiveContentGaps(): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const result = await db.delete(archiveContentGaps);
  return (result as unknown as [{ affectedRows: number }])[0]?.affectedRows ?? 0;
}
