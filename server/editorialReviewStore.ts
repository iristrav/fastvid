/**
 * Editorial Review Store — persist and query editorial reviews in MySQL.
 */

import { getDb } from "./db";
import { editorialReviews } from "../drizzle/schema";
import { desc, eq } from "drizzle-orm";
import type { EditorialReview, EditorialDimension } from "./editorialReviewEngine";

// ─── Save ─────────────────────────────────────────────────────────────────────

export async function saveEditorialReview(review: EditorialReview): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    // Extract per-dimension feedback for the dedicated column
    const feedbackMap: Record<string, string> = {};
    for (const [dim, ds] of Object.entries(review.scores)) {
      feedbackMap[dim] = ds.feedback;
    }
    await db.insert(editorialReviews).values({
      videoId: review.videoId,
      videoTitle: review.videoTitle ?? null,
      overallScore: review.overallScore,
      scores: review.scores as unknown as Record<string, unknown>,
      sourcing: review.sourcing as unknown as Record<string, unknown>,
      feedback: feedbackMap,
      autoImprovements: (review.autoImprovements as unknown[]) as Record<string, unknown>[],
      topIssues: review.topIssues,
    });
  } catch (err) {
    console.warn("[EditorialReviewStore] save failed:", (err as Error).message?.slice(0, 80));
  }
}

// ─── Trends ───────────────────────────────────────────────────────────────────

export type DimensionTrend = {
  dimension: EditorialDimension;
  avgScore: number;
  minScore: number;
  renderCount: number;
  consistently_weak: boolean; // avg < 65 across ≥3 renders
};

export type EditorialTrends = {
  overallAvg: number;
  renderCount: number;
  weakDimensions: DimensionTrend[];
  persistentlyWeak: EditorialDimension[];
};

const DIMENSIONS: EditorialDimension[] = [
  "storytelling", "visualStorytelling", "shotVariety", "motion",
  "rhythm", "visualDiversity", "historicalAccuracy", "emotionalImpact",
];

export async function getEditorialTrends(limit = 20): Promise<EditorialTrends | null> {
  try {
    const db = await getDb();
    if (!db) return null;
    const rows = await db
      .select()
      .from(editorialReviews)
      .orderBy(desc(editorialReviews.createdAt))
      .limit(limit);

    if (rows.length === 0) return null;

    const overallAvg = rows.reduce((s, r) => s + r.overallScore, 0) / rows.length;

    const dimTrends: DimensionTrend[] = DIMENSIONS.map((dim) => {
      const scores: number[] = rows.map((r) => {
        const s = (r.scores as Record<string, unknown>)[dim];
        if (s && typeof s === "object" && "score" in s) return (s as { score: number }).score;
        return 50;
      });
      const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
      const min = Math.min(...scores);
      return {
        dimension: dim,
        avgScore: Math.round(avg),
        minScore: min,
        renderCount: scores.length,
        consistently_weak: avg < 65 && scores.length >= 3,
      };
    });

    const weakDimensions = dimTrends.filter((d) => d.consistently_weak);
    const persistentlyWeak = dimTrends
      .filter((d) => d.avgScore < 60 && d.renderCount >= 5)
      .map((d) => d.dimension);

    return { overallAvg: Math.round(overallAvg), renderCount: rows.length, weakDimensions, persistentlyWeak };
  } catch (err) {
    console.warn("[EditorialReviewStore] trend query failed:", (err as Error).message?.slice(0, 80));
    return null;
  }
}

// ─── Latest review for a specific video ──────────────────────────────────────

export async function getLatestReviewForVideo(videoId: string): Promise<EditorialReview | null> {
  try {
    const db = await getDb();
    if (!db) return null;
    const rows = await db
      .select()
      .from(editorialReviews)
      .where(eq(editorialReviews.videoId, videoId))
      .orderBy(desc(editorialReviews.createdAt))
      .limit(1);

    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      videoId: r.videoId,
      videoTitle: r.videoTitle ?? "",
      reviewedAt: r.createdAt.toISOString(),
      overallScore: r.overallScore,
      scores: r.scores as EditorialReview["scores"],
      sourcing: r.sourcing as EditorialReview["sourcing"],
      autoImprovements: r.autoImprovements as EditorialReview["autoImprovements"],
      topIssues: r.topIssues as string[],
    };
  } catch {
    return null;
  }
}
