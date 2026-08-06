/** Professional Render Engine — types (Phase 7, "execute the plan, decide nothing").
 *
 *  Consumes the ApprovedEDL (Phase 6's output — an EDL that already passed Editorial Review)
 *  and produces a Render Plan, then FFmpeg filter graphs, then (eventually) an encoded video.
 *  Every type in this file describes EXECUTION, never a creative choice: there is no
 *  "which shot type" or "which emotion" field anywhere here — those already exist on the
 *  EditDecision this module reads. A renderer in this directory that finds itself needing to
 *  decide something creative is out of scope; it should read that decision from the EDL
 *  instead.
 *
 *  Every filter-string builder in this directory is a pure function: EditDecision field in,
 *  FFmpeg filter syntax string out. No file I/O, no ffmpeg process spawned — "filter graph
 *  generation must be testable without rendering" is true by construction, not by convention.
 */
import type { ApprovedEDL, EDL, EditDecision } from "../editorialReviewEngineV2/types";
import type {
  CameraInstruction,
  CaptionAnimation,
  CaptionInstruction,
  CaptionPosition,
  CaptionType,
  ClipInstruction,
  EffectInstruction,
  MotionGraphicInstruction,
  MotionGraphicType,
  SoundInstruction,
  TransitionInstruction,
  TransitionType,
  VisualEffectType,
} from "../cinematicEditingEngine/types";

export type { ApprovedEDL, EDL, EditDecision };
export type {
  CameraInstruction,
  CaptionAnimation,
  CaptionInstruction,
  CaptionPosition,
  CaptionType,
  ClipInstruction,
  EffectInstruction,
  MotionGraphicInstruction,
  MotionGraphicType,
  SoundInstruction,
  TransitionInstruction,
  TransitionType,
  VisualEffectType,
};

// ─── Output format ──────────────────────────────────────────────────────────────

export type AspectRatioName = "16:9" | "9:16" | "1:1";

export type Dimensions = { width: number; height: number };

// ─── Filter graph primitives ──────────────────────────────────────────────────────

/** One FFmpeg filter expression (no surrounding brackets/labels — pure filter syntax, e.g.
 *  `"zoompan=z='...':x='...':y='...':d=125:s=1920x1080:fps=25"`) plus why it's here. Every
 *  renderer in this directory returns these; filterGraphBuilder.ts is the only place that
 *  wires them into labeled `[in][out]filter` chain syntax. */
export type FilterFragment = {
  filter: string;
  reason: string;
};

/** A single labeled node in an FFmpeg filter_complex graph — filterGraphBuilder.ts's unit of
 *  output. `inputs`/`output` are stream labels without brackets (e.g. "0:v", "v1"); the
 *  builder adds the brackets when joining nodes into a filter_complex string. */
export type FilterGraphNode = {
  inputs: string[];
  filter: string;
  output: string;
};

// ─── Render steps / plan ────────────────────────────────────────────────────────

export type RenderStepType = "clip" | "transition" | "caption" | "motion_graphic" | "effect" | "audio";

/** One instruction's worth of rendering work — the Render Plan's atomic unit, one level below
 *  a full scene. Traces back to exactly one EditDecision (by beatId) so a validation failure
 *  or render error can always be attributed to the original EDL instruction. */
export type RenderStep = {
  stepType: RenderStepType;
  sceneIndex: number;
  beatId: string;
  description: string;
  filterFragments: FilterFragment[];
  startSec: number;
  endSec: number;
};

export type SceneRenderPlan = {
  sceneIndex: number;
  steps: RenderStep[];
  /** The fully assembled FFmpeg `-filter_complex` string for this scene, chaining every
   *  beat's clip/camera/caption/graphic/effect filters and the transitions between them —
   *  timelineRenderer.ts's output. */
  filterComplex: string;
  /** The final labeled output stream this scene's filter_complex produces, e.g. "vout". */
  outputLabel: string;
  audioFilterComplex: string;
  audioOutputLabel: string;
  durationSec: number;
};

export type RenderPlan = {
  videoId: string;
  aspectRatio: AspectRatioName;
  dimensions: Dimensions;
  scenes: SceneRenderPlan[];
  totalDurationSec: number;
};

// ─── Validation ─────────────────────────────────────────────────────────────────

export type ValidationIssueType =
  | "missing_clip"
  | "overlapping_edit"
  | "invalid_timestamp"
  | "broken_transition"
  | "invalid_filter"
  | "audio_desync"
  | "missing_caption";

export type ValidationSeverity = "error" | "warning";

export type ValidationIssue = {
  type: ValidationIssueType;
  severity: ValidationSeverity;
  sceneIndex?: number;
  beatId?: string;
  description: string;
};

export type ValidationResult = {
  isValid: boolean;
  issues: ValidationIssue[];
};

// ─── Encoding ────────────────────────────────────────────────────────────────────

/** Injected, never called directly by anything in this directory except encoder.ts — every
 *  test mocks this instead of spawning a real ffmpeg process, the same "mock the sibling
 *  exec call" convention already established across this codebase's own test suite. */
export type CommandExecutor = (command: string) => Promise<{ stdout: string; stderr: string }>;

export type EncodeOptions = {
  outputPath: string;
  useGpu: boolean;
  crf: number;
  preset: string;
  maxRetries: number;
};

export type EncodeAttempt = {
  attempt: number;
  succeeded: boolean;
  error?: string;
  durationMs: number;
};

export type EncodeResult = {
  outputPath: string;
  succeeded: boolean;
  attempts: EncodeAttempt[];
  usedGpu: boolean;
};

// ─── Render result / export ─────────────────────────────────────────────────────

export type RenderResult = {
  videoId: string;
  succeeded: boolean;
  validation: ValidationResult;
  plan: RenderPlan | null;
  encode: EncodeResult | null;
  durationMs: number;
};

export type ExportRequest = {
  videoId: string;
  approvedEDL: ApprovedEDL;
  formats: AspectRatioName[];
  outputDir: string;
};

export type ExportFormatResult = {
  format: AspectRatioName;
  result: RenderResult;
};

export type ExportResult = {
  videoId: string;
  formats: ExportFormatResult[];
  allSucceeded: boolean;
};
