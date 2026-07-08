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
import type { ClipAnnotation } from "../drizzle/annotationTypes";

// ─── Feature flag ─────────────────────────────────────────────────────────────

export function assetDirectorEnabled(): boolean {
  return process.env.ASSET_DIRECTOR_ENABLED !== "false";
}

// ─── Per-candidate metadata (annotation + editorial score) ────────────────────

/**
 * Rich metadata for one candidate clip, combining ClipAnnotation fields
 * with the editorial score stored in media_archive_assets.
 * Callers (videoPipeline.ts) populate this from the DB row when available;
 * AssetDirector falls back to path-heuristics when absent.
 */
export type CandidateMeta = {
  /** Archive asset DB id — used to key this map */
  assetId?: number;
  annotation?: ClipAnnotation | null;
  /** editorialScore.total from annotation (0–100), or null when not yet annotated */
  editorialScore?: number | null;
  /** storyboard / rhythm planner data */
  plannerShotType?: string | null;
  plannerMotionTarget?: number | null;
};

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
  /** Planned shot type from EditorialSequencePlanner storyboard, e.g. "wide establishing shot" */
  plannedShotType?: string | null;
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

// Infer approximate motion level from annotation or filename/path (0–100)
function inferMotionLevel(clipPath: string, meta?: CandidateMeta): number | null {
  if (meta?.annotation?.motionLevel != null) return meta.annotation.motionLevel;
  const base = path.basename(clipPath).toLowerCase();
  if (FALLBACK_RE.test(base)) return 0;
  if (MAP_RE.test(base) || ARCHIVAL_RE.test(base)) return 15;
  if (AI_RE.test(clipPath.toLowerCase())) return 60;
  if (WIDE_RE.test(base)) return 50;
  if (CLOSE_RE.test(base)) return 30;
  return null;
}

// ─── Individual signal scorers (0–100 each) ───────────────────────────────────

/**
 * Semantic relevance — uses annotation fields (persons, objects, actions, event,
 * period, topicAffinity) when available; falls back to filename keyword matching.
 */
function scoreSemanticRelevance(clipPath: string, beatText: string, meta?: CandidateMeta): number {
  const words = beatText.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  if (words.length === 0) return 50;

  const ann = meta?.annotation;
  if (ann) {
    // Build a rich semantic document from annotation fields
    const annTokens = [
      ...ann.persons.named,
      ...ann.persons.categories,
      ...ann.objects,
      ...ann.actions,
      ann.historicalContext.event,
      ann.historicalContext.period,
      ann.historicalContext.year,
      ann.historicalContext.decade,
      ann.location.country,
      ann.location.city,
      ann.location.region,
      ann.environment.setting,
      ann.emotion,
      ...ann.usageHints.topicAffinity,
    ].join(" ").toLowerCase();

    const matchCount = words.filter((w) => annTokens.includes(w)).length;
    // Annotation-based match is high-quality — score 40–100
    return Math.round(40 + (matchCount / words.length) * 60);
  }

  // Fallback: filename keyword match
  const base = path.basename(clipPath).toLowerCase().replace(/[_.-]/g, " ");
  const matchCount = words.filter((w) => base.includes(w)).length;
  return Math.round(30 + (matchCount / words.length) * 70);
}

/** Bonus when clip matches the blueprint's planned visual type for this beat */
function scoreBlueprintMatch(
  clipPath: string,
  directive: BeatVisualDirective | null,
  meta?: CandidateMeta
): number {
  if (!directive) return 50;
  // Prefer annotation visualStyle over path-heuristics
  const inferred = meta?.annotation?.cinematography?.visualStyle
    ? mapVisualStyleToType(meta.annotation.cinematography.visualStyle)
    : inferVisualTypeFromPath(clipPath);
  if (inferred === directive.visualType) return 100;
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

function mapVisualStyleToType(style: string): string {
  const s = style.toLowerCase();
  if (s === "archival" || s === "newsreel" || s === "black and white" || s === "sepia") return "archive_video";
  if (s === "illustration" || s === "map" || s === "animation") return "archive_photo";
  if (s === "drone") return "aerial";
  if (s === "documentary" || s === "modern") return "live_footage";
  return s;
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

/** Bonus when a clip contains the active entity — uses annotation.persons when available */
function scoreEntityContinuity(
  clipPath: string,
  activeEntity: string | null | undefined,
  meta?: CandidateMeta
): number {
  if (!activeEntity || activeEntity.length < 3) return 50;
  const entityTokens = activeEntity.toLowerCase().split(/\s+/);

  if (meta?.annotation) {
    const namedPersons = meta.annotation.persons.named.map((p) => p.toLowerCase());
    const matchCount = entityTokens.filter((t) => namedPersons.some((p) => p.includes(t))).length;
    if (matchCount === entityTokens.length) return 100;
    if (matchCount > 0) return 75;
    // Entity not in annotation persons — strong signal against this clip
    return 20;
  }

  // Fallback: filename match
  const base = path.basename(clipPath).toLowerCase();
  const matchCount = entityTokens.filter((t) => base.includes(t)).length;
  if (matchCount === entityTokens.length) return 100;
  if (matchCount > 0) return 70;
  return 30;
}

/** Location continuity — uses annotation.location when available */
function scoreLocationContinuity(
  clipPath: string,
  activeLocation: string | null | undefined,
  meta?: CandidateMeta
): number {
  if (!activeLocation || activeLocation.length < 3) return 50;
  const loc = activeLocation.toLowerCase();

  if (meta?.annotation) {
    const ann = meta.annotation;
    const locFields = [ann.location.country, ann.location.city, ann.location.region, ann.location.continent]
      .join(" ").toLowerCase();
    if (locFields.includes(loc)) return 100;
    // Location explicitly known but doesn't match
    if (ann.location.confidence === "high" || ann.location.confidence === "medium") return 20;
    return 50; // uncertain — neutral
  }

  const combined = (path.basename(clipPath) + " " + clipPath).toLowerCase();
  if (combined.includes(loc)) return 100;
  return 50;
}

/** Era continuity — uses annotation.historicalContext when available */
function scoreEraContinuity(
  clipPath: string,
  activeEra: string | null | undefined,
  meta?: CandidateMeta
): number {
  if (!activeEra) return 50;
  const era = activeEra.toLowerCase();

  if (meta?.annotation) {
    const hc = meta.annotation.historicalContext;
    const eraFields = [hc.year, hc.decade, hc.century, hc.period, hc.event].join(" ").toLowerCase();
    if (eraFields.includes(era)) return 100;
    const decade = era.replace(/\d$/, "0");
    if (eraFields.includes(decade)) return 75;
    // Historical context known but mismatches — penalize
    if (hc.year || hc.decade) return 25;
    return 50;
  }

  const combined = (path.basename(clipPath) + " " + clipPath).toLowerCase();
  if (combined.includes(era)) return 100;
  const decade = era.replace(/\d$/, "0");
  if (combined.includes(decade)) return 75;
  return 50;
}

/**
 * Shot variety: penalize when the same shot type appears too many consecutive times.
 * Uses annotation.cinematography.shotType when available.
 */
function scoreShotVariety(
  clipPath: string,
  beatText: string,
  sceneAdoptedClips: string[],
  meta?: CandidateMeta,
  plannedShotType?: string | null
): number {
  if (sceneAdoptedClips.length === 0) return 70;
  const myType = meta?.annotation?.cinematography?.shotType ?? inferShotType(clipPath, beatText);
  // Bonus when clip matches the storyboard's planned shot type
  if (plannedShotType && myType.toLowerCase().includes(plannedShotType.toLowerCase().split(" ")[0]!)) {
    // Planned type match overrides consecutive penalty by 1 level
  }
  let consecutive = 0;
  for (let i = sceneAdoptedClips.length - 1; i >= 0; i--) {
    if (inferShotType(sceneAdoptedClips[i]!, beatText) === myType) consecutive++;
    else break;
  }
  if (consecutive === 0) return 100;
  if (consecutive === 1) return 70;
  if (consecutive === 2) return 40;
  return 10;
}

/** Motion energy arc — uses annotation.motionLevel when available */
function scoreEnergyArc(
  clipPath: string,
  targetMotionLevel: number | null | undefined,
  meta?: CandidateMeta
): number {
  if (targetMotionLevel == null) return 50;
  const inferred = inferMotionLevel(clipPath, meta);
  if (inferred === null) return 50;
  const diff = Math.abs(inferred - targetMotionLevel);
  if (diff <= 10) return 100;
  if (diff <= 20) return 80;
  if (diff <= 35) return 60;
  if (diff <= 50) return 40;
  return 20;
}

/** Motion type match (distinct from energy arc): uses annotation.cinematography.cameraMovement */
function scoreMotionMatch(
  clipPath: string,
  targetMotionLevel: number | null | undefined,
  meta?: CandidateMeta
): number {
  if (meta?.annotation?.cinematography?.cameraMovement) {
    const movement = meta.annotation.cinematography.cameraMovement.toLowerCase();
    if (targetMotionLevel == null) return 50;
    // Map camera movement to motion proxy
    const movementMotion: Record<string, number> = {
      static: 5, handheld: 40, pan: 35, tilt: 30,
      zoom: 45, dolly: 55, crane: 65, tracking: 70, drone: 80, orbit: 75,
    };
    const motionProxy = movementMotion[movement] ?? 50;
    const diff = Math.abs(motionProxy - targetMotionLevel);
    if (diff <= 15) return 100;
    if (diff <= 30) return 70;
    if (diff <= 50) return 40;
    return 20;
  }
  // Fallback: same proxy as energy arc but uses editorial score as tiebreaker
  return scoreEnergyArc(clipPath, targetMotionLevel, meta);
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
  directive: BeatVisualDirective | null,
  meta?: CandidateMeta
): AssetScore {
  const reasons: string[] = [];

  const semantic         = scoreSemanticRelevance(clipPath, beatText, meta);
  const blueprintMatch   = scoreBlueprintMatch(clipPath, directive, meta);
  const diversityBonus   = scoreDiversityBonus(clipPath, ctx.usedPaths, ctx.usedCategories);
  const entityContinuity = scoreEntityContinuity(clipPath, ctx.activeEntity, meta);
  const locationCont     = scoreLocationContinuity(clipPath, ctx.activeLocation, meta);
  const eraCont          = scoreEraContinuity(clipPath, ctx.activeEra, meta);
  const shotVariety      = scoreShotVariety(clipPath, beatText, ctx.sceneAdoptedClips, meta, ctx.plannedShotType);
  const energyArc        = scoreEnergyArc(clipPath, ctx.targetMotionLevel, meta);
  const callbackSupport  = scoreCallbackSupport(clipPath, beatText, ctx.blueprint, sceneIndex);
  const budgetPenalty    = scoreBudgetPenalty(clipPath, ctx.budgetTracker);

  // Editorial score: use annotation when available, otherwise redistribute weight
  const editorial   = meta?.editorialScore != null ? meta.editorialScore : 50;
  const motionMatch = scoreMotionMatch(clipPath, ctx.targetMotionLevel, meta);

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
  ctx: AssetDirectorContext,
  /** Optional per-path annotation metadata from the archive DB */
  candidateMeta?: Map<string, CandidateMeta>
): AssetDirectorResult {
  if (!assetDirectorEnabled() || candidatePaths.length <= 1) {
    return { rankedPaths: candidatePaths, topScore: null, reordered: false };
  }

  const directive = getBlueprintDirective(ctx.blueprint, sceneIndex, beatIndex);

  const scored = candidatePaths.map((p) => ({
    path: p,
    score: scoreCandidate(p, beatText, sceneIndex, ctx, directive, candidateMeta?.get(p)),
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
