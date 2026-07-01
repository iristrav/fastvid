/**
 * Dynamic render budget — all pipeline timeouts derived from video characteristics.
 *
 * After Stage 2 (TTS) real scene durations are known. computeRenderBudget() is
 * called then and the result is stored in _activeRenderBudget (videoPipeline.ts)
 * so every timeout function can read from it without extra parameters.
 *
 * Budget tiers — total render time vs expected video length:
 *   < 3 min  →  8 min render
 *   3–6 min  → 12 min render
 *   6–10 min → 18 min render
 *  10–15 min → 25 min render
 *     > 15 min → auto-scale, hard ceiling 40 min
 *
 * Stage percentages of totalMs:
 *   compose pool   55%  (split across scenes, complexity-adjusted at runtime)
 *   retrieval pool 20%  (split across scenes)
 *   concat         10%  (60 s – 210 s)
 *   upload         12%  (60 s – 360 s)
 *   TTS            25%  (30 s – 600 s)
 *   music mix       8%  (45 s – 180 s)
 *
 * Historical adjustment:
 *   After ≥ 3 renders in the same tier with stable timings (CV < 0.35),
 *   computeRenderBudget() blends the formula result with the worker-lifetime
 *   average so predictions improve over the worker's uptime.
 */

import { getBudgetTier, getHistoricalAvgs } from "./renderBudgetTracker";

// ── Absolute floor/ceiling for each budget slot ──────────────────────────────
const PER_SCENE_COMPOSE_MIN_MS  =  45_000;
const PER_SCENE_COMPOSE_MAX_MS  = 180_000;
const PER_SCENE_RETRIEVE_MIN_MS =  20_000;
const PER_SCENE_RETRIEVE_MAX_MS =  55_000;
const CONCAT_MIN_MS             =  60_000;
const CONCAT_MAX_MS             = 210_000;
const UPLOAD_MIN_MS             =  60_000;
const UPLOAD_MAX_MS             = 360_000;
const TTS_MIN_MS                =  30_000;
const TTS_MAX_MS                = 600_000;
const MUSIC_MIX_MIN_MS          =  45_000;
const MUSIC_MIX_MAX_MS          = 180_000;

/** Per-beat search floor/ceiling (read by beatVisualSearchMaxMs in videoPipeline.ts). */
export const BEAT_SEARCH_MIN_MS   =  10_000;
export const BEAT_SEARCH_MAX_MS   =  40_000;
/** Per-beat fallback floor/ceiling (read by beatStockFallbackWallMs). */
export const BEAT_FALLBACK_MIN_MS =   5_000;
export const BEAT_FALLBACK_MAX_MS =  25_000;

// ── Safety factor applied when blending historical averages ─────────────────
// We never set budget to the raw average — always add at least 25% headroom.
const HISTORICAL_SAFETY_FACTOR = 1.25;

export type BudgetConfidence = "HIGH" | "MEDIUM" | "LOW";

export interface RenderBudget {
  // ── Inputs ──────────────────────────────────────────────────────────────
  scenesCount: number;
  expectedVideoSec: number;

  // ── Global hard limit ────────────────────────────────────────────────────
  /** Total render budget — watchdog kills everything when this elapses. */
  totalMs: number;

  // ── Per-stage pool totals ────────────────────────────────────────────────
  /** Base per-scene compose budget (adjusted for clip count at runtime). */
  basePerSceneComposeMs: number;
  /** Per-scene retrieval budget. */
  perSceneRetrieveMs: number;
  /** Final concat budget. */
  concatMs: number;
  /** Storage upload budget. */
  uploadMs: number;
  /** Bulk TTS generation budget. */
  ttsMs: number;
  /** Background music mixing budget. */
  musicMixMs: number;

  // ── Per-beat budgets ─────────────────────────────────────────────────────
  /** Per-beat visual search budget. */
  perBeatSearchMs: number;
  /** Per-beat stock fallback budget. */
  perBeatFallbackMs: number;

  // ── Observability ────────────────────────────────────────────────────────
  /** Confidence in the prediction. HIGH = formula + history agree. */
  confidence: BudgetConfidence;
  /** Human-readable reasons for the confidence level. */
  confidenceReasons: string[];
  /** True if worker-lifetime averages were used to adjust this budget. */
  historicallyAdjusted: boolean;
}

// ── Core formula ─────────────────────────────────────────────────────────────

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * Math.min(Math.max(t, 0), 1);
}

function totalRenderMinutes(videoMin: number): number {
  if (videoMin <= 3)  return 8;
  if (videoMin <= 6)  return lerp(8,  12, (videoMin - 3)  / 3);
  if (videoMin <= 10) return lerp(12, 18, (videoMin - 6)  / 4);
  if (videoMin <= 15) return lerp(18, 25, (videoMin - 10) / 5);
  return Math.min(25 + (videoMin - 15) * 1.5, 40);
}

function clampMs(value: number, min: number, max: number): number {
  return Math.round(Math.min(Math.max(value, min), max));
}

/**
 * Blend formula estimate with historical average using safety factor.
 * Never goes below the formula value (we only tighten when history is very reliable).
 */
function blendWithHistory(formulaMs: number, histAvg: number | null, reliable: boolean): number {
  if (!reliable || histAvg == null) return formulaMs;
  const historicalWithSafety = Math.round(histAvg * HISTORICAL_SAFETY_FACTOR);
  // Use the blend only if it's within ±40% of the formula (sanity check)
  const ratio = historicalWithSafety / formulaMs;
  if (ratio < 0.6 || ratio > 1.4) return formulaMs;
  // Weight: 70% formula, 30% history (conservative blend)
  return Math.round(formulaMs * 0.7 + historicalWithSafety * 0.3);
}

/**
 * Compute a full RenderBudget from actual scene durations (call after TTS).
 * Automatically blends with worker-lifetime averages when enough samples exist.
 *
 * @param scenesCount     Number of scenes (chapter cards included).
 * @param expectedVideoSec  Sum of scenes[i].duration after VO sync.
 */
export function computeRenderBudget(
  scenesCount: number,
  expectedVideoSec: number
): RenderBudget {
  const scenes   = Math.max(scenesCount, 1);
  const videoMin = expectedVideoSec / 60;
  const totalMin = totalRenderMinutes(videoMin);
  const totalMs  = Math.round(totalMin * 60_000);
  const tier     = getBudgetTier(expectedVideoSec);
  const hist     = getHistoricalAvgs(tier);

  // ── Base formula allocations ─────────────────────────────────────────────
  const formulaComposeMs   = clampMs((totalMs * 0.55) / scenes, PER_SCENE_COMPOSE_MIN_MS,  PER_SCENE_COMPOSE_MAX_MS);
  const formulaRetrieveMs  = clampMs((totalMs * 0.20) / scenes, PER_SCENE_RETRIEVE_MIN_MS, PER_SCENE_RETRIEVE_MAX_MS);
  const formulaConcatMs    = clampMs(totalMs * 0.10, CONCAT_MIN_MS,     CONCAT_MAX_MS);
  const formulaUploadMs    = clampMs(totalMs * 0.12, UPLOAD_MIN_MS,     UPLOAD_MAX_MS);
  const formulaTtsMs       = clampMs(totalMs * 0.25, TTS_MIN_MS,        TTS_MAX_MS);
  const formulaMusicMixMs  = clampMs(totalMs * 0.08, MUSIC_MIX_MIN_MS,  MUSIC_MIX_MAX_MS);

  // ── Historical blend ────────────────────────────────────────────────────
  const useHistory = hist.reliable;
  const basePerSceneComposeMs = blendWithHistory(formulaComposeMs,  hist.perSceneComposeMs,  useHistory);
  const perSceneRetrieveMs    = blendWithHistory(formulaRetrieveMs, hist.perSceneRetrieveMs, useHistory);
  const concatMs    = blendWithHistory(formulaConcatMs,   hist.concatMs,   useHistory);
  const uploadMs    = blendWithHistory(formulaUploadMs,   hist.uploadMs,   useHistory);
  const ttsMs       = blendWithHistory(formulaTtsMs,      hist.ttsMs,      useHistory);
  const musicMixMs  = formulaMusicMixMs; // music mix is fast enough; no blend needed

  // ── Per-beat sub-budgets ─────────────────────────────────────────────────
  const perBeatSearchMs   = clampMs(perSceneRetrieveMs * 0.30, BEAT_SEARCH_MIN_MS,   BEAT_SEARCH_MAX_MS);
  const perBeatFallbackMs = clampMs(perSceneRetrieveMs * 0.20, BEAT_FALLBACK_MIN_MS, BEAT_FALLBACK_MAX_MS);

  // ── Confidence scoring ───────────────────────────────────────────────────
  const confidenceReasons: string[] = [];
  let confidence: BudgetConfidence;

  if (useHistory && hist.sampleCount >= 5) {
    confidence = "HIGH";
    confidenceReasons.push(`historical_samples=${hist.sampleCount} (reliable)`);
  } else if (useHistory && hist.sampleCount >= 3) {
    confidence = "MEDIUM";
    confidenceReasons.push(`historical_samples=${hist.sampleCount} (stabilising)`);
  } else if (videoMin <= 3) {
    confidence = "HIGH";
    confidenceReasons.push("short_video: formula very reliable");
  } else if (videoMin <= 10) {
    confidence = "MEDIUM";
    confidenceReasons.push("medium_video: formula reliable, no history yet");
  } else {
    confidence = "LOW";
    confidenceReasons.push(`long_video (${videoMin.toFixed(1)}min): high variance, no history`);
  }

  if (scenes > 20) {
    if (confidence === "HIGH") confidence = "MEDIUM";
    confidenceReasons.push(`many_scenes=${scenes}: compose variance increases`);
  }

  return {
    scenesCount: scenes,
    expectedVideoSec,
    totalMs,
    basePerSceneComposeMs,
    perSceneRetrieveMs,
    concatMs,
    uploadMs,
    ttsMs,
    musicMixMs,
    perBeatSearchMs,
    perBeatFallbackMs,
    confidence,
    confidenceReasons,
    historicallyAdjusted: useHistory,
  };
}

// ── Logging ───────────────────────────────────────────────────────────────────

function fmtSec(ms: number): string {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

export function logRenderBudget(budget: RenderBudget, videoId: number | string): void {
  const histNote = budget.historicallyAdjusted ? " [history-blended]" : "";
  console.log(
    [
      `[RenderBudget] video=${videoId}${histNote}`,
      `  expectedVideo=${fmtSec(budget.expectedVideoSec * 1000)}  scenes=${budget.scenesCount}`,
      `  renderBudget=${fmtSec(budget.totalMs)}  confidence=${budget.confidence}`,
      `  reasons: ${budget.confidenceReasons.join(", ")}`,
      `  sceneBudget=${fmtSec(budget.basePerSceneComposeMs)}/compose  ${fmtSec(budget.perSceneRetrieveMs)}/retrieve`,
      `  beatBudget=${fmtSec(budget.perBeatSearchMs)}/search  ${fmtSec(budget.perBeatFallbackMs)}/fallback`,
      `  concatBudget=${fmtSec(budget.concatMs)}  uploadBudget=${fmtSec(budget.uploadMs)}`,
      `  ttsBudget=${fmtSec(budget.ttsMs)}  musicBudget=${fmtSec(budget.musicMixMs)}`,
    ].join("\n")
  );
}
