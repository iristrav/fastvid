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
 * All stage percentages are of totalMs:
 *   compose pool   55%  (split across scenes, adjusted for clip complexity)
 *   retrieval pool 20%  (split across scenes)
 *   concat         10%  (60 s – 210 s)
 *   upload         12%  (60 s – 360 s)
 *   TTS            25%  (30 s – 600 s, also bounded by scene count)
 *   music mix       8%  (45 s – 180 s)
 */

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

/** Per-beat search floor/ceiling (used by beatVisualSearchMaxMs replacement). */
export const BEAT_SEARCH_MIN_MS    =  10_000;
export const BEAT_SEARCH_MAX_MS    =  40_000;
/** Per-beat fallback floor/ceiling (used by beatStockFallbackWallMs replacement). */
export const BEAT_FALLBACK_MIN_MS  =   5_000;
export const BEAT_FALLBACK_MAX_MS  =  25_000;

export interface RenderBudget {
  // ── Inputs ──────────────────────────────────────────────────────────────
  scenesCount: number;
  expectedVideoSec: number;

  // ── Global hard limit ────────────────────────────────────────────────────
  /** Total render budget — watchdog kills everything when this elapses. */
  totalMs: number;

  // ── Per-stage pool totals ────────────────────────────────────────────────
  /** Base per-scene compose budget (before clip-count adjustment). */
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
  /** Per-beat visual search budget (replaces beatVisualSearchMaxMs). */
  perBeatSearchMs: number;
  /** Per-beat stock fallback budget (replaces beatStockFallbackWallMs). */
  perBeatFallbackMs: number;
}

// ── Core formula ─────────────────────────────────────────────────────────────

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * Math.min(Math.max(t, 0), 1);
}

/**
 * Piecewise render budget in minutes from expected video length in minutes.
 *
 * Smooth linear interpolation within each tier, then auto-scale beyond 15 min
 * with a hard ceiling of 40 min.
 */
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
 * Compute a full RenderBudget from actual scene durations (call after TTS).
 *
 * @param scenesCount     Number of scenes (chapter cards included).
 * @param expectedVideoSec  Sum of scenes[i].duration after VO sync — real audio length.
 */
export function computeRenderBudget(
  scenesCount: number,
  expectedVideoSec: number
): RenderBudget {
  const scenes = Math.max(scenesCount, 1);
  const videoMin = expectedVideoSec / 60;
  const totalMin = totalRenderMinutes(videoMin);
  const totalMs = Math.round(totalMin * 60_000);

  // Compose: 55% of total, divided evenly as BASE (complexity is added per scene at runtime)
  const basePerSceneComposeMs = clampMs(
    (totalMs * 0.55) / scenes,
    PER_SCENE_COMPOSE_MIN_MS,
    PER_SCENE_COMPOSE_MAX_MS
  );

  // Retrieval: 20% of total, divided by scenes
  const perSceneRetrieveMs = clampMs(
    (totalMs * 0.20) / scenes,
    PER_SCENE_RETRIEVE_MIN_MS,
    PER_SCENE_RETRIEVE_MAX_MS
  );

  // Per-beat search: 30% of per-scene retrieval budget (one search per beat)
  const perBeatSearchMs = clampMs(
    perSceneRetrieveMs * 0.30,
    BEAT_SEARCH_MIN_MS,
    BEAT_SEARCH_MAX_MS
  );

  // Per-beat fallback: 20% of per-scene retrieval budget
  const perBeatFallbackMs = clampMs(
    perSceneRetrieveMs * 0.20,
    BEAT_FALLBACK_MIN_MS,
    BEAT_FALLBACK_MAX_MS
  );

  const concatMs    = clampMs(totalMs * 0.10, CONCAT_MIN_MS,     CONCAT_MAX_MS);
  const uploadMs    = clampMs(totalMs * 0.12, UPLOAD_MIN_MS,     UPLOAD_MAX_MS);
  const ttsMs       = clampMs(totalMs * 0.25, TTS_MIN_MS,        TTS_MAX_MS);
  const musicMixMs  = clampMs(totalMs * 0.08, MUSIC_MIX_MIN_MS,  MUSIC_MIX_MAX_MS);

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
  };
}

// ── Logging ───────────────────────────────────────────────────────────────────

function fmtSec(ms: number): string {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

export function logRenderBudget(budget: RenderBudget, videoId: number | string): void {
  console.log(
    [
      `[RenderBudget] video=${videoId}`,
      `  expectedVideo=${fmtSec(budget.expectedVideoSec * 1000)}  scenes=${budget.scenesCount}`,
      `  renderBudget=${fmtSec(budget.totalMs)}`,
      `  sceneBudget=${fmtSec(budget.basePerSceneComposeMs)}/compose (base+clips)  ${fmtSec(budget.perSceneRetrieveMs)}/retrieve`,
      `  beatBudget=${fmtSec(budget.perBeatSearchMs)}/search  ${fmtSec(budget.perBeatFallbackMs)}/fallback`,
      `  concatBudget=${fmtSec(budget.concatMs)}  uploadBudget=${fmtSec(budget.uploadMs)}`,
      `  ttsBudget=${fmtSec(budget.ttsMs)}  musicBudget=${fmtSec(budget.musicMixMs)}`,
    ].join("\n")
  );
}
