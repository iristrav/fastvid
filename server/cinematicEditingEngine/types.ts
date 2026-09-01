/** Cinematic Editing Engine — types (Phase 4, "AI video editor").
 *
 *  Every planner in this directory is a pure decision function: given already-resolved
 *  inputs (Scene, Visual Intent, Best Candidate, Timeline, Word Timestamps, Video Context,
 *  Visual Continuity — the literal Phase 4 INPUT list), it returns a typed instruction, never
 *  pixels/audio samples. Nothing in this directory renders anything. The instructions are
 *  assembled by edlGenerator.ts into one Edit Decision List (EDL) per scene — the contract a
 *  future renderer (Phase 6+) will consume.
 *
 *  Every instruction type carries a `reason: string` field. This isn't decorative — it's the
 *  literal "NO RANDOMNESS: every edit must have a reason" requirement, made structurally
 *  impossible to skip.
 *
 *  Optional integration point with the AI Director (Phase 5, server/aiDirector/): see
 *  DirectorGuidance below and CinematicEditingInput.directorGuidance. Deliberately a narrow,
 *  self-contained shape rather than importing aiDirector's own DirectorDecision type — that
 *  module's types already import ShotType/TransitionType from this file, so importing back
 *  from it here would create a circular module dependency. A real DirectorDecision is adapted
 *  into this shape by aiDirector's own toDirectorGuidance() helper; this file has zero
 *  dependency on aiDirector either way.
 */
import type { CandidateAsset, VideoContext, VisualIntent } from "../visualMatchingV2/types";
import type { TtsWordTiming } from "../voiceTtsAlignment";
import type { Scene } from "../pipeline/types";

// ─── Input contract ─────────────────────────────────────────────────────────────
// The literal Phase 4 "INPUT" list, typed. One of these is built per beat/scene by the
// caller (Phase 5's renderer, or a test) from artifacts Phases 2-3 already produce — this
// directory does not fetch, search, or extract any of it itself.

/** Read-only view of what's already been shown earlier in the video, for continuity-aware
 *  decisions (avoid repeating the same shot type/transition/effect back to back, keep
 *  established brand/era/subject locked in) — same shape as visualMatchingV2's diversity
 *  tracking (RankingOptions), reused here for the same reason: one accumulator convention
 *  across the codebase instead of a parallel one per module. */
export type VisualContinuityState = {
  /** Shot types used so far in this scene, most recent last — informs shot variety. */
  recentShotTypes: string[];
  /** Transition types used so far in this scene, most recent last — informs transition variety. */
  recentTransitions: string[];
  /** Brands/companies/subjects already established earlier in the video (VideoContext.keySubjects
   *  plus any VisualIntent.brands/companies seen so far) — camera/effects/sound decisions stay
   *  consistent with what's already on screen rather than introducing a jarring new one. */
  establishedSubjects: string[];
};

/** Narrow, self-contained shape describing what a scene-level AI Director decision (Phase 5)
 *  can offer a per-beat planner in this directory — not aiDirector's full DirectorDecision
 *  (see the module doc comment above for why). Every field is optional; a planner that
 *  receives this with everything undefined behaves exactly as if no guidance was passed at
 *  all, so wiring this in is purely additive. */
export type DirectorGuidance = {
  /** The scene's overall emotional tone, already mapped down to this module's coarser
   *  4-value vocabulary — see aiDirector's directorEmotionToPacingTone(). When present, a
   *  beat's own local emotional signal (VisualIntent.emotion / keyword scan) still exists as
   *  a fallback if this is ever absent, but the Director's scene-wide judgment takes
   *  precedence when both are available. */
  pacingTone?: EmotionalTone;
  /** The scene-level recommended shot progression, 1-based `order` matching a beat's position
   *  within the scene (see ShotPlanner's optional beatIndexInScene parameter). Consulted only
   *  as a fallback when no beat-local signal (historical footage, reaction cue, detail action,
   *  portrait framing, established location) already determined the shot type — local,
   *  footage-specific signals always win over this scene-level suggestion. */
  shotOrder?: Array<{ order: number; shotType: ShotType }>;
};

export type CinematicEditingInput = {
  scene: Scene;
  intent: VisualIntent;
  bestCandidate: CandidateAsset;
  /** This beat's word-level timing, when real TTS alignment is available (voiceTtsAlignment.ts).
   *  Undefined falls back to proportional estimation, same as Phase 3's planSubBeatCuts. */
  wordTimings?: TtsWordTiming[];
  videoContext?: VideoContext;
  continuity?: VisualContinuityState;
  /** This beat's voice-over start time within the scene, seconds. */
  beatVoiceStartSec: number;
  /** This beat's voice-over duration, seconds. */
  beatVoiceDurationSec: number;
  /** This beat's position within its scene (0-based) — needed to look up the matching entry
   *  in directorGuidance.shotOrder, which is 1-based per ShotOrderItem's own convention. */
  beatIndexInScene?: number;
  /** Optional scene-level guidance from the AI Director (Phase 5). Entirely additive — see
   *  DirectorGuidance's doc comment. */
  directorGuidance?: DirectorGuidance;
};

// ─── Shot planning ──────────────────────────────────────────────────────────────

export type ShotType =
  | "establishing"
  | "wide"
  | "medium"
  | "close_up"
  | "extreme_close_up"
  | "detail"
  | "reaction"
  | "cutaway"
  | "b_roll"
  | "archive_footage"
  | "overlay_shot"
  /* ── RONDE 157 §7 — the framings the vocabulary was missing ──────────────────────────────
   *
   * §7 asks for a shot vocabulary where each entry MEANS something rather than being another
   * string. `SHOT_SEMANTICS` in server/shotVocabulary.ts is where that meaning lives, and it is an
   * exhaustive Record over this union — so adding a member here without saying what it is for is a
   * type error rather than a gap somebody finds later.
   *
   * The five below fill real holes. `medium_wide` and `extreme_wide` are the steps between the
   * existing wide and medium, which a shot ladder needs to move gradually rather than jumping.
   * `overhead` and `aerial` are different things and are routinely confused: overhead looks DOWN
   * at a surface (a table, a document, a process), aerial looks ACROSS a landscape from height.
   * `pov` is the subject's own view, which no existing member expresses.
   */
  | "medium_wide"
  | "extreme_wide"
  | "overhead"
  | "aerial"
  | "pov";

export type ShotInstruction = {
  shotType: ShotType;
  reason: string;
};

// ─── Camera movement ────────────────────────────────────────────────────────────

export type CameraMovementType =
  | "ken_burns"
  | "zoom_in"
  | "zoom_out"
  | "slow_push"
  | "slow_pull"
  | "pan_left"
  | "pan_right"
  | "tilt_up"
  | "tilt_down"
  | "parallax"
  | "virtual_dolly"
  | "camera_drift"
  | "camera_hold";

export type CameraInstruction = {
  movement: CameraMovementType;
  /** 0..1 — how pronounced the movement is. Camera Hold is always intensity 0. */
  intensity: number;
  reason: string;
};

// ─── Transitions ────────────────────────────────────────────────────────────────

export type TransitionType =
  | "cut"
  | "fade"
  | "cross_dissolve"
  | "dip_to_black"
  | "dip_to_white"
  | "blur"
  | "motion_blur"
  | "flash"
  | "light_leak"
  | "film_burn"
  | "whip"
  | "slide"
  | "push"
  | "match_cut";

export type TransitionInstruction = {
  type: TransitionType;
  durationSec: number;
  reason: string;
};

// ─── Text / captions ────────────────────────────────────────────────────────────

export type CaptionType =
  | "title"
  | "subtitle"
  | "lower_third"
  | "date"
  | "location"
  | "statistic"
  | "quote"
  | "name"
  | "callout"
  | "timeline_label"
  | "chapter_title"
  | "animated_text";

export type CaptionAnimation = "typewriter" | "fade" | "slide" | "scale" | "blur" | "none";
export type CaptionPosition = "center" | "top" | "bottom" | "bottom-left" | "bottom-right" | "lower-third";

export type CaptionInstruction = {
  captionType: CaptionType;
  text: string;
  subtitle?: string;
  startSec: number;
  endSec: number;
  animation: CaptionAnimation;
  position: CaptionPosition;
  reason: string;
};

// ─── Motion graphics ────────────────────────────────────────────────────────────

export type MotionGraphicType =
  | "progress_bar"
  | "statistic_counter"
  | "map"
  | "timeline"
  | "chart"
  | "comparison"
  | "animated_icon"
  | "highlight_box"
  | "arrow";

export type MotionGraphicInstruction = {
  graphicType: MotionGraphicType;
  /** Opaque, graphic-specific payload (e.g. counter's fromValue/toValue/suffix, map's
   *  locationName/normX/normY, chart's series) — deliberately untyped here since each
   *  graphic type's data shape is unrelated to the others; consumers narrow by graphicType. */
  data: Record<string, unknown>;
  startSec: number;
  durationSec: number;
  reason: string;
};

// ─── Visual effects ─────────────────────────────────────────────────────────────

export type VisualEffectType =
  | "glow"
  | "film_grain"
  | "vignette"
  | "noise"
  | "particles"
  | "dust"
  | "lens_flare"
  | "bloom"
  | "chromatic_aberration"
  | "letterbox";

export type EffectInstruction = {
  effectType: VisualEffectType;
  /** 0..1 — how strong the effect is applied. */
  intensity: number;
  reason: string;
};

// ─── Sound effects ──────────────────────────────────────────────────────────────

export type SoundEffectType =
  | "camera_click"
  | "whoosh"
  | "hit"
  | "impact"
  | "typing"
  | "crowd"
  | "applause"
  | "cash_register"
  | "notification"
  | "heartbeat"
  | "wind"
  | "rain"
  | "fire"
  | "explosion"
  | "page_turn"
  | "keyboard"
  | "ui_click";

export type SoundInstruction = {
  soundType: SoundEffectType;
  timeSec: number;
  /** 0..1 */
  volume: number;
  fadeInSec: number;
  fadeOutSec: number;
  reason: string;
};

// ─── Emotional pacing ───────────────────────────────────────────────────────────

export type EmotionalTone = "dramatic" | "exciting" | "educational" | "neutral";

export type PacingProfile = {
  tone: EmotionalTone;
  /** Relative cut speed multiplier — <1 slower/longer holds, >1 faster/shorter holds. */
  cutSpeedMultiplier: number;
  /** 0..1 — how much camera/transition movement intensity this tone calls for. */
  movementIntensity: number;
  reason: string;
};

// ─── Timing / clip ──────────────────────────────────────────────────────────────

export type ClipInstruction = {
  candidateId: string;
  assetType: CandidateAsset["assetType"];
  localPath: string | null;
  remoteUrl: string | null;
  /** Seconds into the source asset where the used portion starts (0 for images / untrimmed). */
  trimStartSec: number;
  /** Seconds into the source asset where the used portion ends. */
  trimEndSec: number;
  /**
   * This clip's position on the SCENE's timeline, seconds — not the beat's, and not the video's.
   *
   * RONDE 150 corrected this comment, which used to claim "0-based". It is only 0-based when the
   * beat itself starts at 0: `planClipTiming` hands `beatVoiceStartSec` (documented on
   * `CinematicEditingInput` as "within the scene") to `planSubBeatCuts`, which starts counting
   * there. Anything turning these into whole-video times therefore adds ONE offset, the scene's.
   */
  startSec: number;
  endSec: number;
  timingSource: "tts_word_alignment" | "proportional_estimate";
};

// ─── Edit Decision List ─────────────────────────────────────────────────────────

/** One complete editing decision for one beat — every planner's output combined. This is
 *  the atomic unit of the EDL; a scene with N sub-beat cuts produces N of these. */
export type EditDecision = {
  beatId: string;
  sceneIndex: number;
  clip: ClipInstruction;
  shot: ShotInstruction;
  camera: CameraInstruction;
  /** The transition INTO this decision from the previous one. Always present — the first
   *  decision in a scene gets a real (reasoned) "cut, nothing to transition from" instruction
   *  rather than a null, so "every edit must have a reason" holds without a special case. */
  transitionIn: TransitionInstruction;
  captions: CaptionInstruction[];
  motionGraphics: MotionGraphicInstruction[];
  effects: EffectInstruction[];
  sounds: SoundInstruction[];
  pacing: PacingProfile;
};

export type EDL = {
  sceneIndex: number;
  decisions: EditDecision[];
  totalDurationSec: number;
};
