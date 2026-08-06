/** AI Director — types (Phase 5, "the creative brain of FastVid").
 *
 *  The AI Director sits between the Visual Intelligence Engine (Phase 3) and the Cinematic
 *  Editing Engine (Phase 4) in the pipeline:
 *
 *    Script -> Scene Splitter -> Visual Intelligence Engine -> AI Director
 *      -> Cinematic Editing Engine -> EDL -> Renderer
 *
 *  It operates one level above Phase 4: Phase 4's planners decide per-BEAT presentation
 *  mechanics (this clip's shot type, this cut's transition) from that beat's own VisualIntent
 *  and winning candidate. The AI Director decides per-SCENE narrative judgment (why this scene
 *  exists, what the viewer should feel, how attention should be managed across the whole
 *  scene) from the scene's full set of beats plus the video's overall shape — information no
 *  single Phase 4 planner call ever sees. It never touches a CandidateAsset (it doesn't know
 *  what footage exists yet) and never produces FFmpeg/rendering instructions — only structured
 *  editorial decisions a human documentary editor would make while reading the script, before
 *  a single clip has been searched for.
 */
import type { Scene } from "../pipeline/types";
import type { VideoContext, VisualIntent } from "../visualMatchingV2/types";
import type { ShotType, TransitionType } from "../cinematicEditingEngine/types";

// ─── Narrative classification ────────────────────────────────────────────────────

/** The scene's role in the overall story arc — "documentary thinking": cause/effect,
 *  conflict/contrast, scale/importance, narrative flow. */
export type NarrativeFunction = "establish" | "explain" | "contrast" | "reveal" | "climax" | "resolve" | "transition";

/** Richer than Cinematic Editing Engine's 4-bucket EmotionalTone — this is the specific
 *  feeling the Director wants the audience to have, which then maps DOWN onto Phase 4's
 *  coarser pacing tone (see directorEmotionToPacingTone in narrativeAnalysis.ts) rather than
 *  the two being independently derived and potentially disagreeing. */
export type DirectorEmotion =
  | "curiosity"
  | "excitement"
  | "tension"
  | "awe"
  | "empathy"
  | "urgency"
  | "triumph"
  | "unease"
  | "nostalgia"
  | "hope"
  | "concern"
  | "neutral";

/** What kind of footage/graphic this scene is fundamentally built around. Deliberately
 *  reuses (not duplicates) Cinematic Editing Engine vocabulary where the concepts line up
 *  (archive_footage/b_roll/close_up_product map straight onto ShotType; map/chart/timeline
 *  map straight onto MotionGraphicType) — see narrativeAnalysis.ts's mapping to ShotType for
 *  shotOrder generation. */
export type VisualStrategy =
  | "archive_footage"
  | "interview"
  | "keynote_or_stage_footage"
  | "b_roll"
  | "map"
  | "chart"
  | "timeline"
  | "close_up_product"
  | "montage";

export type PacingLabel = "slow" | "medium" | "fast";
export type EnergyTrend = "increasing" | "decreasing" | "steady";

export type ShotOrderItem = {
  order: number;
  shotType: ShotType;
  reason: string;
};

// ─── Attention management ────────────────────────────────────────────────────────

export type AttentionRecommendationType =
  | "increase_energy"
  | "slow_down"
  | "introduce_contrast"
  | "insert_supporting_visual"
  | "change_shot_type"
  | "add_emphasis";

export type AttentionRecommendation = {
  type: AttentionRecommendationType;
  reason: string;
};

export type HookGuidance = {
  isHookSegment: boolean;
  recommendations: string[];
  reason: string;
};

export type RetentionRisk = {
  isAtRisk: boolean;
  reason: string;
  recommendations: string[];
};

// ─── Input contract ─────────────────────────────────────────────────────────────

export type DirectorContext = {
  scene: Scene;
  /** All beats belonging to this scene — Phase 3's extractVisualIntentsForScene already
   *  produces exactly this, batched per scene. The Director reads it but never triggers that
   *  extraction itself ("should NOT search media" extends to never calling Phase 3's own
   *  extraction/retrieval — it only consumes already-produced VisualIntents). */
  beatIntents: VisualIntent[];
  videoContext?: VideoContext;
  sceneIndex: number;
  totalScenes: number;
  /** Elapsed video time before this scene starts, seconds — needed for hook-window detection
   *  (first 30 seconds) and pacing-relative-to-position judgment. */
  sceneStartSec: number;
  sceneDurationSec: number;
  totalVideoDurationSec: number;
  /** Every prior scene's decision in this video, oldest first — enables the variation checks
   *  ("avoid repeating the same visual style/shot") and retention-risk detection ("a long,
   *  low-energy scene right after another one"). Empty for the first scene. */
  previousDecisions: DirectorDecision[];
};

// ─── Output contract ────────────────────────────────────────────────────────────

export type DirectorDecision = {
  sceneIndex: number;
  primarySubject: string;
  secondarySubject: string | null;
  narrativeFunction: NarrativeFunction;
  narrativePurpose: string;
  emotion: DirectorEmotion;
  visualStrategy: VisualStrategy;
  supportingVisuals: string[];
  shotOrder: ShotOrderItem[];
  pacing: PacingLabel;
  energyTrend: EnergyTrend;
  transitionStyle: TransitionType;
  textOverlaySuggestion: string | null;
  soundCueSuggestion: string | null;
  attentionRecommendations: AttentionRecommendation[];
  /** Only meaningfully populated (isHookSegment: true) for scenes within the first 30 seconds
   *  of the video — see HOOK OPTIMIZATION. Always present (never undefined) so consumers don't
   *  need an extra null check beyond isHookSegment itself. */
  hookGuidance: HookGuidance;
  retentionRisk: RetentionRisk;
  /** One cohesive, human-readable explanation of the overall decision — matches the literal
   *  Phase 5 output example's single "Reason:" line. Per-item reasons (shotOrder, attention
   *  recommendations, etc.) explain their own specific choice; this one explains the scene's
   *  editorial judgment as a whole. */
  reason: string;
};

// ─── Future-compatibility surface ────────────────────────────────────────────────
// "The Director should expose structured interfaces for future modules" — Thumbnail
// Generator, Shorts Generator, Highlight Generator, Trailer Generator, Automatic A/B Editing.
// These derive from the same DirectorDecision[] a renderer would consume; no separate
// analysis pass is needed for a future module to use them.

export type HighlightMoment = {
  sceneIndex: number;
  reason: string;
  /** Which future module(s) this moment is a plausible candidate for — a thumbnail generator
   *  wants a single strongest frame's scene, a trailer generator wants several. */
  suggestedFor: Array<"thumbnail" | "shorts" | "highlight_reel" | "trailer">;
};

export type RetentionRiskEntry = RetentionRisk & { sceneIndex: number };

export type DirectorOutput = {
  decisions: DirectorDecision[];
  /** Seconds considered "the hook" — see HOOK OPTIMIZATION. Currently fixed at 30, exposed as
   *  a field (not a hardcoded assumption downstream) so a future module can read it instead of
   *  re-deriving the same constant. */
  hookWindowSec: number;
  highlightMoments: HighlightMoment[];
  retentionRisks: RetentionRiskEntry[];
  totalVideoDurationSec: number;
};
