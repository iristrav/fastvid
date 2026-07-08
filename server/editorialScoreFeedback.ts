/**
 * Editorial Score Feedback — zelflerend score-systeem.
 *
 * Na iedere render worden adopt- en reject-events gebruikt om de editorial score
 * van archive-assets licht bij te stellen:
 *
 *  - Clip gekozen (niet-fallback) → score +1 (max 100)
 *  - Clip was fallback/placeholder → score −1 (min 0)
 *
 * Max delta per render: ±10 per asset, zodat één uitbijter niet de score domineert.
 * Aanroepen: asynchroon, fire-and-forget na render-afsluiting.
 * Geldt alleen voor own_archive assets met een assetId in de DB.
 *
 * Feature flag: EDITORIAL_SCORE_FEEDBACK_ENABLED (default: "true")
 */

import { getDb } from "./db";
import { mediaArchiveAssets } from "../drizzle/schema";
import { eq, sql } from "drizzle-orm";
import type { ClipAdoptEntry } from "./clipAdoptAudit";

// ─── Feature flag ─────────────────────────────────────────────────────────────

export function editorialScoreFeedbackEnabled(): boolean {
  return process.env.EDITORIAL_SCORE_FEEDBACK_ENABLED !== "false";
}

// ─── Types ────────────────────────────────────────────────────────────────────

type ScoreDelta = {
  assetId: number;
  delta: number; // +1 (adopt) of -1 (reject/fallback)
};

const FALLBACK_SOURCES = new Set([
  "rescue_placeholder",
  "rescue_extend",
  "fallback",
  "color_fallback",
  "guaranteed",
]);

const MAX_DELTA_PER_ASSET = 10;

// ─── Score update ──────────────────────────────────────────────────────────────

/**
 * Pas editorial scores bij op basis van adopt-events na een render.
 * Fire-and-forget — gooit nooit.
 */
export async function applyEditorialScoreFeedback(
  adoptAudit: ClipAdoptEntry[],
  assetIdsByBasename: Map<string, number>
): Promise<void> {
  if (!editorialScoreFeedbackEnabled()) return;
  if (adoptAudit.length === 0) return;

  try {
    const db = await getDb();
    if (!db) return;

    // Aggregeer deltas per assetId (cap ±MAX_DELTA_PER_ASSET)
    const deltaMap = new Map<number, number>();

    for (const entry of adoptAudit) {
      const assetId = assetIdsByBasename.get(entry.basename.toLowerCase());
      if (!assetId) continue;

      const isFallback = FALLBACK_SOURCES.has(entry.source);
      const delta = isFallback ? -1 : +1;

      const current = deltaMap.get(assetId) ?? 0;
      deltaMap.set(assetId, Math.max(-MAX_DELTA_PER_ASSET, Math.min(MAX_DELTA_PER_ASSET, current + delta)));
    }

    if (deltaMap.size === 0) return;

    // Voer updates uit — clamp score altijd tussen 0 en 100
    const updates = Array.from(deltaMap.entries());
    await Promise.all(
      updates.map(([assetId, delta]) =>
        db
          .update(mediaArchiveAssets)
          .set({
            editorialScore: sql`GREATEST(0, LEAST(100, COALESCE(editorialScore, 50) + ${delta}))`,
          })
          .where(eq(mediaArchiveAssets.id, assetId))
          .catch((err: Error) => {
            console.warn(`[EditorialScore] Update asset ${assetId} mislukt:`, err.message?.slice(0, 60));
          })
      )
    );

    const adopted = updates.filter(([, d]) => d > 0).length;
    const rejected = updates.filter(([, d]) => d < 0).length;
    console.log(`[EditorialScore] Feedback toegepast: ${adopted} assets ↑, ${rejected} assets ↓`);
  } catch (err) {
    console.warn("[EditorialScore] Feedback fout (genegeerd):", (err as Error).message?.slice(0, 80));
  }
}
