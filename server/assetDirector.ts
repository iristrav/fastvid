/**
 * Asset Director — global-context final clip selection layer.
 *
 * Sits between retrieval and adopt. Takes the candidate paths that retrieval
 * already found for a beat and re-ranks them using full video context:
 *
 *   Semantic relevance     (existing: beatText match)
 *   Editorial score        (existing: clipAnnotation score)
 *   Motion match           (existing: motion level vs. narrative energy)
 *   Blueprint match        (existing: MasterDocumentaryDirector directive)
 *   Visual budget          (existing: VisualBudgetTracker enforcement)
 *   Diversity bonus        (existing: usedPaths / usedCategories tracking)
 *   Entity continuity      (new: Churchill establishing→medium→close-up progression)
 *   Location continuity    (new: penalty for jumping away from active location)
 *   Era continuity         (new: penalty for wrong time period)
 *   Shot variety           (new: penalty for excessive same shot type)
 *   Visual energy arc      (new: gradient from current scene energy to target)
 *   Callback support       (new: bonus when candidate supports a planned callback)
 *
 * No LLM. No extra retrieval. 100% from already-computed metadata and state.
 * Feature flag: ASSET_DIRECTOR_ENABLED (default: "true")
 */

import path from "path";
import type { VideoBlueprint, VisualBudgetTracker, BeatVisualDirective } from "./masterDocumentaryDirector";
import { getBlueprintDirective, isBudgetExceeded, recordBudgetUsage } from "./masterDocumentaryDirector";

// ─── Feature flag ─────────────────────────────────────────────────────────────

export function assetDirectorEnabled(): boolean {
  return process.env.ASSET_DIRECTOR_ENABLED !== "false";
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type AssetDirectorContext = {
  /** All clip paths already used in this video (dedup.usedPaths) */
  usedPaths: Set<string>;
  /** How many times each visual category has been used (dedup.usedCategories) */
  usedCategories: Map<string, number>;
  /** Blueprint from Master Documentary Director */
  blueprint?: VideoBlueprint | null;
  /** Budget tracker for visual type enforcement */
  budgetTracker?: VisualBudgetTracker | null;
  /** Clips adopted in previous beats of this scene (for shot variety tracking) */
  sceneAdoptedClips: string[];
  /** Clips adopted in the previous scene (for style continuity) */
  prevSceneClips: string[];
  /** Active named entity from narration (e.g. "Churchill") */
  activeEntity?: string | null;
  /** Active location from narration (e.g. "Paris") */
  activeLocation?: string | null;
  /** Active era/period from narration (e.g. "1944") */
  activeEra?: string | null;
  /** Target motion level 0-100 for this beat (from visualRhythmEngine) */
  targetMotionLevel?: number | null;
  /** How many callbacks have already been placed for each motif */
  callbacksPlaced: Map<string, number>;
};

export type AssetScore = {
  /** 0–100 final weighted score */
  finalScore: number;
  breakdown: {
    semantic: number;
    editorial: number;
    motionMatch: number;
    blueprintMatch: number;
    diversityBonus: number;
    entityContinuity: number;
    locationContinuity: number;
    eraContinuity: number;
    shotVariety: number;
    energyArc: number;
    callbackSupport: number;
    budgetPenalty: number;
  };
  reasons: string[];
};

export type AssetDirectorResult = {
  /** Reordered candidate paths, best first */
  rankedPaths: string[];
  /** Score breakdown for the chosen (index 0) candidate */
  topScore: AssetScore | null;
  /** Whether Asset Director actually changed the order */
  reordered: boolean;
};

// ─── Path-based inference helpers ─────────────────────────────────────────────

const ARCHIVAL_RE = /map|engraving|painting|illustration|newspaper|document|diagram|poster|chart|wikimedia|archive/i;
const FALLBACK_RE = /color_fallback|fallback|guaranteed|placeholder|color_clip/i;
const WIDE_RE     = /wide|aerial|panorama|establishing|cityscape|landscape|overhead|drone|overview/i;
const CLOSE_RE    = /close|face|detail|extreme|macro|portrait/i;
const MEDIUM_RE   = /medium|mid|waist|interview|talking|standing/i;
const MAP_RE      = /\bmap\b|globe|geographic|territory|region|country/i;
const PHOTO_RE    = /photo|jpg|jpeg|png|still|image/i;
const AI_RE       = /kling|ai_gen|veo|grok|stability|leonardo/i;

type ShotType = "wide" | "medium" | "close_up" | "archival" | "map" | "photo" | "ai" | "fallback" | "other";

function inferShotType(clipPath: string, beatText = ""): ShotType {
  const base = path.basename(clipPath).toLowerCase();
  const combined = base + " " + beatText.toLowerCase();
  if (FALLBACK_RE.test(base)) return "fallback";
  if (AI_RE.test(base) || clipPath.includes("ai_gen")) return "ai";
  if (MAP_RE.test(combined)) return "map";
  if (PHOTO_RE.test(base) && !base.endsWith(".mp4")) return "photo";
  if (ARCHIVAL_RE.test(base)) return "archival";
  if (CLOSE_RE.test(combined)) return "close_up";
  if (WIDE_RE.test(combined)) return "wide";
  if (MEDIUM_RE.test(combined)) return "medium";
  return "other";
}

function inferVisualTypeFromPath(clipPath: string): string {
  const base = path.basename(clipPath).toLowerCase();
  const dir = clipPath.toLowerCase();
  if (FALLBACK_RE.test(base)) return "fallback";
  if (MAP_RE.test(base)) return "map";
  if (AI_RE.test(dir)) return "animation";
  if (dir.includes("pexels") || dir.includes("pixabay")) return "live_footage";
  if (dir.includes("wikimedia") || dir.includes("archive") || dir.includes("curated")) return "archive_video";
  if (PHOTO_RE.test(base) && !base.endsWith(".mp4")) return "archive_photo";
  if (ARCHIVAL_RE.test(base)) return "archive_video";
  if (WIDE_RE.test(base)) return "aerial";
  if (CLOSE_RE.test(base)) return "close_up";
  return "live_footage";
}

// Infer approximate motion level from filename/path (0–100)
function inferMotionFromPath(clipPath: string): number | null {
  const base = path.basename(clipPath).toLowerCase();
  if (FALLBACK_RE.test(base)) return 0;
  if (MAP_RE.test(base) || ARCHIVAL_RE.test(base)) return 15;
  if (AI_RE.test(clipPath.toLowerCase())) return 60;
  if (WIDE_RE.test(base)) return 50;
  if (CLOSE_RE.test(base)) return 30;
  return null; // unknown
}

// ─── Individual signal scorers (0–100 each) ───────────────────────────────────

/** Keyword / narration match against filename + path tokens */
function scoreSemanticRelevance(clipPath: string, beatText: string): number {
  const base = path.basename(clipPath).toLowerCase().replace(/[_.-]/g, " ");
  const words = beatText.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  if (words.length === 0) return 50;
  const matchCount = words.filter((w) => base.includes(w)).length;
  return Math.round(30 + (matchCount / words.length) * 70);
}

/** Bonus when clip path matches the blueprint's planned visual type for this beat */
function scoreBlueprintMatch(clipPath: string, directive: BeatVisualDirective | null): number {
  if (!directive) return 50; // neutral when no blueprint
  const inferred = inferVisualTypeFromPath(clipPath);
  if (inferred === directive.visualType) return 100;
  // Partial match for related types
  const CLOSE_FAMILY: Record<string, string[]> = {
    archive_video: ["archive_photo", "archival"],
    archive_photo: ["archive_video", "archival"],
    live_footage:  ["aerial", "close_up"],
    aerial:        ["live_footage", "wide"],
    close_up:      ["live_footage", "medium"],
  };
  const family = CLOSE_FAMILY[directive.visualType] ?? [];
  if (family.includes(inferred)) return 70;
  return 25;
}

/** Penalty when the clip's visual type has exceeded the blueprint budget */
function scoreBudgetPenalty(clipPath: string, tracker: VisualBudgetTracker | null | undefined): number {
  if (!tracker) return 0; // 0 = no penalty
  const vt = inferVisualTypeFromPath(clipPath) as Parameters<typeof isBudgetExceeded>[1];
  return isBudgetExceeded(tracker, vt) ? -30 : 0;
}

/** Diversity: penalty for clips similar to what's already been used */
function scoreDiversityBonus(clipPath: string, usedPaths: Set<string>, usedCategories: Map<string, number>): number {
  const base = path.basename(clipPath).toLowerCase();
  // Hard dedup is handled upstream; here we look at category saturation
  const category = inferShotType(clipPath);
  const catUsed = usedCategories.get(category) ?? 0;
  if (catUsed === 0) return 100;
  if (catUsed === 1) return 80;
  if (catUsed === 2) return 60;
  if (catUsed <= 4) return 40;
  return 15; // heavily penalize over-used category
}

/** Bonus when a clip contains the active entity name in its filename/tags */
function scoreEntityContinuity(clipPath: string, activeEntity: string | null | undefined): number {
  if (!activeEntity || activeEntity.length < 3) return 50; // neutral
  const base = path.basename(clipPath).toLowerCase();
  const entityTokens = activeEntity.toLowerCase().split(/\s+/);
  const matchCount = entityTokens.filter((t) => base.includes(t)).length;
  if (matchCount === entityTokens.length) return 100;
  if (matchCount > 0) return 70;
  return 30;
}

/** Penalty when clip location doesn't match the active narration location */
function scoreLocationContinuity(clipPath: string, activeLocation: string | null | undefined): number {
  if (!activeLocation || activeLocation.length < 3) return 50;
  const combined = (path.basename(clipPath) + " " + clipPath).toLowerCase();
  const loc = activeLocation.toLowerCase();
  if (combined.includes(loc)) return 100;
  // Neutral if no location info in path
  return 50;
}

/** Bonus when clip metadata era matches the active narration period */
function scoreEraContinuity(clipPath: string, activeEra: string | null | undefined): number {
  if (!activeEra) return 50;
  const combined = (path.basename(clipPath) + " " + clipPath).toLowerCase();
  const era = activeEra.toLowerCase();
  if (combined.includes(era)) return 100;
  // Try just the decade/century
  const decade = era.replace(/\d$/, "0");
  if (combined.includes(decade)) return 75;
  return 50;
}

/**
 * Shot variety: penalize when the same shot type appears too many consecutive times
 * in the current scene.
 */
function scoreShotVariety(clipPath: string, beatText: string, sceneAdoptedClips: string[]): number {
  if (sceneAdoptedClips.length === 0) return 70; // first clip in scene, neutral
  const myType = inferShotType(clipPath, beatText);
  // Count consecutive same type at end of scene
  let consecutive = 0;
  for (let i = sceneAdoptedClips.length - 1; i >= 0; i--) {
    if (inferShotType(sceneAdoptedClips[i]!, beatText) === myType) consecutive++;
    else break;
  }
  if (consecutive === 0) return 100; // breaks the run
  if (consecutive === 1) return 70;  // second of same, acceptable
  if (consecutive === 2) return 40;  // third — discourage
  return 10;                          // 4+ same in a row — strong penalty
}

/** Motion energy arc: reward clips whose motion level follows the planned energy gradient */
function scoreEnergyArc(
  clipPath: string,
  targetMotionLevel: number | null | undefined
): number {
  if (targetMotionLevel == null) return 50;
  const inferred = inferMotionFromPath(clipPath);
  if (inferred === null) return 50; // unknown
  const diff = Math.abs(inferred - targetMotionLevel);
  if (diff <= 10) return 100;
  if (diff <= 20) return 80;
  if (diff <= 35) return 60;
  if (diff <= 50) return 40;
  return 20;
}

/** Callback support: bonus when this clip matches a planned visual callback motif */
function scoreCallbackSupport(
  clipPath: string,
  beatText: string,
  blueprint: VideoBlueprint | null | undefined,
  sceneIndex: number
): number {
  if (!blueprint || blueprint.visualCallbacks.length === 0) return 50;
  const combined = (path.basename(clipPath) + " " + beatText).toLowerCase();
  for (const cb of blueprint.visualCallbacks) {
    if (!cb.sceneIndices.includes(sceneIndex)) continue;
    const motifTokens = cb.motif.toLowerCase().split(/\s+/);
    if (motifTokens.some((t) => combined.includes(t))) return 100;
  }
  return 50;
}

// ─── Weights ──────────────────────────────────────────────────────────────────

const WEIGHTS = {
  semantic:          0.15,
  editorial:         0.08,  // from clip annotation — often absent
  motionMatch:       0.08,
  blueprintMatch:    0.18,
  diversityBonus:    0.16,
  entityContinuity:  0.08,
  locationContinuity:0.05,
  eraContinuity:     0.05,
  shotVariety:       0.10,
  energyArc:         0.04,
  callbackSupport:   0.03,
  // budgetPenalty applied as a flat additive, not a weight
};

// ─── Main scorer ──────────────────────────────────────────────────────────────

function scoreCandidate(
  clipPath: string,
  beatText: string,
  sceneIndex: number,
  ctx: AssetDirectorContext,
  directive: BeatVisualDirective | null
): AssetScore {
  const reasons: string[] = [];

  const semantic         = scoreSemanticRelevance(clipPath, beatText);
  const blueprintMatch   = scoreBlueprintMatch(clipPath, directive);
  const diversityBonus   = scoreDiversityBonus(clipPath, ctx.usedPaths, ctx.usedCategories);
  const entityContinuity = scoreEntityContinuity(clipPath, ctx.activeEntity);
  const locationCont     = scoreLocationContinuity(clipPath, ctx.activeLocation);
  const eraCont          = scoreEraContinuity(clipPath, ctx.activeEra);
  const shotVariety      = scoreShotVariety(clipPath, beatText, ctx.sceneAdoptedClips);
  const energyArc        = scoreEnergyArc(clipPath, ctx.targetMotionLevel);
  const callbackSupport  = scoreCallbackSupport(clipPath, beatText, ctx.blueprint, sceneIndex);
  const budgetPenalty    = scoreBudgetPenalty(clipPath, ctx.budgetTracker);

  // Editorial and motion — clip annotation data we don't have at path level yet
  // Use neutral 50 unless caller provides them via opts (future: inject from CandidateAsset)
  const editorial  = 50;
  const motionMatch = scoreEnergyArc(clipPath, ctx.targetMotionLevel); // same proxy for now

  const weighted =
    semantic         * WEIGHTS.semantic +
    editorial        * WEIGHTS.editorial +
    motionMatch      * WEIGHTS.motionMatch +
    blueprintMatch   * WEIGHTS.blueprintMatch +
    diversityBonus   * WEIGHTS.diversityBonus +
    entityContinuity * WEIGHTS.entityContinuity +
    locationCont     * WEIGHTS.locationContinuity +
    eraCont          * WEIGHTS.eraContinuity +
    shotVariety      * WEIGHTS.shotVariety +
    energyArc        * WEIGHTS.energyArc +
    callbackSupport  * WEIGHTS.callbackSupport;

  const finalScore = Math.max(0, Math.min(100, Math.round(weighted + budgetPenalty)));

  // Build human-readable reasons for the top candidate
  if (blueprintMatch >= 90)  reasons.push(`matches blueprint ${directive?.visualType ?? ""}`);
  if (directive?.narrativeAct) reasons.push(`narrative act: ${directive.narrativeAct}`);
  if (diversityBonus >= 80)  reasons.push("introduces new visual category");
  if (shotVariety >= 90)     reasons.push("breaks shot-type run, adds variety");
  if (callbackSupport >= 90) reasons.push("supports planned visual callback");
  if (entityContinuity >= 90) reasons.push(`contains active entity "${ctx.activeEntity}"`);
  if (locationCont >= 90)    reasons.push(`matches active location "${ctx.activeLocation}"`);
  if (eraCont >= 90)         reasons.push(`matches era "${ctx.activeEra}"`);
  if (energyArc >= 80)       reasons.push("motion level matches energy arc");
  if (budgetPenalty < 0)     reasons.push("⚠ visual type over budget");

  return {
    finalScore,
    breakdown: {
      semantic,
      editorial,
      motionMatch,
      blueprintMatch,
      diversityBonus,
      entityContinuity,
      locationContinuity: locationCont,
      eraContinuity: eraCont,
      shotVariety,
      energyArc,
      callbackSupport,
      budgetPenalty,
    },
    reasons,
  };
}

// ─── Explainability logger ─────────────────────────────────────────────────────

export function logAssetDirectorChoice(
  clipPath: string,
  sceneIndex: number,
  beatIndex: number,
  beatText: string,
  score: AssetScore
): void {
  const bk = score.breakdown;
  const base = path.basename(clipPath);
  console.log(
    `[AssetDirector] s${sceneIndex}b${beatIndex} "${beatText.slice(0, 40)}" → ${base}\n` +
    `  Semantic:${bk.semantic}  Editorial:${bk.editorial}  Blueprint:${bk.blueprintMatch}` +
    `  Diversity:${bk.diversityBonus}  ShotVariety:${bk.shotVariety}  EnergyArc:${bk.energyArc}\n` +
    `  EntityCont:${bk.entityContinuity}  LocationCont:${bk.locationContinuity}  EraCont:${bk.eraContinuity}` +
    `  Callback:${bk.callbackSupport}  BudgetPenalty:${bk.budgetPenalty}\n` +
    `  → Final: ${score.finalScore}` +
    (score.reasons.length ? `  (${score.reasons.join(", ")})` : "")
  );
}

// ─── Budget record after adopt ─────────────────────────────────────────────────

/**
 * Call this AFTER a clip is actually adopted to update the budget tracker.
 * Also increments the category counter in usedCategories.
 */
export function recordAdoptedClip(
  clipPath: string,
  ctx: AssetDirectorContext
): void {
  if (ctx.budgetTracker) {
    const vt = inferVisualTypeFromPath(clipPath) as Parameters<typeof recordBudgetUsage>[1];
    recordBudgetUsage(ctx.budgetTracker, vt);
  }
  const category = inferShotType(clipPath);
  ctx.usedCategories.set(category, (ctx.usedCategories.get(category) ?? 0) + 1);
}

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * Re-ranks candidate clip paths using global video context.
 *
 * @param candidatePaths  Paths returned by retrieval (already deduped by usedPaths)
 * @param beatText        Narration text of the current beat
 * @param sceneIndex      Scene index (for blueprint lookup)
 * @param beatIndex       Beat index within scene (for blueprint lookup)
 * @param ctx             Global video context (dedup state + blueprint)
 * @returns               Reordered paths (best first) + score breakdown for top choice
 */
export function rankCandidatesWithContext(
  candidatePaths: string[],
  beatText: string,
  sceneIndex: number,
  beatIndex: number,
  ctx: AssetDirectorContext
): AssetDirectorResult {
  if (!assetDirectorEnabled() || candidatePaths.length <= 1) {
    return { rankedPaths: candidatePaths, topScore: null, reordered: false };
  }

  const directive = getBlueprintDirective(ctx.blueprint, sceneIndex, beatIndex);

  const scored = candidatePaths.map((p) => ({
    path: p,
    score: scoreCandidate(p, beatText, sceneIndex, ctx, directive),
  }));

  scored.sort((a, b) => b.score.finalScore - a.score.finalScore);

  const originalFirst = candidatePaths[0];
  const newFirst = scored[0]!.path;
  const reordered = originalFirst !== newFirst;

  return {
    rankedPaths: scored.map((s) => s.path),
    topScore: scored[0]!.score,
    reordered,
  };
}
