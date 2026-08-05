/** Cinematic Editing Engine — types (Phase 4, "AI video editor").
 *
 *  Every planner in this directory is a pure decision function: given already-resolved
 *  inputs (Scene, Visual Intent, Best Candidate, Timeline, Word Timestamps, Video Context,
 *  Visual Continuity — the literal Phase 4 INPUT list), it returns a typed instruction, never
 *  pixels/audio samples. Nothing in this directory renders anything. The instructions are
 *  assembled by edlGenerator.ts into one Edit Decision List (EDL) per scene — the contract a
 *  future renderer (Phase 5) will consume.
 *
 *  Every instruction type carries a `reason: string` field. This isn't decorative — it's the
 *  literal "NO RANDOMNESS: every edit must have a reason" requirement, made structurally
 *  impossible to skip.
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
  | "overlay_shot";

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
  /** This clip's position on the beat's own timeline, seconds (0-based, not the whole video). */
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
