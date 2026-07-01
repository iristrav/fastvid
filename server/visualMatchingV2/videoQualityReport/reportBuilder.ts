/** Visual Matching Engine V2 — VideoQualityReport builder.
 *
 *  Pure aggregation over beat_selection_traces + pipeline_run_traces.
 *  Imports nothing from Retrieval, Ranking, CLIP, Vision, or Selector components.
 *  All values are averages, rates, or frequency counts of existing persisted data. */

import { eq } from "drizzle-orm";
import { beatSelectionTraces, pipelineRunTraces } from "../../../drizzle/schema";
import { getDb } from "../../../server/db";
import type {
  CacheBlock,
  DistributionBlock,
  ExplainabilityBlock,
  FrequencyEntry,
  OverallBlock,
  PerformanceBlock,
  QualityBlock,
  ResearchBlock,
  SourceStat,
  SourcesBlock,
  StageTimingEntry,
  StagesBlock,
  VideoQualityReport,
} from "./types";
import type { SelectorTrace, WinnerSnapshot } from "../types";

// ─── Internal helpers ──────────────────────────────────────────────────────────

function avg(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function topN(map: Map<string, number>, n = 5): FrequencyEntry[] {
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([value, count]) => ({ value, count }));
}

function stageEntry(stageMs: number, totalTrackedMs: number): StageTimingEntry {
  return {
    stageMs,
    percentageOfTotal: totalTrackedMs > 0 ? (stageMs / totalTrackedMs) * 100 : 0,
  };
}

// ─── Main builder ──────────────────────────────────────────────────────────────

/**
 * Builds a VideoQualityReport for the given pipeline run.
 * Reads exclusively from beat_selection_traces and pipeline_run_traces.
 * Returns null if no run row is found for pipelineRunId.
 */
export async function buildVideoQualityReport(
  pipelineRunId: string,
  options: {
    previousRunId?: string;
    baselineRunId?: string;
  } = {}
): Promise<VideoQualityReport | null> {
  const db = await getDb();
  if (!db) return null;

  // ── Load run trace ─────────────────────────────────────────────────────────
  const runRows = await db
    .select()
    .from(pipelineRunTraces)
    .where(eq(pipelineRunTraces.pipelineRunId, pipelineRunId))
    .limit(1);

  if (runRows.length === 0) return null;
  const run = runRows[0];

  // ── Load beat traces ───────────────────────────────────────────────────────
  const beatRows = await db
    .select()
    .from(beatSelectionTraces)
    .where(eq(beatSelectionTraces.pipelineRunId, pipelineRunId));

  const totalBeats = beatRows.length;

  // Parse payload to extract WinnerSnapshot and explainability fields.
  type ParsedBeat = {
    needsResearch: boolean;
    confidenceTier: string | null;
    confidence: number | null;
    overallScore: number | null;
    winnerSource: string | null;
    tieBreakApplied: boolean;
    researchReason: string | null;
    winner: WinnerSnapshot | null;
    tieBreakReason: string | null;
    selectionReason: string | null;
    visionCacheHit: boolean | null;
  };

  const beats: ParsedBeat[] = beatRows.map((row) => {
    let winner: WinnerSnapshot | null = null;
    let tieBreakReason: string | null = null;
    let selectionReason: string | null = null;
    let visionCacheHit: boolean | null = null;

    try {
      const trace = JSON.parse(row.payload) as SelectorTrace & { winnerSnapshot?: WinnerSnapshot };
      winner = trace.winnerSnapshot ?? null;
      tieBreakReason = trace.tieBreakReason ?? null;
      selectionReason = trace.selectionReason ?? null;
    } catch {
      // Payload unparseable — use only index columns.
    }

    return {
      needsResearch: row.needsResearch === 1,
      confidenceTier: row.confidenceTier ?? null,
      confidence: row.confidence !== null ? parseFloat(row.confidence) : null,
      overallScore: row.overallScore ?? null,
      winnerSource: row.winnerSource ?? null,
      tieBreakApplied: row.tieBreakApplied === 1,
      researchReason: row.researchReason ?? null,
      winner,
      tieBreakReason,
      selectionReason,
      visionCacheHit,
    };
  });

  // ── Aggregations ───────────────────────────────────────────────────────────

  const selected = beats.filter((b) => !b.needsResearch);
  const beatsSelected = selected.length;
  const beatsResearchRequired = beats.filter((b) => b.needsResearch).length;
  const tieBreaks = beats.filter((b) => b.tieBreakApplied).length;

  const confidences = beats.map((b) => b.confidence).filter((v): v is number => v !== null);
  const visionScores = beats.map((b) => b.overallScore).filter((v): v is number => v !== null);

  // Confidence tier distribution
  const tierCounts = { perfect: 0, good: 0, acceptable: 0, reject: 0 };
  for (const b of beats) {
    const t = b.confidenceTier as keyof typeof tierCounts;
    if (t && t in tierCounts) tierCounts[t] += 1;
  }

  // Source distribution (winners only)
  const sourceCounts = new Map<string, number>();
  for (const b of selected) {
    if (b.winnerSource) {
      sourceCounts.set(b.winnerSource, (sourceCounts.get(b.winnerSource) ?? 0) + 1);
    }
  }

  // Per-source enriched stats from WinnerSnapshot
  const sourceGroups = new Map<string, {
    confidences: number[];
    visionScores: number[];
    clipSimilarities: number[];
    embeddingSimilarities: number[];
    rankingScores: number[];
  }>();

  for (const b of selected) {
    const src = b.winnerSource;
    if (!src) continue;
    if (!sourceGroups.has(src)) {
      sourceGroups.set(src, {
        confidences: [], visionScores: [], clipSimilarities: [],
        embeddingSimilarities: [], rankingScores: [],
      });
    }
    const g = sourceGroups.get(src)!;
    if (b.confidence !== null) g.confidences.push(b.confidence);
    if (b.overallScore !== null) g.visionScores.push(b.overallScore);
    if (b.winner?.clipSimilarity !== null && b.winner?.clipSimilarity !== undefined) {
      g.clipSimilarities.push(b.winner.clipSimilarity);
    }
    if (b.winner?.embeddingSimilarity !== null && b.winner?.embeddingSimilarity !== undefined) {
      g.embeddingSimilarities.push(b.winner.embeddingSimilarity);
    }
    if (b.winner?.rankingScore !== null && b.winner?.rankingScore !== undefined) {
      g.rankingScores.push(b.winner.rankingScore);
    }
  }

  const perSource: SourceStat[] = Array.from(sourceGroups.entries()).map(([source, g]) => ({
    source,
    selectedCount: sourceCounts.get(source) ?? 0,
    selectionShare: rate(sourceCounts.get(source) ?? 0, beatsSelected),
    avgConfidence: avg(g.confidences),
    avgVisionScore: avg(g.visionScores),
    avgClipSimilarity: avg(g.clipSimilarities),
    avgEmbeddingSimilarity: avg(g.embeddingSimilarities),
    avgRankingScore: avg(g.rankingScores),
  })).sort((a, b) => b.selectedCount - a.selectedCount);

  // Explainability frequency tables
  const researchReasonMap = new Map<string, number>();
  const tieBreakReasonMap = new Map<string, number>();
  const selectionReasonMap = new Map<string, number>();

  for (const b of beats) {
    if (b.researchReason) {
      researchReasonMap.set(b.researchReason, (researchReasonMap.get(b.researchReason) ?? 0) + 1);
    }
    if (b.tieBreakApplied && b.tieBreakReason) {
      tieBreakReasonMap.set(b.tieBreakReason, (tieBreakReasonMap.get(b.tieBreakReason) ?? 0) + 1);
    }
    if (b.selectionReason) {
      // Truncate long reasons for frequency grouping
      const key = b.selectionReason.slice(0, 120);
      selectionReasonMap.set(key, (selectionReasonMap.get(key) ?? 0) + 1);
    }
  }

  // Stage timings from the run trace
  const totalTrackedMs =
    run.videoContextMs + run.visualIntentMs + run.retrievalTotalMs +
    run.clipTotalMs + run.rankingTotalMs + run.visionTotalMs + run.selectionTotalMs;

  // Health score: confidence(40) + selection rate(30) + no-reject(20) + no-tiebreak(10)
  const avgConf = avg(confidences) ?? 0;
  const selectionRate = rate(beatsSelected, totalBeats);
  const tieBreakRate = rate(tieBreaks, totalBeats);
  const healthScore = Math.round(
    avgConf * 40 +
    selectionRate * 30 +
    selectionRate * 20 +          // same as selectionRate here — rejectRate = researchRate
    (1 - tieBreakRate) * 10
  );

  // ── Assemble report ────────────────────────────────────────────────────────

  const overall: OverallBlock = {
    pipelineRunId,
    videoId: run.videoId,
    pipelineVersion: run.pipelineVersion,
    beatsProcessed: run.beatsProcessed,
    beatsSelected,
    beatsResearchRequired,
    selectionRate,
    researchRate: rate(beatsResearchRequired, totalBeats),
  };

  const performance: PerformanceBlock = {
    totalDurationMs: run.totalDurationMs,
    avgBeatDurationMs: totalBeats > 0 ? run.totalDurationMs / totalBeats : null,
    startedAt: run.startedAt.toISOString(),
    completedAt: run.completedAt.toISOString(),
  };

  const quality: QualityBlock = {
    avgConfidence: avg(confidences),
    avgVisionScore: avg(visionScores),
    rejectRate: rate(beatsResearchRequired, totalBeats),
    tieBreakRate,
    confidenceDistribution: tierCounts,
  };

  const sources: SourcesBlock = {
    winnerSourceDistribution: Object.fromEntries(sourceCounts),
    perSource,
  };

  const cache: CacheBlock = {
    avgVisionCacheHitRate: null,  // populated from payload when vision cache fields are present
  };

  const stages: StagesBlock = {
    videoContext: stageEntry(run.videoContextMs, totalTrackedMs),
    visualIntent: stageEntry(run.visualIntentMs, totalTrackedMs),
    retrieval: stageEntry(run.retrievalTotalMs, totalTrackedMs),
    clip: stageEntry(run.clipTotalMs, totalTrackedMs),
    ranking: stageEntry(run.rankingTotalMs, totalTrackedMs),
    vision: stageEntry(run.visionTotalMs, totalTrackedMs),
    selection: stageEntry(run.selectionTotalMs, totalTrackedMs),
    totalTrackedMs,
  };

  const research: ResearchBlock = {
    researchRate: rate(beatsResearchRequired, totalBeats),
    researchReasonDistribution: Object.fromEntries(researchReasonMap),
  };

  const distribution: DistributionBlock = {
    confidenceTierDistribution: { ...tierCounts },
    winnerSourceDistribution: Object.fromEntries(sourceCounts),
  };

  const explainability: ExplainabilityBlock = {
    topResearchReasons: topN(researchReasonMap),
    topTieBreakReasons: topN(tieBreakReasonMap),
    topSelectionReasons: topN(selectionReasonMap),
  };

  return {
    pipelineRunId,
    videoId: run.videoId,
    generatedAt: new Date().toISOString(),
    previousRunId: options.previousRunId ?? null,
    baselineRunId: options.baselineRunId ?? null,
    comparison: null,
    healthScore: Math.max(0, Math.min(100, healthScore)),
    overall,
    performance,
    quality,
    sources,
    cache,
    stages,
    research,
    distribution,
    explainability,
  };
}
