/**
 * Shared contracts for the modular pipeline (Phase 2).
 *
 * Every stage module in server/pipeline/stages/ communicates through these types. Where a
 * type already exists in the legacy implementation (Scene, VideoBlueprint, VisualDedupState,
 * ...), it's imported and re-exported here rather than redefined — the stages are adapters
 * around the existing, proven logic, not rewrites, so their data shapes must stay identical to
 * what that logic actually produces/consumes.
 */
import { PIPELINE_ERROR } from "@shared/appErrors";
import type { EngineOutput, ScriptScene } from "../scriptEngine";
import type { ScriptLengthBudget } from "../scriptWriter";
import type {
  Scene,
  VisualDedupState,
  PipelinePerfProfile,
  ComposeSceneOptions,
} from "../videoPipeline";
import type { VideoBlueprint } from "../masterDocumentaryDirector";
import type {
  CuratedCandidatePick,
  CuratedBeatContext,
  CuratedSceneContext,
} from "../curatedMediaSourcing";
import type { ReorderResult } from "../editorialReorder";
import type { OptimizedSequence } from "../shotSequenceOptimizer";
import type { RhythmResult } from "../visualRhythmEngine";

export type {
  EngineOutput,
  ScriptScene,
  ScriptLengthBudget,
  Scene,
  VisualDedupState,
  PipelinePerfProfile,
  ComposeSceneOptions,
  VideoBlueprint,
  CuratedCandidatePick,
  CuratedBeatContext,
  CuratedSceneContext,
  ReorderResult,
  OptimizedSequence,
  RhythmResult,
};

/**
 * Generic per-stage result envelope. Every stage returns one of these instead of throwing
 * directly, so a failing stage never crashes an unrelated one — the caller (orchestrator)
 * decides whether/how to retry based on `retryable`, using the existing PIPELINE_ERROR codes
 * (shared/appErrors.ts) rather than inventing a new error taxonomy.
 */
export type StageError = {
  code: (typeof PIPELINE_ERROR)[keyof typeof PIPELINE_ERROR];
  message: string;
  cause?: unknown;
};

export type StageResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: StageError; retryable: boolean };

export function stageOk<T>(data: T): StageResult<T> {
  return { ok: true, data };
}

export function stageErr<T>(
  code: StageError["code"],
  message: string,
  retryable: boolean,
  cause?: unknown
): StageResult<T> {
  return { ok: false, error: { code, message, cause }, retryable };
}

/** Wraps a stage's async work, turning a thrown error into a structured StageResult instead of
 *  letting it propagate — the concrete mechanism behind "never crash unrelated stages." */
export async function runStage<T>(
  defaultErrorCode: StageError["code"],
  retryableByDefault: boolean,
  fn: () => Promise<T>
): Promise<StageResult<T>> {
  try {
    return stageOk(await fn());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return stageErr(defaultErrorCode, message, retryableByDefault, err);
  }
}

// ─── 1. Script Generator ────────────────────────────────────────────────────
export type ScriptGeneratorInput = {
  topic: string;
  videoType: string;
  videoLength: string;
  onProgress?: (step: string, percent: number) => void;
};
export type ScriptGeneratorOutput = EngineOutput;

// ─── 2. Voice Generator ─────────────────────────────────────────────────────
export type VoiceGeneratorInput = {
  scenes: Scene[];
  workDir: string;
  voiceId?: string;
  sourceScript?: string;
  onProgress?: (done: number, total: number) => void;
};
export type VoiceGeneratorOutput = {
  /** Per-scene audio file paths, same order/length as input scenes. */
  audioPaths: string[];
  /** Per-scene durations in seconds, same order/length as input scenes. */
  durations: number[];
};

// ─── 3. Scene Splitter ──────────────────────────────────────────────────────
export type SceneSplitterInput = {
  script: string;
  maxScenes: number;
  topicContext?: string;
};
export type SceneSplitterOutput = { scenes: Scene[] };

// ─── 4. Visual Planner ──────────────────────────────────────────────────────
/**
 * The subset of VisualDedupState a Visual Planner call needs/produces. The FULL
 * VisualDedupState is genuinely cross-cutting mutable state (accumulator sets/maps + a mutex)
 * that must stay the *same instance* threaded through every downstream stage call, by design —
 * it is not something each stage can safely reconstruct independently. Stage modules accept it
 * as an explicit parameter (not a captured module variable) so that dependency is visible in
 * every signature instead of hidden in shared ambient state.
 */
export type SharedVisualContext = VisualDedupState;

export type VisualPlannerInput = {
  videoId: string;
  videoTitle: string;
  videoLengthMin: number;
  scenes: Array<{ index: number; text: string; beats?: Array<{ index: number; text: string }> }>;
};
export type VisualPlannerOutput = { blueprint: VideoBlueprint };

// ─── 5. Media Search ────────────────────────────────────────────────────────
export type MediaSearchRequest = {
  beat: CuratedBeatContext;
  scene: CuratedSceneContext;
  usedAssetIds: Set<number>;
  usedStorageUrls: Set<string>;
  videoTitle?: string;
  varietySeed?: number;
  videoLength?: string | null;
};
export type MediaSearchResult = { candidates: CuratedCandidatePick[] };

// ─── 6. Timeline Builder ────────────────────────────────────────────────────
export type TimelineEntry = { sceneIndex: number; startSec: number; endSec: number };
export type Timeline = { entries: TimelineEntry[]; totalDurationSec: number };

// ─── 7. Effects Planner ─────────────────────────────────────────────────────
export type EffectsPlannerInput = {
  sceneIndex: number;
  sceneText: string;
  videoTitle: string;
  sceneDuration: number;
  clips: string[];
  beatDurations: number[];
  clipBeatIndices?: number[];
  beats?: Array<{ index: number; text: string; holdSec: number }>;
};
export type EffectsPlan = {
  clips: string[];
  beatDurations: number[];
  clipBeatIndices?: number[];
  reorder: ReorderResult;
  shotSequence: OptimizedSequence;
  rhythm: RhythmResult;
};

// ─── 8. Render Composer ─────────────────────────────────────────────────────
/** Render Composer wraps the existing compose functions as single units (see Phase 2 plan's
 *  Design Decision #2) — "instructions" here means "everything composeSceneVideoInner needs,"
 *  not a separately-executable command object. True build/execute separation is Phase 3. */
export type RenderInstructions = {
  scene: Scene;
  clips: string[];
  audioPath: string;
  duration: number;
  workDir: string;
  totalScenes: number;
  enableSubtitles?: boolean;
  rescueStockClip?: string | null;
  beatDurations?: number[];
  composeOptions?: ComposeSceneOptions;
};
export type RenderComposerResult = { outputPath: string };

// ─── 9. Video Renderer ──────────────────────────────────────────────────────
/** Raw ffmpeg process output — Video Renderer's job is exactly "run the command," so its
 *  result is exactly what the process produced, not a higher-level pipeline concept. */
export type FfmpegExecResult = { stdout: string; stderr: string };

// ─── 10. Upload Service ─────────────────────────────────────────────────────
export type UploadInput = { key: string; data: Buffer | Uint8Array | string; contentType: string };
export type UploadResult = { url: string; key: string };
