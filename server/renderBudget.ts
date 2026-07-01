/**
 * Dynamic render budget — compute per-render timeouts from video characteristics.
 *
 * All hardcoded time values in the pipeline should be derived from RenderBudget
 * rather than magic numbers.
 *
 * Budget tiers (total render time vs expected video length):
 *   < 3 min video  →  8 min render
 *   3–8 min video  → 12 min render
 *   8–12 min video → 18 min render
 *  12–20 min video → 25 min render
 *     > 20 min     → 30 min render
 */

export interface RenderBudget {
  // ── Inputs ──────────────────────────────────────────────────────────────
  scenesCount: number;
  beatsCount: number;
  expectedVideoSec: number;

  // ── Global hard limit ────────────────────────────────────────────────────
  /** Total render budget — watchdog kills everything when this elapses. */
  totalMs: number;

  // ── Per-stage budgets ────────────────────────────────────────────────────
  /** Per-scene compose timeout (FFmpeg montage). */
  perSceneComposeMs: number;
  /** Per-scene visual retrieval timeout (pool fetch + downloads). */
  perSceneRetrieveMs: number;
  /** Final concat timeout. */
  concatMs: number;
  /** S3/storage upload timeout. */
  uploadMs: number;
}

// ── Scaling constants ──────────────────────────────────────────────────────
// Compose gets 55% of total budget, split across all scenes.
const COMPOSE_SHARE   = 0.55;
// Retrieval gets 20% of total budget (covers fetch + downloads + re-tries).
const RETRIEVE_SHARE  = 0.20;
// Concat is relatively fast: 10% with hard caps.
const CONCAT_SHARE    = 0.10;
// Upload: 12% with hard caps (network-bound, not CPU).
const UPLOAD_SHARE    = 0.12;

const PER_SCENE_COMPOSE_MIN_MS  =  45_000;  // 45s minimum per scene
const PER_SCENE_COMPOSE_MAX_MS  = 120_000;  // 2 min maximum per scene
const PER_SCENE_RETRIEVE_MIN_MS =  20_000;  // 20s minimum per scene
const PER_SCENE_RETRIEVE_MAX_MS =  50_000;  // 50s maximum per scene
const CONCAT_MIN_MS             =  60_000;  // 1 min minimum concat
const CONCAT_MAX_MS             = 210_000;  // 3.5 min maximum concat
const UPLOAD_MIN_MS             =  60_000;  // 1 min minimum upload
const UPLOAD_MAX_MS             = 360_000;  // 6 min maximum upload (large files)

/**
 * Piecewise linear total render budget (minutes) from expected video length (minutes).
 *
 * Breakpoints:  (video_min → render_min)
 *   0  → 8
 *   3  → 8    (flat floor for short videos)
 *   8  → 12
 *   12 → 18
 *   20 → 25
 *   ∞  → 30
 */
function totalRenderMinutes(expectedVideoMin: number): number {
  if (expectedVideoMin <= 3)  return 8;
  if (expectedVideoMin <= 8)  return 8  + (expectedVideoMin - 3)  * (12 - 8)  / (8  - 3);
  if (expectedVideoMin <= 12) return 12 + (expectedVideoMin - 8)  * (18 - 12) / (12 - 8);
  if (expectedVideoMin <= 20) return 18 + (expectedVideoMin - 12) * (25 - 18) / (20 - 12);
  return 30;
}

function clampMs(value: number, min: number, max: number): number {
  return Math.round(Math.min(Math.max(value, min), max));
}

/**
 * Compute a RenderBudget from video characteristics.
 *
 * @param scenesCount   Number of scenes in the video.
 * @param beatsCount    Total number of beats across all scenes.
 * @param expectedVideoSec  Expected video length in seconds (usually total VO duration + padding).
 */
export function computeRenderBudget(
  scenesCount: number,
  beatsCount: number,
  expectedVideoSec: number
): RenderBudget {
  const scenes = Math.max(scenesCount, 1);
  const expectedVideoMin = expectedVideoSec / 60;
  const totalMin = totalRenderMinutes(expectedVideoMin);
  const totalMs = Math.round(totalMin * 60_000);

  const perSceneComposeMs = clampMs(
    (totalMs * COMPOSE_SHARE) / scenes,
    PER_SCENE_COMPOSE_MIN_MS,
    PER_SCENE_COMPOSE_MAX_MS
  );
  const perSceneRetrieveMs = clampMs(
    (totalMs * RETRIEVE_SHARE) / scenes,
    PER_SCENE_RETRIEVE_MIN_MS,
    PER_SCENE_RETRIEVE_MAX_MS
  );
  const concatMs = clampMs(totalMs * CONCAT_SHARE, CONCAT_MIN_MS, CONCAT_MAX_MS);
  const uploadMs = clampMs(totalMs * UPLOAD_SHARE, UPLOAD_MIN_MS, UPLOAD_MAX_MS);

  return {
    scenesCount: scenes,
    beatsCount,
    expectedVideoSec,
    totalMs,
    perSceneComposeMs,
    perSceneRetrieveMs,
    concatMs,
    uploadMs,
  };
}

/** Format seconds as "Xm Ys" for log readability. */
function fmtSec(ms: number): string {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

/** Emit a structured budget log line. */
export function logRenderBudget(budget: RenderBudget, videoId: number | string): void {
  const lines = [
    `[RenderBudget] video=${videoId}`,
    `  expectedVideo=${fmtSec(budget.expectedVideoSec * 1000)}`,
    `  scenes=${budget.scenesCount}  beats=${budget.beatsCount}`,
    `  renderBudget=${fmtSec(budget.totalMs)}`,
    `  sceneBudget=${fmtSec(budget.perSceneComposeMs)}/compose  ${fmtSec(budget.perSceneRetrieveMs)}/retrieve`,
    `  concatBudget=${fmtSec(budget.concatMs)}`,
    `  uploadBudget=${fmtSec(budget.uploadMs)}`,
  ];
  console.log(lines.join("\n"));
}
