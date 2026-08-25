/**
 * Dynamic render budget — all pipeline timeouts derived from video characteristics.
 *
 * After Stage 2 (TTS) real scene durations are known. computeRenderBudget() is
 * called then and the result is stored in _activeRenderBudget (videoPipeline.ts)
 * so every timeout function can read from it without extra parameters.
 *
 * Budget tiers — total render time vs expected video length (RONDE 81: linear above 3 min,
 * so a scene's own budget does not shrink as the video gets longer — see totalRenderMinutes):
 *   ≤ 3 min  →  8 min render
 *   9 min    → 44 min render
 *  12.5 min  → 65 min render
 *  17.5 min  → 95 min render
 *
 * That formula alone is NOT the watchdog's actual kill budget: the watchdog (renderWatchdog.ts)
 * must never use a tighter total budget than the pipeline's own central wall-clock policy
 * (sourcingPolicy.ts's maxPipelineWallClockHardMin — the same ceiling the router race and the
 * DB stall detector already use, up to 260 min for the longest video-length bucket). The
 * returned RenderBudget.totalMs is therefore max(formula, maxPipelineWallClockHardMin) whenever
 * the wall-clock limit is enabled at all — see computeRenderBudget()'s videoLength parameter.
 * The per-stage pools below (compose/retrieve/concat/upload/tts/music) are unaffected: they're
 * still derived from the formula's own totalMin and stay within their existing floor/ceiling
 * clamps regardless of this watchdog-only floor.
 *
 * Stage percentages of totalMs:
 *   compose pool   55%  (split across scenes, complexity-adjusted at runtime)
 *   retrieval pool 20%  (split across scenes)
 *   concat         10%  (60 s – max(210 s, 400 ms per video-second))
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
import { pipelineWallClockLimitEnabled, PIPELINE_UNLIMITED_MS, maxPipelineWallClockHardMin } from "./sourcingPolicy";

// ── Absolute floor/ceiling for each budget slot ──────────────────────────────
const PER_SCENE_COMPOSE_MIN_MS  =  45_000;
const PER_SCENE_COMPOSE_MAX_MS  = 180_000;
const PER_SCENE_RETRIEVE_MIN_MS =  20_000;
const PER_SCENE_RETRIEVE_MAX_MS =  55_000;
const CONCAT_MIN_MS             =  60_000;
/**
 * RONDE 81: the final concat RE-ENCODES the whole video (libx264, veryfast). The work is
 * therefore proportional to the video's own length, and a flat 210s ceiling meant a 17.5-minute
 * video got the same concat budget as a 3-minute one — 210s to encode 1050s of 1080p on a
 * 4-vCPU host. The floor and the shape are unchanged; the ceiling now grows with the material,
 * allowing 400 ms of budget per second of video — i.e. the encode has to sustain 2.5x realtime,
 * which veryfast comfortably does. Never below the original 210s, so no shorter video loses
 * budget it has today.
 */
const CONCAT_MAX_BASE_MS        = 210_000;
const CONCAT_MS_PER_VIDEO_SEC   =     400;
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

/**
 * Render minutes allowed for a video of `videoMin` minutes.
 *
 * RONDE 81 — this curve was the root cause of the long-video failures.
 *
 * It used to flatten out and then stop at 40 minutes for ANY length:
 *
 *     1 min -> 8      9 min -> 16.5     12.5 min -> 21.5     17.5 min -> 28.75
 *
 * Every per-stage budget below is a percentage of this number DIVIDED BY the scene
 * count, and the scene count grows linearly with length (3/18/25/35). A sublinear
 * total over a linear divisor is a per-scene budget that shrinks the longer the video
 * gets — measured at 88s of compose per scene for a 1-minute video and 45s for every
 * longer one, which is the PER_SCENE_COMPOSE_MIN_MS floor. The formula had saturated:
 * 8-10, 10-15 and 15-20 all got byte-identical per-scene budgets.
 *
 * A scene is a scene. It carries the same beats, the same montage encode and the same
 * audit whether it is the third of three or the thirty-fifth of thirty-five, so its
 * budget must not depend on how many siblings it has. The curve is therefore linear
 * above the short-video range, at a rate chosen so the per-scene compose budget lands
 * at ~80-90s for every length — the value the 1-minute path already proves is enough.
 *
 *     1 min -> 8      9 min -> 44       12.5 min -> 65       17.5 min -> 95
 *
 * Still far inside maxPipelineWallClockHardMin (22/130/195/260 min), which remains the
 * ultimate ceiling and is applied to totalMs at the bottom of computeRenderBudget.
 * The <= 3 min branch is untouched, so 1-minute renders keep the exact budget they have
 * today.
 */
const RENDER_MINUTES_PER_VIDEO_MINUTE = 6;

function totalRenderMinutes(videoMin: number): number {
  if (videoMin <= 3) return 8;
  return 8 + (videoMin - 3) * RENDER_MINUTES_PER_VIDEO_MINUTE;
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
 * @param videoLength     Video-length bucket ("1" | "8-10" | "10-15" | "15-20" | ...). Used only
 *   to floor the returned totalMs (watchdog kill budget) against the pipeline's central
 *   wall-clock policy — omitting it just disables that floor (falls back to the formula alone).
 */
export function computeRenderBudget(
  scenesCount: number,
  expectedVideoSec: number,
  videoLength?: string | null
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
  const concatMaxMs        = Math.max(CONCAT_MAX_BASE_MS, Math.round(expectedVideoSec * CONCAT_MS_PER_VIDEO_SEC));
  const formulaConcatMs    = clampMs(totalMs * 0.10, CONCAT_MIN_MS,     concatMaxMs);
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

  // The render watchdog SIGKILLs every child process and rejects the whole render when
  // totalMs elapses — that's exactly the kind of hard time cutoff PIPELINE_WALL_CLOCK_LIMIT=false
  // is meant to disable. Per-stage budgets (compose/retrieve/concat/upload) stay as computed
  // above so a genuinely stuck single step is still caught; only the render-wide kill is lifted.
  //
  // Floor against the pipeline's central wall-clock policy: this formula's own totalMs was
  // tuned assuming videos topped out around ~10 min (hard ceiling 40 min for ANY length), while
  // sourcingPolicy.ts's maxPipelineWallClockHardMin allows up to 260 min for the longest bucket
  // and is what the router race + DB stall detector already honor. Without this floor, the
  // watchdog could SIGKILL a long render that every other budget layer still considers healthy.
  const centralHardMs = maxPipelineWallClockHardMin(videoLength) * 60_000;
  const watchdogTotalMs = pipelineWallClockLimitEnabled()
    ? Math.max(totalMs, centralHardMs)
    : PIPELINE_UNLIMITED_MS;

  return {
    scenesCount: scenes,
    expectedVideoSec,
    totalMs: watchdogTotalMs,
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
