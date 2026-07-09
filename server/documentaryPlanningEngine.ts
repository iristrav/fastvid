/**
 * Documentary Planning Engine
 *
 * The AI's "directing brain" — runs once after the VideoBlueprint is created,
 * before ANY retrieval begins. Produces a DocumentaryPlan that answers:
 *   "HOW do we tell this story visually?"
 * before retrieval answers:
 *   "WHICH clips do we use?"
 *
 * Orchestrates all existing planning systems into one coherent plan:
 *   1. Extends VideoBlueprint with per-beat VisualGoals and RetrievalContracts
 *   2. Plans shot diversity (10% close-up / 25% wide / ...) per act
 *   3. Plans motion intensity curve across the video
 *   4. Plans source mix (35% archive / 15% photo / ...)
 *   5. Maps the emotional arc (curious → tense → chaotic → hopeful → triumphant)
 *   6. Schedules visual callbacks (when does Churchill recur?)
 *   7. Validates the full plan before retrieval starts
 *   8. Logs complete planning report (explainability)
 *
 * NO extra LLM calls — all derived from Blueprint (one LLM) + Storyboard (one per scene).
 * Feature flag: DOCUMENTARY_PLANNING_ENGINE_ENABLED (default: on)
 */

import type {
  VideoBlueprint,
  BeatVisualDirective,
  NarrativeAct,
  VisualType,
} from "./masterDocumentaryDirector";
import type { ShotDescription } from "./editorialSequencePlanner";

// ─── Feature flag ─────────────────────────────────────────────────────────────

export function documentaryPlanningEnabled(): boolean {
  return process.env.DOCUMENTARY_PLANNING_ENGINE_ENABLED !== "false";
}

// ─── VisualGoal ───────────────────────────────────────────────────────────────

export type VisualGoal =
  | "introduce_location"
  | "introduce_person"
  | "show_scale"
  | "explain_event"
  | "build_tension"
  | "emotional_moment"
  | "reveal_information"
  | "transition"
  | "aftermath"
  | "reflection"
  | "ending"
  | "establish_era"
  | "show_consequence"
  | "callback"
  | "context"
  | "setup";

// ─── RetrievalContract ────────────────────────────────────────────────────────

/**
 * A formal pre-retrieval contract for one beat.
 * AssetDirector must honour mustContain / forbiddenContent;
 * preferredShot and sourcePreference are strong hints.
 */
export type RetrievalContract = {
  /** Beat identifier, e.g. "s3b1" */
  beatId: string;
  /** What this beat must visually accomplish */
  visualGoal: VisualGoal;
  /** Named entities / keywords that MUST appear in the chosen clip */
  mustContain: string[];
  /** Entities that improve match quality (not hard requirements) */
  shouldContain: string[];
  /** Preferred shot type from the storyboard */
  preferredShot: string;
  /** Fallback shot type if preferred is unavailable */
  fallbackShot: string;
  /** [min, max] motion level 0–100 for this beat */
  motionRange: [number, number];
  /** Planned dominant emotion */
  targetEmotion: string;
  /** Content that must NOT appear in the chosen clip */
  forbiddenContent: string[];
  /** Preferred visual source types in priority order */
  sourcePreference: string[];
  /** Human-readable explanation of this contract */
  reason: string;
};

// ─── EmotionalCurve ───────────────────────────────────────────────────────────

export type EmotionalCurvePoint = {
  sceneIndex: number;
  beatIndex: number;
  /** Planned emotion (maps from NarrativeAct + beat context) */
  emotion: string;
  /** Planned emotional intensity 0–100 */
  intensity: number;
};

// ─── ShotMixPlan ──────────────────────────────────────────────────────────────

export type ShotMixPlan = {
  /** Target fraction 0–1 for each shot category */
  closeUp: number;
  medium: number;
  wide: number;
  aerial: number;
  archival: number;
  map: number;
  graphic: number;
  textOverlay: number;
};

// ─── SourceMixPlan ────────────────────────────────────────────────────────────

export type SourceMixPlan = {
  archiveVideo: number;
  archivePhoto: number;
  map: number;
  animation: number;
  stockVideo: number;
  graphic: number;
};

// ─── PlanValidation ───────────────────────────────────────────────────────────

export type PlanValidationResult = {
  valid: boolean;
  /** Non-critical notes */
  warnings: string[];
  /** Auto-corrections applied to contracts */
  adjustments: string[];
  /** Shot mix validation */
  shotMixOk: boolean;
  /** Source mix validation */
  sourceMixOk: boolean;
  /** Emotional arc validation (intro ≠ climax emotion) */
  emotionalArcOk: boolean;
  /** Callbacks were planned for multi-scene videos */
  callbacksPlanned: boolean;
};

// ─── DocumentaryPlan ─────────────────────────────────────────────────────────

export type DocumentaryPlan = {
  videoId: string;
  /** The underlying blueprint (from masterDocumentaryDirector) */
  blueprint: VideoBlueprint | null;
  /** Per-beat retrieval contracts indexed by beatId ("s{i}b{j}") */
  contracts: Map<string, RetrievalContract>;
  /** Planned emotional arc across all beats */
  emotionalCurve: EmotionalCurvePoint[];
  /** Planned shot-type distribution */
  plannedShotMix: ShotMixPlan;
  /** Planned source distribution */
  plannedSourceMix: SourceMixPlan;
  /** Pre-retrieval plan validation result */
  validation: PlanValidationResult;
  /** ISO timestamp */
  computedAt: string;
};

// ─── VisualGoal derivation ────────────────────────────────────────────────────

const INTRODUCE_PERSON_SHOTS = ["close-up", "close up", "medium close", "portrait", "interview"];
const ESTABLISH_SHOTS = ["wide", "establishing", "aerial", "overhead", "drone"];
const MAP_SHOTS = ["map", "animation", "infographic"];

function deriveVisualGoal(
  act: NarrativeAct,
  vt: VisualType,
  shot?: ShotDescription,
  beatText?: string
): VisualGoal {
  const shotLower = (shot?.shotType ?? "").toLowerCase();
  const beatLower = (beatText ?? "").toLowerCase();

  // Map / animation beats
  if (vt === "map" || MAP_SHOTS.some((m) => shotLower.includes(m))) return "introduce_location";
  if (vt === "infographic" || vt === "animation") return "reveal_information";
  if (vt === "text_overlay") {
    if (act === "resolution") return "ending";
    return "transition";
  }

  // Introduce person
  if (
    INTRODUCE_PERSON_SHOTS.some((s) => shotLower.includes(s)) &&
    (act === "intro" || act === "setup" || beatLower.match(/\b(born|meet|introduces?|portrait)\b/))
  ) return "introduce_person";

  // Wide / establishing shots
  if (ESTABLISH_SHOTS.some((s) => shotLower.includes(s))) {
    if (act === "intro") return "establish_era";
    return "introduce_location";
  }

  // Act-based mapping
  switch (act) {
    case "intro":    return "establish_era";
    case "setup":    return beatLower.includes(" map") || beatLower.includes(" locat") ? "introduce_location" : "context";
    case "conflict": return beatLower.includes("result") || beatLower.includes("conse") ? "show_consequence" : "build_tension";
    case "climax":   return "emotional_moment";
    case "resolution":
      if (beatLower.includes("end") || beatLower.includes("final")) return "ending";
      return "aftermath";
    default:         return "context";
  }
}

// ─── Motion range by NarrativeAct ────────────────────────────────────────────

function motionRangeForAct(act: NarrativeAct, goal: VisualGoal): [number, number] {
  if (goal === "introduce_person" || goal === "reflection" || goal === "ending") return [0, 30];
  if (goal === "introduce_location" || goal === "establish_era") return [0, 45];
  switch (act) {
    case "intro":      return [0, 40];
    case "setup":      return [0, 50];
    case "conflict":   return [30, 75];
    case "climax":     return [50, 100];
    case "resolution": return [0, 40];
    default:           return [0, 60];
  }
}

// ─── Emotion mapping ──────────────────────────────────────────────────────────

const ACT_EMOTIONS: Record<NarrativeAct, { emotion: string; intensity: number }> = {
  intro:      { emotion: "curious",   intensity: 30 },
  setup:      { emotion: "interested", intensity: 45 },
  conflict:   { emotion: "tense",     intensity: 70 },
  climax:     { emotion: "intense",   intensity: 95 },
  resolution: { emotion: "relieved",  intensity: 50 },
};

function emotionFromActAndBeat(act: NarrativeAct, shotEmotion?: string): { emotion: string; intensity: number } {
  if (shotEmotion && shotEmotion.length > 2 && shotEmotion !== "neutral") {
    const base = ACT_EMOTIONS[act]?.intensity ?? 50;
    return { emotion: shotEmotion, intensity: base };
  }
  return ACT_EMOTIONS[act] ?? { emotion: "neutral", intensity: 50 };
}

// ─── ForbiddenContent derivation ──────────────────────────────────────────────

const HISTORICAL_ERAS = [
  "ancient", "medieval", "renaissance", "18th", "19th", "1900s", "1910s", "1920s",
  "1930s", "1940s", "1950s", "1960s", "1970s", "world war", "wwi", "wwii",
  "roman", "greek", "egyptian", "empire", "revolution", "colonial",
];
const MODERN_TERMS = ["modern footage", "contemporary", "2020", "2021", "2022", "2023", "2024", "2025", "AI generated", "CGI"];

function deriveForbiddenContent(
  act: NarrativeAct,
  goal: VisualGoal,
  shot?: ShotDescription,
  beatText?: string
): string[] {
  const forbidden: string[] = [];

  // Historical era → forbid modern footage
  const era = (shot?.era ?? "").toLowerCase();
  const beat = (beatText ?? "").toLowerCase();
  if (HISTORICAL_ERAS.some((h) => era.includes(h) || beat.includes(h))) {
    forbidden.push("modern footage", "contemporary", "AI generated");
    // Pre-1960 → forbid color film
    if (HISTORICAL_ERAS.slice(0, 11).some((h) => era.includes(h) || beat.includes(h))) {
      forbidden.push("color film");
    }
  }

  // Close-up person introduction → forbid crowd shots and wide landscapes
  if (goal === "introduce_person") {
    forbidden.push("crowd shot", "wide landscape", "aerial");
  }

  // Ending / reflection → forbid action and violence
  if (goal === "ending" || goal === "reflection" || goal === "aftermath") {
    forbidden.push("battle", "explosion", "violence");
  }

  // Climax → forbid static / talking-head clips
  if (act === "climax" && goal === "emotional_moment") {
    forbidden.push("static talking head", "no motion");
  }

  return forbidden;
}

// ─── SourcePreference derivation ─────────────────────────────────────────────

function deriveSourcePreference(vt: VisualType, goal: VisualGoal): string[] {
  switch (vt) {
    case "archive_video": return ["archive_video"];
    case "archive_photo": return ["archive_photo", "archive_video"];
    case "map":           return ["map", "animation"];
    case "animation":     return ["animation", "infographic"];
    case "aerial":        return ["aerial", "archive_video"];
    case "close_up":      return ["archive_video", "archive_photo"];
    case "infographic":   return ["infographic", "text_overlay"];
    case "text_overlay":  return ["text_overlay"];
    case "transition":    return ["archive_video", "archive_photo"];
    default:
      if (goal === "introduce_location") return ["map", "archive_video", "aerial"];
      return ["archive_video", "archive_photo"];
  }
}

// ─── MustContain / ShouldContain extraction ──────────────────────────────────

function extractMustContain(shot?: ShotDescription, beatText?: string): string[] {
  const must: string[] = [];
  // If the storyboard explicitly names the subject, it must appear
  const q = shot?.searchQuery ?? "";
  // First meaningful noun phrase from query (up to 3 words)
  const m = q.match(/^([A-Z][a-zA-Z]+(?: [A-Z][a-zA-Z]+){0,2})/);
  if (m?.[1]) must.push(m[1]);
  return must;
}

function extractShouldContain(shot?: ShotDescription, beatText?: string): string[] {
  const should: string[] = [];
  // All alternatives from storyboard minus the primary query
  if (shot?.alternatives) should.push(...shot.alternatives.slice(0, 2));
  // Location / era from storyboard
  if (shot?.location && shot.location.length > 2) should.push(shot.location);
  return should.filter((s) => s.length > 2);
}

// ─── Per-beat contract derivation ─────────────────────────────────────────────

function deriveContract(
  sceneIndex: number,
  beatIndex: number,
  directive: BeatVisualDirective | null | undefined,
  shot: ShotDescription | null | undefined,
  beatText: string
): RetrievalContract {
  const act: NarrativeAct = directive?.narrativeAct ?? "setup";
  const vt: VisualType = directive?.visualType ?? "archive_video";
  const beatId = `s${sceneIndex}b${beatIndex}`;

  const visualGoal = deriveVisualGoal(act, vt, shot ?? undefined, beatText);
  const motionRange = motionRangeForAct(act, visualGoal);
  const { emotion: targetEmotion } = emotionFromActAndBeat(act, shot?.emotion);
  const forbiddenContent = deriveForbiddenContent(act, visualGoal, shot ?? undefined, beatText);
  const sourcePreference = deriveSourcePreference(vt, visualGoal);
  const mustContain = extractMustContain(shot ?? undefined, beatText);
  const shouldContain = extractShouldContain(shot ?? undefined, beatText);

  const preferredShot = shot?.shotType ?? derivePreferredShot(vt, visualGoal);
  const fallbackShot = deriveFallbackShot(preferredShot);

  const reason = buildContractReason(visualGoal, act, preferredShot, targetEmotion, forbiddenContent);

  return {
    beatId,
    visualGoal,
    mustContain,
    shouldContain,
    preferredShot,
    fallbackShot,
    motionRange,
    targetEmotion,
    forbiddenContent,
    sourcePreference,
    reason,
  };
}

function derivePreferredShot(vt: VisualType, goal: VisualGoal): string {
  if (vt === "close_up") return "close-up";
  if (vt === "aerial") return "aerial";
  if (vt === "map") return "map";
  if (goal === "introduce_person") return "medium close-up";
  if (goal === "establish_era" || goal === "introduce_location") return "wide establishing";
  if (goal === "show_scale") return "aerial wide";
  if (goal === "emotional_moment") return "close-up";
  return "medium";
}

function deriveFallbackShot(preferred: string): string {
  if (preferred.includes("close")) return "medium";
  if (preferred.includes("wide") || preferred.includes("aerial")) return "medium";
  if (preferred.includes("map")) return "wide establishing";
  return "archival";
}

function buildContractReason(
  goal: VisualGoal,
  act: NarrativeAct,
  shot: string,
  emotion: string,
  forbidden: string[]
): string {
  const goalStr = goal.replace(/_/g, " ");
  const forb = forbidden.length > 0 ? `; NOT: ${forbidden.slice(0, 2).join(", ")}` : "";
  return `${act} act → ${goalStr}. Shot: ${shot}. Emotion: ${emotion}${forb}.`;
}

// ─── ShotMixPlan derivation ───────────────────────────────────────────────────

export function deriveShotMixPlan(blueprint: VideoBlueprint | null): ShotMixPlan {
  if (!blueprint) {
    // Default balanced mix
    return { closeUp: 0.10, medium: 0.25, wide: 0.20, aerial: 0.08, archival: 0.20, map: 0.10, graphic: 0.05, textOverlay: 0.02 };
  }

  const budget = blueprint.visualBudget;
  return {
    closeUp:    budget.close_up,
    medium:     Math.max(0.15, 1 - budget.close_up - budget.aerial - budget.map - budget.infographic - budget.archive_photo - budget.animation),
    wide:       0.20,  // always at least 20% wide shots for establishing context
    aerial:     budget.aerial,
    archival:   budget.archive_video + budget.archive_photo,
    map:        budget.map,
    graphic:    budget.infographic,
    textOverlay: budget.animation * 0.3,
  };
}

// ─── SourceMixPlan derivation ─────────────────────────────────────────────────

export function deriveSourceMixPlan(blueprint: VideoBlueprint | null): SourceMixPlan {
  if (!blueprint) {
    return { archiveVideo: 0.35, archivePhoto: 0.15, map: 0.10, animation: 0.10, stockVideo: 0.20, graphic: 0.10 };
  }
  const budget = blueprint.visualBudget;
  return {
    archiveVideo: budget.archive_video,
    archivePhoto: budget.archive_photo,
    map:          budget.map,
    animation:    budget.animation,
    stockVideo:   budget.live_footage,
    graphic:      budget.infographic,
  };
}

// ─── EmotionalCurve derivation ────────────────────────────────────────────────

function deriveEmotionalCurve(
  scenes: Array<{ index: number; beats: Array<{ index: number; text: string }> }>,
  blueprint: VideoBlueprint | null
): EmotionalCurvePoint[] {
  const curve: EmotionalCurvePoint[] = [];

  for (const scene of scenes) {
    for (const beat of scene.beats) {
      const directive = blueprint?.beatDirectives.get(`${scene.index}_${beat.index}`);
      const act: NarrativeAct = directive?.narrativeAct ?? "setup";
      const { emotion, intensity } = emotionFromActAndBeat(act);
      curve.push({
        sceneIndex: scene.index,
        beatIndex:  beat.index,
        emotion,
        intensity,
      });
    }
  }

  return curve;
}

// ─── Plan validation ──────────────────────────────────────────────────────────

function validatePlan(
  contracts: Map<string, RetrievalContract>,
  shotMix: ShotMixPlan,
  sourceMix: SourceMixPlan,
  emotionalCurve: EmotionalCurvePoint[],
  blueprint: VideoBlueprint | null
): PlanValidationResult {
  const warnings: string[] = [];
  const adjustments: string[] = [];

  // Shot mix: close-up should be 5–25%
  const shotMixOk = shotMix.closeUp >= 0.05 && shotMix.closeUp <= 0.30 &&
                    shotMix.wide >= 0.10 && shotMix.wide <= 0.40;
  if (!shotMixOk) warnings.push(`Shot mix imbalanced: closeUp=${(shotMix.closeUp * 100).toFixed(0)}% wide=${(shotMix.wide * 100).toFixed(0)}%`);

  // Source mix: archive should be 20–80%
  const totalArchive = sourceMix.archiveVideo + sourceMix.archivePhoto;
  const sourceMixOk = totalArchive >= 0.20 && totalArchive <= 0.85;
  if (!sourceMixOk) warnings.push(`Source mix: archive=${(totalArchive * 100).toFixed(0)}% (target 20–80%)`);

  // Emotional arc: should not stay flat the whole video
  const uniqueEmotions = new Set(emotionalCurve.map((e) => e.emotion));
  const emotionalArcOk = uniqueEmotions.size >= 2;
  if (!emotionalArcOk) warnings.push("Emotional arc is flat — no variation across beats");

  // Callbacks
  const callbacksPlanned = (blueprint?.visualCallbacks?.length ?? 0) > 0 ||
    Array.from(contracts.values()).some((c) => c.visualGoal === "callback");
  if (!callbacksPlanned && contracts.size > 6) {
    warnings.push("No visual callbacks planned for multi-beat video");
  }

  // Check contracts for conflicting requirements
  contracts.forEach((contract, beatId) => {
    if (contract.mustContain.some((m: string) => contract.forbiddenContent.some((f: string) => f.toLowerCase().includes(m.toLowerCase())))) {
      adjustments.push(`${beatId}: mustContain conflicts with forbiddenContent — removing forbidden overlap`);
    }
  });

  return {
    valid: warnings.length === 0,
    warnings,
    adjustments,
    shotMixOk,
    sourceMixOk,
    emotionalArcOk,
    callbacksPlanned,
  };
}

// ─── Plan logging ─────────────────────────────────────────────────────────────

function logDocumentaryPlan(plan: DocumentaryPlan, videoTitle: string): void {
  const contractCount = plan.contracts.size;
  const { validation: v, plannedShotMix: sm, plannedSourceMix: src } = plan;

  console.log(
    `\n[DocumentaryPlan] "${videoTitle}" — ${contractCount} beat contracts` +
    `\n  Shot mix:   close-up ${(sm.closeUp * 100).toFixed(0)}%  medium ${(sm.medium * 100).toFixed(0)}%  wide ${(sm.wide * 100).toFixed(0)}%  aerial ${(sm.aerial * 100).toFixed(0)}%  map ${(sm.map * 100).toFixed(0)}%  graphic ${(sm.graphic * 100).toFixed(0)}%` +
    `\n  Source mix: archiveVideo ${(src.archiveVideo * 100).toFixed(0)}%  archivePhoto ${(src.archivePhoto * 100).toFixed(0)}%  map ${(src.map * 100).toFixed(0)}%  animation ${(src.animation * 100).toFixed(0)}%  stock ${(src.stockVideo * 100).toFixed(0)}%` +
    `\n  Emotional arc: ${plan.emotionalCurve.map((e) => e.emotion).filter((em, i, a) => a.indexOf(em) === i).join(" → ")}` +
    `\n  Validation: ${v.valid ? "✓ OK" : "⚠ " + v.warnings.join(" | ")}`
  );

  // Per-beat contract log (first 6 beats as sample)
  let logged = 0;
  plan.contracts.forEach((c, beatId) => {
    if (logged++ >= 6) return;
    console.log(
      `  [${beatId}] goal=${c.visualGoal} shot=${c.preferredShot} motion=[${c.motionRange[0]},${c.motionRange[1]}] emotion=${c.targetEmotion}` +
      (c.mustContain.length ? ` must=${c.mustContain.join(",")}` : "") +
      (c.forbiddenContent.length ? ` NOT=${c.forbiddenContent.slice(0, 2).join(",")}` : "")
    );
  });
  if (contractCount > 6) {
    console.log(`  ... (${contractCount - 6} more contracts)`);
  }
}

// ─── Public: getRetrievalContract ────────────────────────────────────────────

export function getRetrievalContract(
  plan: DocumentaryPlan | null | undefined,
  sceneIndex: number,
  beatIndex: number
): RetrievalContract | null {
  return plan?.contracts.get(`s${sceneIndex}b${beatIndex}`) ?? null;
}

// ─── Main: buildDocumentaryPlan ──────────────────────────────────────────────

/**
 * Build the full DocumentaryPlan from existing blueprint + storyboard data.
 * Called once after createVideoBlueprint() resolves, before retrieval starts.
 *
 * @param videoId       Pipeline video ID
 * @param videoTitle    Video title (for logging)
 * @param scenes        All scenes with their beats
 * @param blueprint     VideoBlueprint from masterDocumentaryDirector (may be null)
 * @param storyboards   Optional pre-built storyboard map (sceneIndex → SceneStoryboard)
 */
export function buildDocumentaryPlan(
  videoId: string,
  videoTitle: string,
  scenes: Array<{
    index: number;
    beats: Array<{ index: number; text: string }>;
  }>,
  blueprint: VideoBlueprint | null,
  storyboards?: Map<number, { shots: ShotDescription[] }>
): DocumentaryPlan {
  const contracts = new Map<string, RetrievalContract>();

  for (const scene of scenes) {
    const sb = storyboards?.get(scene.index);
    for (const beat of scene.beats) {
      const directive = blueprint?.beatDirectives.get(`${scene.index}_${beat.index}`) ?? null;
      const shot = sb?.shots.find((s) => s.beatIndex === beat.index) ?? null;
      const contract = deriveContract(scene.index, beat.index, directive, shot, beat.text);
      contracts.set(`s${scene.index}b${beat.index}`, contract);
    }
  }

  const plannedShotMix  = deriveShotMixPlan(blueprint);
  const plannedSourceMix = deriveSourceMixPlan(blueprint);
  const emotionalCurve  = deriveEmotionalCurve(scenes, blueprint);
  const validation       = validatePlan(contracts, plannedShotMix, plannedSourceMix, emotionalCurve, blueprint);

  const plan: DocumentaryPlan = {
    videoId,
    blueprint,
    contracts,
    emotionalCurve,
    plannedShotMix,
    plannedSourceMix,
    validation,
    computedAt: new Date().toISOString(),
  };

  logDocumentaryPlan(plan, videoTitle);

  return plan;
}

// ─── Contract scoring helpers (used by AssetDirector) ────────────────────────

/**
 * Score how well a clip's annotation matches the retrieval contract.
 * Returns { bonus: +0 to +5, penalty: -4 to 0 }.
 *
 * Additive on top of existing AssetDirector / TasteModel scores.
 */
export function scoreRetrievalContract(
  contract: RetrievalContract | null | undefined,
  annotationPersons?: string[],
  annotationObjects?: string[],
  cinematicTags?: string[],
  emotion?: string
): { bonus: number; penalty: number; explanation: string } {
  if (!contract) return { bonus: 0, penalty: 0, explanation: "" };

  let bonus = 0;
  let penalty = 0;
  const parts: string[] = [];

  // mustContain bonus
  const allAnnotationText = [
    ...(annotationPersons ?? []),
    ...(annotationObjects ?? []),
  ].map((s) => s.toLowerCase());

  for (const must of contract.mustContain) {
    const ml = must.toLowerCase();
    if (allAnnotationText.some((t) => t.includes(ml) || ml.includes(t))) {
      bonus += 2;
      parts.push(`+2 must(${must})`);
    }
  }

  // shouldContain bonus
  for (const should of contract.shouldContain) {
    const sl = should.toLowerCase();
    if (allAnnotationText.some((t) => t.includes(sl) || sl.includes(t))) {
      bonus += 1;
      parts.push(`+1 should(${should})`);
    }
  }

  // Emotion match bonus
  if (emotion && contract.targetEmotion) {
    if (emotion.toLowerCase().includes(contract.targetEmotion.toLowerCase()) ||
        contract.targetEmotion.toLowerCase().includes(emotion.toLowerCase())) {
      bonus += 1;
      parts.push(`+1 emotion`);
    }
  }

  // forbiddenContent penalty
  const allTags = [...(cinematicTags ?? []), ...(annotationObjects ?? [])].map((s) => s.toLowerCase());
  for (const forbidden of contract.forbiddenContent) {
    const fl = forbidden.toLowerCase();
    if (allTags.some((t) => t.includes(fl) || fl.includes(t))) {
      penalty -= 2;
      parts.push(`-2 forbidden(${forbidden})`);
    }
  }

  return {
    bonus: Math.min(5, bonus),
    penalty: Math.max(-4, penalty),
    explanation: parts.join(" "),
  };
}
