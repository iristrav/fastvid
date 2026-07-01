/**
 * Pipeline Performance Baseline Analysis
 *
 * Reads all completed videos from the DB, extracts qualityReport +
 * pipelineStepTiming from metadata, and prints a structured performance
 * summary with percentiles (P50, P95), per-length breakdowns, bottleneck
 * ranking, and a concrete next-step recommendation.
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/pipeline-baseline.ts
 *   DATABASE_URL=... npx tsx scripts/pipeline-baseline.ts --limit 50
 *   DATABASE_URL=... npx tsx scripts/pipeline-baseline.ts --since 2025-06-01
 */

import "dotenv/config";
import { getDb } from "../server/db";
import { videos } from "../drizzle/schema";
import { desc, eq, gte, and } from "drizzle-orm";
import type { VideoQualityReport } from "../server/videoQualityReport";
import type { PipelineTimingRow, PipelineTimingCategory } from "../server/pipelineStepTiming";

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const limitIdx = args.indexOf("--limit");
const LIMIT = limitIdx >= 0 ? parseInt(args[limitIdx + 1] ?? "200", 10) : 200;
const sinceIdx = args.indexOf("--since");
const SINCE = sinceIdx >= 0 ? new Date(args[sinceIdx + 1] ?? "") : null;

// ─── Types ────────────────────────────────────────────────────────────────────

type TimingReport = {
  rows: PipelineTimingRow[];
  totalsByCategory: Record<string, number>;
  totalsByScene: Record<string, number>;
};

type RunData = {
  videoId: number;
  title: string;
  videoLength: string | null;
  pipelineSec: number;
  quality: VideoQualityReport;
  timing: TimingReport;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function pct(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx]!;
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function fmt(sec: number): string {
  if (sec < 60) return `${sec.toFixed(0)}s`;
  return `${Math.floor(sec / 60)}m${(sec % 60).toFixed(0).padStart(2, "0")}s`;
}

function fmtMs(ms: number): string {
  return fmt(ms / 1000);
}

function bar(fraction: number, width = 20): string {
  const filled = Math.round(Math.max(0, Math.min(1, fraction)) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function lengthCategory(videoLength: string | null): string {
  if (!videoLength) return "unknown";
  const n = parseFloat(videoLength);
  if (isNaN(n)) return videoLength;
  if (n <= 1) return "≤1 min";
  if (n <= 5) return "2–5 min";
  if (n <= 10) return "6–10 min";
  return ">10 min";
}

// ─── Category labels (matches PipelineStepTiming.CATEGORY_LABELS) ─────────────

const CATEGORY_LABELS: Record<string, string> = {
  scene_generation: "Script generation",
  voiceover: "Voiceover (TTS)",
  image_search: "Retrieval (search)",
  image_download: "Retrieval (download)",
  image_processing: "CLIP / thumbnail / processing",
  scene_composition: "Compose (FFmpeg montage)",
  video_rendering: "Final concat + music + upload",
  compose_rescue: "Compose rescue fetch",
  llm_call: "LLM calls (misc)",
};

// ─── Percentile table printer ─────────────────────────────────────────────────

function printPercentileTable(
  label: string,
  values: number[],
  toStr: (v: number) => string
): void {
  if (values.length === 0) {
    console.log(`  ${label}: no data`);
    return;
  }
  const a = avg(values);
  const p50 = pct(values, 50);
  const p95 = pct(values, 95);
  const min = Math.min(...values);
  const max = Math.max(...values);
  console.log(
    `  ${label.padEnd(38)} avg=${toStr(a).padStart(7)}  P50=${toStr(p50).padStart(7)}  P95=${toStr(p95).padStart(7)}  (min=${toStr(min)}  max=${toStr(max)}, n=${values.length})`
  );
}

// ─── Bottleneck recommendation engine ────────────────────────────────────────

const RECOMMENDATIONS: Array<{
  category: string;
  threshold: number; // fraction of total pipeline time
  next: string;
  gain: string;
}> = [
  { category: "scene_composition", threshold: 0.30, next: "P5: streaming compose (pipeline per scene)", gain: "15–30%" },
  { category: "video_rendering",   threshold: 0.25, next: "P7: parallel upload + streaming concat", gain: "10–20%" },
  { category: "image_processing",  threshold: 0.20, next: "P8: persistent CLIP vectors at ingest time", gain: "10–25%" },
  { category: "image_download",    threshold: 0.20, next: "P9: expand media cache + prefetch wins", gain: "10–20%" },
  { category: "image_search",      threshold: 0.15, next: "Expand archive + self-learning ingestion", gain: "varies" },
  { category: "voiceover",         threshold: 0.15, next: "TTS streaming / parallel scene TTS", gain: "5–15%" },
  { category: "llm_call",          threshold: 0.10, next: "LLM call batching / caching", gain: "5–15%" },
];

// ─── Main ─────────────────────────────────────────────────────────────────────

const db = await getDb();
if (!db) {
  console.error("No DB connection — set DATABASE_URL");
  process.exit(1);
}

// Fetch completed videos
const conditions = [eq(videos.status, "completed")];
if (SINCE && !isNaN(SINCE.getTime())) {
  conditions.push(gte(videos.createdAt, SINCE));
}
const rows = await db
  .select({
    id: videos.id,
    title: videos.title,
    videoLength: videos.videoLength,
    metadata: videos.metadata,
  })
  .from(videos)
  .where(and(...conditions))
  .orderBy(desc(videos.createdAt))
  .limit(LIMIT);

console.log(`\nLoaded ${rows.length} completed video(s) (limit=${LIMIT}${SINCE ? `, since=${SINCE.toISOString().slice(0,10)}` : ""})\n`);

// Parse metadata → RunData
const runs: RunData[] = [];
for (const row of rows) {
  const meta = row.metadata as Record<string, unknown> | null;
  if (!meta) continue;
  const quality = meta.qualityReport as VideoQualityReport | undefined;
  const timing = meta.pipelineStepTiming as TimingReport | undefined;
  if (!quality || !timing) continue;
  const pipelineSec = quality.pipelineSec ?? 0;
  if (pipelineSec <= 0) continue;
  runs.push({
    videoId: row.id,
    title: row.title ?? "(no title)",
    videoLength: row.videoLength ?? null,
    pipelineSec,
    quality,
    timing,
  });
}

if (runs.length === 0) {
  console.log("No runs with complete timing data found. Make sure videos have been generated with pipelineStepTiming enabled.");
  process.exit(0);
}

console.log(`Runs with timing data: ${runs.length}\n`);

// ─── Overall KPIs ─────────────────────────────────────────────────────────────

console.log("═══════════════════════════════════════════════════════════════════");
console.log("  OVERALL PIPELINE PERFORMANCE");
console.log("═══════════════════════════════════════════════════════════════════\n");

const totalSecs = runs.map(r => r.pipelineSec);
printPercentileTable("Total render time (s)", totalSecs, fmt);

// Quality scores
const scores = runs.map(r => r.quality.score).filter(s => s > 0);
printPercentileTable("Quality score (0–100)", scores, v => v.toFixed(0));

// Archive ratio
const archiveRatios = runs.map(r =>
  r.quality.totalClips > 0 ? (r.quality.archiveCount / r.quality.totalClips) * 100 : 0
);
printPercentileTable("Archive clip ratio (%)", archiveRatios, v => `${v.toFixed(0)}%`);

// Stock beats
const stockCounts = runs.map(r => r.quality.adoptAuditSummary?.stockBeats ?? r.quality.stockCount);
printPercentileTable("Stock beats per video", stockCounts, v => v.toFixed(0));

// Fallback beats
const fallbackBeats = runs.map(r => r.quality.adoptAuditSummary?.fallbackBeats ?? 0);
printPercentileTable("Fallback beats per video", fallbackBeats, v => v.toFixed(0));

// Vision scores from adoptAudit (average per video)
const avgVisionScores: number[] = [];
for (const run of runs) {
  const entries = run.quality.adoptAuditSummary;
  // compute from warnings or directly from adopt audit if available
  // qualityReport only has summary — use score as proxy for now
  if (run.quality.score > 0) avgVisionScores.push(run.quality.score);
}

console.log();

// ─── Stage timing breakdown ───────────────────────────────────────────────────

console.log("═══════════════════════════════════════════════════════════════════");
console.log("  STAGE TIMING (ms per run)");
console.log("═══════════════════════════════════════════════════════════════════\n");

// Collect all category keys seen across runs
const allCategories = new Set<string>();
for (const run of runs) {
  for (const key of Object.keys(run.timing.totalsByCategory)) {
    allCategories.add(key);
  }
}

// Compute aggregate total across all instrumented stages per run
const instrumentedTotalMs: number[] = runs.map(run =>
  Object.values(run.timing.totalsByCategory).reduce((a, b) => a + b, 0)
);

const categoryStats: Array<{
  key: string;
  label: string;
  values: number[];
  avgMs: number;
}> = [];

for (const cat of allCategories) {
  const vals = runs
    .map(r => r.timing.totalsByCategory[cat] ?? 0)
    .filter(v => v > 0);
  if (vals.length === 0) continue;
  categoryStats.push({
    key: cat,
    label: CATEGORY_LABELS[cat] ?? cat,
    values: vals,
    avgMs: avg(vals),
  });
}

categoryStats.sort((a, b) => b.avgMs - a.avgMs);

const maxAvgMs = categoryStats[0]?.avgMs ?? 1;
const totalAvgMs = avg(instrumentedTotalMs);

for (const { key, label, values, avgMs } of categoryStats) {
  const fraction = avgMs / totalAvgMs;
  printPercentileTable(label, values, fmtMs);
  console.log(`    ${bar(fraction)} ${(fraction * 100).toFixed(0)}% of instrumented time`);
  console.log();
}

// ─── Per video-length breakdown ───────────────────────────────────────────────

console.log("═══════════════════════════════════════════════════════════════════");
console.log("  BREAKDOWN BY VIDEO LENGTH");
console.log("═══════════════════════════════════════════════════════════════════\n");

const byLength = new Map<string, RunData[]>();
for (const run of runs) {
  const cat = lengthCategory(run.videoLength);
  if (!byLength.has(cat)) byLength.set(cat, []);
  byLength.get(cat)!.push(run);
}

for (const [cat, catRuns] of [...byLength.entries()].sort()) {
  const secs = catRuns.map(r => r.pipelineSec);
  const archRatios = catRuns.map(r =>
    r.quality.totalClips > 0 ? (r.quality.archiveCount / r.quality.totalClips) * 100 : 0
  );
  console.log(`  ${cat} (n=${catRuns.length})`);
  console.log(`    Render time   avg=${fmt(avg(secs))}  P50=${fmt(pct(secs, 50))}  P95=${fmt(pct(secs, 95))}`);
  console.log(`    Archive ratio avg=${avg(archRatios).toFixed(0)}%  P50=${pct(archRatios, 50).toFixed(0)}%`);
  // Top bottleneck for this length category
  const catCatStats = new Map<string, number[]>();
  for (const run of catRuns) {
    for (const [k, v] of Object.entries(run.timing.totalsByCategory)) {
      if (!catCatStats.has(k)) catCatStats.set(k, []);
      catCatStats.get(k)!.push(v);
    }
  }
  const sorted = [...catCatStats.entries()]
    .map(([k, vals]) => ({ k, avg: avg(vals) }))
    .sort((a, b) => b.avg - a.avg);
  if (sorted[0]) {
    console.log(`    Bottleneck    ${CATEGORY_LABELS[sorted[0].k] ?? sorted[0].k} (avg ${fmtMs(sorted[0].avg)})`);
  }
  console.log();
}

// ─── Source mix ───────────────────────────────────────────────────────────────

console.log("═══════════════════════════════════════════════════════════════════");
console.log("  SOURCE MIX");
console.log("═══════════════════════════════════════════════════════════════════\n");

const totalBeats: Record<string, number> = {};
let grandTotalBeats = 0;
for (const run of runs) {
  const bySource = run.quality.adoptAuditSummary?.bySource ?? run.quality.bySource ?? {};
  for (const [src, count] of Object.entries(bySource)) {
    totalBeats[src] = (totalBeats[src] ?? 0) + count;
    grandTotalBeats += count;
  }
}

const sortedSources = Object.entries(totalBeats).sort((a, b) => b[1] - a[1]);
for (const [src, count] of sortedSources) {
  const frac = grandTotalBeats > 0 ? count / grandTotalBeats : 0;
  console.log(`  ${src.padEnd(18)} ${bar(frac, 24)} ${(frac * 100).toFixed(1)}%  (${count} beats)`);
}
console.log();

// ─── Bottleneck ranking + recommendation ─────────────────────────────────────

console.log("═══════════════════════════════════════════════════════════════════");
console.log("  BOTTLENECK RANKING");
console.log("═══════════════════════════════════════════════════════════════════\n");

let rank = 1;
for (const { key, label, avgMs } of categoryStats) {
  const fraction = avgMs / totalAvgMs;
  console.log(`  ${rank}. ${label.padEnd(38)} avg ${fmtMs(avgMs).padStart(7)}  (${(fraction * 100).toFixed(0)}%)`);
  rank++;
}

console.log();
console.log("═══════════════════════════════════════════════════════════════════");
console.log("  RECOMMENDATION");
console.log("═══════════════════════════════════════════════════════════════════\n");

// Find first matching recommendation
let recommended: (typeof RECOMMENDATIONS)[0] | null = null;
for (const rec of RECOMMENDATIONS) {
  const catMs = avg(runs.map(r => r.timing.totalsByCategory[rec.category] ?? 0));
  const frac = totalAvgMs > 0 ? catMs / totalAvgMs : 0;
  if (frac >= rec.threshold) {
    recommended = rec;
    break;
  }
}

if (recommended) {
  const catMs = avg(runs.map(r => r.timing.totalsByCategory[recommended!.category] ?? 0));
  const frac = catMs / totalAvgMs;
  console.log(`  Dominant bottleneck: ${CATEGORY_LABELS[recommended.category] ?? recommended.category}`);
  console.log(`  Share of pipeline:   ${(frac * 100).toFixed(0)}% (avg ${fmtMs(catMs)})`);
  console.log();
  console.log(`  → Next optimization: ${recommended.next}`);
  console.log(`  → Estimated gain:    ${recommended.gain}`);
} else {
  console.log("  No single dominant bottleneck — pipeline is well-balanced.");
  console.log("  Consider running more videos to get statistically significant data.");
}

// Archive self-learning signal
const archHitRatio = avg(archiveRatios);
console.log();
if (archHitRatio >= 80) {
  console.log("  ✅ Archive coverage excellent (avg hit ratio " + archHitRatio.toFixed(0) + "%) — self-learning loop working.");
} else if (archHitRatio >= 50) {
  console.log("  ⚡ Archive coverage moderate (" + archHitRatio.toFixed(0) + "%) — continue ingesting external winners.");
} else {
  console.log("  ⚠️  Archive coverage low (" + archHitRatio.toFixed(0) + "%) — external retrieval still dominant.");
}

// Post-render spot check failures
const spotFails = runs.filter(r => r.quality.postRenderSpotCheck && !r.quality.postRenderSpotCheck.ok).length;
if (spotFails > 0) {
  console.log(`\n  ⚠️  ${spotFails}/${runs.length} videos had post-render spot check warnings.`);
}

console.log("\n" + "═".repeat(67) + "\n");
console.log(`  ${runs.length} video(s) analysed. Avg total render: ${fmt(avg(totalSecs))}.`);
console.log(`  Run with more videos for statistically robust results (target: 20–30).\n`);
