/** Modular pipeline — new-engine stage wrappers & orchestration (Phase 8).
 *
 *  Wires the Phase 3-7 engines together for real, one video at a time:
 *
 *    Visual Intelligence Engine (or legacy Media Search, adapted) -> (always) AI Director,
 *    whose judgment Editorial Review needs regardless of whether its guidance also feeds
 *    forward -> Cinematic Editing Engine (one EDL per scene) -> Editorial Review Engine (one
 *    review for the whole video) -> Professional Render Engine (one encode per approved scene).
 *
 *  Every external call is wrapped in `instrumentStage()` (observability.ts) so production
 *  diagnostics and legacy-vs-new comparison work the moment this path is enabled — see that
 *  file's own doc comment for what "comparison" honestly means without live traffic.
 *
 *  ── A dependency this file makes explicit rather than silent ──────────────────────────────
 *  `editorialReviewEngineStageEnabled()` requires a real `DirectorOutput` (ReviewInputV2's
 *  `directorOutput` field is not optional) — so AI Director always runs whenever this whole
 *  chain runs, regardless of `aiDirectorStageEnabled()`. That flag's real effect is narrower
 *  than its name suggests: it only controls whether the Director's per-scene judgment is ALSO
 *  threaded into the Cinematic Editing Engine's `directorGuidance` hook (shot ordering, pacing
 *  tone). Documented here because silently computing something a flag claims to gate would be
 *  exactly the kind of undocumented behavior change this phase is required to avoid.
 *
 *  ── The audio gap this file closes, and the one it doesn't ────────────────────────────────
 *  Professional Render Engine (Phase 7) documented an honest gap: `planScene()` never
 *  populates `audioFilterComplex` (no SFX/voice asset-resolution wiring existed yet). Left
 *  unaddressed, wiring it in here would silently produce SILENT scene videos — a real
 *  regression, not an acceptable trade for "new architecture." `muxVoiceoverIntoVideo()` closes
 *  the essential gap (attaching the scene's actual voiceover track via a plain ffmpeg mux,
 *  `-c:v copy -c:a aac -shortest`) so a professional-render-engine-produced scene has the same
 *  audible narration a legacy-Render-Composer-produced scene has. It does NOT add SFX cues,
 *  music ducking, or volume automation — those remain the real gap flagged in Phase 7's own
 *  summary and in this phase's OUTPUT section; this is voice-passthrough only, clearly scoped.
 */
import * as fs from "fs";
import * as path from "path";
import { loadArchiveAssetFile } from "../archiveAssetLoad";
import type { Scene } from "../videoPipeline";
import { runV2Pipeline } from "../visualMatchingV2/v2Pipeline";
import type { CandidateAsset, VisualIntent } from "../visualMatchingV2/types";
import { generateEDL } from "../cinematicEditingEngine/edlGenerator";
import type { CinematicEditingInput, ClipInstruction, DirectorGuidance, EDL } from "../cinematicEditingEngine/types";
import { runAIDirector, toDirectorGuidance, type SceneInput as DirectorSceneInput } from "../aiDirector";
import { generateReviewReport, produceApprovedEDL } from "../editorialReviewEngineV2";
import type { ApprovedEDL, ReviewReport } from "../editorialReviewEngineV2/types";
import { dimensionsFor } from "../professionalRenderEngine/aspectRatio";
import { planScene, type ClipAssetResolver } from "../professionalRenderEngine/renderPlanner";
import { encode } from "../professionalRenderEngine/encoder";
import { mergeValidationResults, validateEDL, validateRenderPlan } from "../professionalRenderEngine/renderValidator";
import type { CommandExecutor, EncodeOptions, RenderPlan } from "../professionalRenderEngine/types";
import { archiveAssetRowToCandidateAsset, minimalVisualIntentFromScene, sceneBeatId, sceneToBeatInput } from "./adapters";
import { instrumentStage } from "./observability";
import { aiDirectorStageEnabled, visualIntelligenceEngineStageEnabled } from "./newEngineFlags";
import type { CuratedCandidatePick } from "./types";

// ─── Types ──────────────────────────────────────────────────────────────────────

export type NewPipelineSceneInput = {
  scene: Scene;
  audioPath: string;
  durationSec: number;
};

export type NewEnginePipelineOptions = {
  videoId: string;
  videoTitle: string;
  workDir: string;
  outputDir: string;
  correlationId: string;
  videoLength?: string | null;
  /** How to get a candidate for a scene when Visual Intelligence Engine is off — the
   *  orchestrator's own Media Search stage, injected so this file never imports it directly
   *  (avoids a dependency cycle and keeps this module testable without a real DB/search call). */
  legacyMediaSearch: (scene: Scene) => Promise<CuratedCandidatePick | null>;
  executor: CommandExecutor;
  encodeOptions?: Partial<Omit<EncodeOptions, "outputPath">>;
};

export type NewEnginePipelineSceneOutcome =
  | { sceneIndex: number; status: "rendered"; outputPath: string }
  | { sceneIndex: number; status: "fallback"; reason: string };

export type NewEnginePipelineResult = {
  outcomes: NewEnginePipelineSceneOutcome[];
  reviewReport: ReviewReport | null;
  approved: boolean;
};

const DEFAULT_ENCODE_OPTIONS: Omit<EncodeOptions, "outputPath"> = {
  useGpu: false,
  crf: 20,
  preset: "medium",
  maxRetries: 2,
};

// ─── Stage 1: candidate + intent resolution (per scene) ───────────────────────────

async function resolveCandidateAndIntent(
  scene: Scene,
  options: NewEnginePipelineOptions
): Promise<{ candidate: CandidateAsset; intent: VisualIntent; warnings: string[] }> {
  const warnings: string[] = [];

  if (visualIntelligenceEngineStageEnabled()) {
    const v2Result = await instrumentStage(options.correlationId, "new", "visual_intelligence", async () => {
      const result = await runV2Pipeline(options.videoId, options.videoTitle, [sceneToBeatInput(scene)], {
        workDir: options.workDir,
        sceneIndex: scene.index,
        videoLength: options.videoLength,
      });
      return { value: result, outputSummary: `${result.beatResults.length} beat(s) processed for scene ${scene.index}` };
    });

    const beatResult = v2Result.beatResults[0];
    const selected = beatResult?.selectionResult.selectedCandidate?.candidate.candidate;
    if (selected && beatResult) {
      return { candidate: selected, intent: beatResult.intent, warnings };
    }
    warnings.push(
      `Visual Intelligence Engine found no usable candidate for scene ${scene.index} — falling back to legacy Media Search`
    );
  }

  const pick = await instrumentStage(options.correlationId, "legacy", "media_search", async () => {
    const result = await options.legacyMediaSearch(scene);
    return { value: result, outputSummary: result ? `legacy candidate asset ${result.asset.id}` : "no candidate found" };
  });

  if (!pick) {
    throw new Error(`No visual candidate available for scene ${scene.index} (Visual Intelligence Engine and legacy Media Search both empty)`);
  }

  return { candidate: archiveAssetRowToCandidateAsset(pick), intent: minimalVisualIntentFromScene(scene), warnings };
}

// ─── Stage 2: AI Director (always, once per video — see file doc comment) ─────────

async function computeDirectorGuidanceMap(
  sceneInputs: NewPipelineSceneInput[],
  intentsByScene: Map<number, VisualIntent>,
  options: NewEnginePipelineOptions
): Promise<{ directorOutput: Awaited<ReturnType<typeof runAIDirector>>; guidanceByScene: Map<number, DirectorGuidance> }> {
  return instrumentStage(options.correlationId, "new", "ai_director", async () => {
    const directorInputs: DirectorSceneInput[] = sceneInputs.map(({ scene, durationSec }) => ({
      scene,
      beatIntents: [intentsByScene.get(scene.index)!],
      durationSec,
    }));
    const directorOutput = runAIDirector(directorInputs);

    const guidanceByScene = new Map<number, DirectorGuidance>();
    directorOutput.decisions.forEach((decision, i) => {
      const sceneIndex = sceneInputs[i]!.scene.index;
      guidanceByScene.set(sceneIndex, toDirectorGuidance(decision));
    });

    return {
      value: { directorOutput, guidanceByScene },
      outputSummary: `${directorOutput.decisions.length} scene decision(s), ${directorOutput.highlightMoments.length} highlight(s)`,
    };
  });
}

// ─── Stage 3: Cinematic Editing Engine (per scene) ─────────────────────────────────

async function buildSceneEDL(
  input: NewPipelineSceneInput,
  candidate: CandidateAsset,
  intent: VisualIntent,
  directorGuidance: DirectorGuidance | undefined,
  options: NewEnginePipelineOptions
): Promise<EDL> {
  return instrumentStage(options.correlationId, "new", "cinematic_editing", async () => {
    const editingInput: CinematicEditingInput = {
      scene: input.scene,
      intent,
      bestCandidate: candidate,
      beatVoiceStartSec: 0,
      beatVoiceDurationSec: input.durationSec,
      beatIndexInScene: 0,
      directorGuidance: aiDirectorStageEnabled() ? directorGuidance : undefined,
    };
    const edl = generateEDL([editingInput]);
    return {
      value: edl,
      outputSummary: `scene ${input.scene.index}: ${edl.decisions.length} decision(s), ${edl.totalDurationSec.toFixed(1)}s`,
    };
  });
}

// ─── Stage 4: Editorial Review Engine (whole video, once) ─────────────────────────

async function reviewAndApprove(
  edls: EDL[],
  directorOutput: Awaited<ReturnType<typeof runAIDirector>>,
  options: NewEnginePipelineOptions
): Promise<{ report: ReviewReport; approvedEDL: ApprovedEDL | null }> {
  return instrumentStage(options.correlationId, "new", "editorial_review", async () => {
    const report = generateReviewReport({
      videoId: options.videoId,
      videoTitle: options.videoTitle,
      edls,
      directorOutput,
    });
    const approvedEDL = produceApprovedEDL(options.videoId, edls, report);
    return {
      value: { report, approvedEDL },
      outputSummary: `overallScore=${report.overallScore.toFixed(1)}, approvalStatus=${report.approvalStatus}`,
      warnings: approvedEDL === null ? [`Editorial Review rejected the video (${report.approvalStatus})`] : [],
    };
  });
}

// ─── Stage 5: Professional Render Engine (per approved scene) + voiceover mux ──────

function buildClipAssetResolver(candidate: CandidateAsset): ClipAssetResolver {
  return (_clip: ClipInstruction) => ({
    inputLabel: "0:v",
    sourceDims: candidate.width && candidate.height ? { width: candidate.width, height: candidate.height } : null,
  });
}

/** Resolves one candidate to a real local file path — direct pass-through when already local
 *  (most Visual Intelligence Engine source adapters download during search), or a real
 *  download via the existing, exported `loadArchiveAssetFile()` (archiveAssetLoad.ts) when
 *  only a remote URL is known (always true for the legacy-candidate adapter's output, since
 *  legacy DB rows reference R2/CDN storage, not a pre-downloaded temp file). */
async function materializeClipLocalPath(candidate: CandidateAsset): Promise<{ localPath: string; cleanup?: () => void } | null> {
  if (candidate.localPath) return { localPath: candidate.localPath };
  if (!candidate.remoteUrl) return null;

  const loaded = await loadArchiveAssetFile({
    storageUrl: candidate.remoteUrl,
    storageKey: null,
    mimeType: candidate.mimeType ?? (candidate.assetType === "image" ? "image/jpeg" : "video/mp4"),
    mediaType: candidate.assetType,
  });
  if (!loaded.ok) return null;
  return { localPath: loaded.result.localPath, cleanup: loaded.result.cleanup };
}

/** Real ffmpeg mux — attaches the scene's voiceover track to the (video-only) Professional
 *  Render Engine output. `-c:v copy` avoids a redundant re-encode of video Professional Render
 *  Engine already produced; `-shortest` matches the legacy Render Composer's own convention of
 *  never letting one track run past the other. */
export function buildVoiceoverMuxCommand(videoPath: string, audioPath: string, outputPath: string): string {
  return `ffmpeg -y -i "${videoPath}" -i "${audioPath}" -c:v copy -c:a aac -shortest "${outputPath}"`;
}

async function muxVoiceoverIntoVideo(
  videoOnlyPath: string,
  audioPath: string,
  finalOutputPath: string,
  executor: CommandExecutor
): Promise<void> {
  await executor(buildVoiceoverMuxCommand(videoOnlyPath, audioPath, finalOutputPath));
}

async function renderSceneWithProfessionalEngine(
  approvedEDL: ApprovedEDL,
  sceneEdl: EDL,
  candidate: CandidateAsset,
  input: NewPipelineSceneInput,
  options: NewEnginePipelineOptions
): Promise<string> {
  return instrumentStage(options.correlationId, "new", "professional_render", async () => {
    const aspectRatio = "16:9" as const;
    const dims = dimensionsFor(aspectRatio);
    const resolveClipAsset = buildClipAssetResolver(candidate);

    // Scoped down to this one scene's EDL, but keeps the whole-video review/approvedAt stamp —
    // this isn't a second, separate approval, just a single-scene VIEW of the one already
    // produced by reviewAndApprove() for the whole video.
    const singleSceneApproved: ApprovedEDL = { ...approvedEDL, edls: [sceneEdl] };

    const scenePlan = planScene(sceneEdl, aspectRatio, dims, resolveClipAsset);
    const plan: RenderPlan = {
      videoId: options.videoId,
      aspectRatio,
      dimensions: dims,
      scenes: [scenePlan],
      totalDurationSec: scenePlan.durationSec,
    };
    const combined = mergeValidationResults(
      validateEDL(singleSceneApproved),
      validateRenderPlan(singleSceneApproved, plan)
    );
    if (!combined.isValid) {
      throw new Error(
        `Scene ${input.scene.index} render plan failed validation: ${combined.issues.map((i) => i.description).join("; ")}`
      );
    }

    const materialized = await materializeClipLocalPath(candidate);
    if (!materialized) {
      throw new Error(`Scene ${input.scene.index}: could not resolve a local file for candidate ${candidate.candidateId}`);
    }

    try {
      const videoOnlyPath = path.join(options.workDir, `scene_${input.scene.index}_video_only.mp4`);
      const encodeOptions: EncodeOptions = {
        ...DEFAULT_ENCODE_OPTIONS,
        ...options.encodeOptions,
        outputPath: videoOnlyPath,
      };
      const encodeResult = await encode(plan, [materialized.localPath], encodeOptions, options.executor);
      if (!encodeResult.succeeded) {
        const lastAttempt = encodeResult.attempts[encodeResult.attempts.length - 1];
        throw new Error(`Scene ${input.scene.index} encode failed: ${lastAttempt?.error ?? "unknown error"}`);
      }

      const finalOutputPath = path.join(options.outputDir, `scene_${input.scene.index}.mp4`);
      fs.mkdirSync(options.outputDir, { recursive: true });
      await muxVoiceoverIntoVideo(videoOnlyPath, input.audioPath, finalOutputPath, options.executor);

      return { value: finalOutputPath, outputSummary: `scene ${input.scene.index} rendered to ${finalOutputPath}` };
    } finally {
      materialized.cleanup?.();
    }
  });
}

// ─── Orchestration ──────────────────────────────────────────────────────────────

/** Runs the full new-engine chain for every scene in one video. Returns a per-scene outcome
 *  (`"rendered"` with the real output path, or `"fallback"` with the reason) so the caller
 *  (orchestrator.ts) can render any `"fallback"` scene through the existing, untouched legacy
 *  loop — isolating a failure in this chain to just the scenes it affects, never the whole
 *  video, per "one failed stage must not corrupt unrelated stages." A whole-video Editorial
 *  Review rejection marks every scene as a fallback (there is no per-scene ApprovedEDL to
 *  render from), which is the intended, documented behavior of "any regression must block
 *  further migration" — a rejected review blocks the new render path for this video entirely,
 *  not silently for a subset of scenes. */
export async function runNewEnginePipelineForScenes(
  sceneInputs: NewPipelineSceneInput[],
  options: NewEnginePipelineOptions
): Promise<NewEnginePipelineResult> {
  const candidatesByScene = new Map<number, CandidateAsset>();
  const intentsByScene = new Map<number, VisualIntent>();
  const edlsByScene = new Map<number, EDL>();
  const fallbackReasons = new Map<number, string>();

  // Stage 1: resolve a candidate + intent for every scene (sequential — visualMatchingV2's own
  // pipeline is beat-serial by design to stay within LLM Vision rate limits).
  for (const input of sceneInputs) {
    try {
      const { candidate, intent, warnings } = await resolveCandidateAndIntent(input.scene, options);
      candidatesByScene.set(input.scene.index, candidate);
      intentsByScene.set(input.scene.index, intent);
      if (warnings.length > 0) {
        console.warn(`[NewEnginePipeline] scene ${input.scene.index}: ${warnings.join("; ")}`);
      }
    } catch (err) {
      fallbackReasons.set(input.scene.index, `candidate resolution failed: ${(err as Error).message}`);
    }
  }

  const resolvedScenes = sceneInputs.filter((s) => candidatesByScene.has(s.scene.index));

  // Stage 2: AI Director — always, once per video (see file doc comment).
  let directorOutput: Awaited<ReturnType<typeof runAIDirector>> | null = null;
  let guidanceByScene = new Map<number, DirectorGuidance>();
  if (resolvedScenes.length > 0) {
    try {
      const result = await computeDirectorGuidanceMap(resolvedScenes, intentsByScene, options);
      directorOutput = result.directorOutput;
      guidanceByScene = result.guidanceByScene;
    } catch (err) {
      // AI Director failing blocks the whole chain — Editorial Review cannot run without it.
      for (const input of resolvedScenes) {
        fallbackReasons.set(input.scene.index, `AI Director failed: ${(err as Error).message}`);
      }
    }
  }

  // Stage 3: Cinematic Editing Engine — per scene, only for scenes that survived stages 1-2.
  const scenesForEDL = resolvedScenes.filter((s) => !fallbackReasons.has(s.scene.index));
  for (const input of scenesForEDL) {
    try {
      const candidate = candidatesByScene.get(input.scene.index)!;
      const intent = intentsByScene.get(input.scene.index)!;
      const guidance = guidanceByScene.get(input.scene.index);
      const edl = await buildSceneEDL(input, candidate, intent, guidance, options);
      edlsByScene.set(input.scene.index, edl);
    } catch (err) {
      fallbackReasons.set(input.scene.index, `Cinematic Editing Engine failed: ${(err as Error).message}`);
    }
  }

  // Stage 4: Editorial Review Engine — whole video, once, over every scene that has an EDL.
  const edls = sceneInputs
    .filter((s) => edlsByScene.has(s.scene.index))
    .map((s) => edlsByScene.get(s.scene.index)!);

  let reviewReport: ReviewReport | null = null;
  let approvedEDL: ApprovedEDL | null = null;
  if (edls.length > 0 && directorOutput) {
    const { report, approvedEDL: approved } = await reviewAndApprove(edls, directorOutput, options);
    reviewReport = report;
    approvedEDL = approved;
    if (!approved) {
      for (const edl of edls) {
        fallbackReasons.set(edl.sceneIndex, `Editorial Review rejected the video (${report.approvalStatus})`);
      }
    }
  }

  // Stage 5: Professional Render Engine — per scene, only for scenes with an ApprovedEDL entry.
  const outcomes: NewEnginePipelineSceneOutcome[] = [];
  for (const input of sceneInputs) {
    const sceneIndex = input.scene.index;
    if (fallbackReasons.has(sceneIndex) || !approvedEDL) {
      outcomes.push({ sceneIndex, status: "fallback", reason: fallbackReasons.get(sceneIndex) ?? "no ApprovedEDL for this video" });
      continue;
    }
    const sceneEdl = approvedEDL.edls.find((e) => e.sceneIndex === sceneIndex);
    const candidate = candidatesByScene.get(sceneIndex);
    if (!sceneEdl || !candidate) {
      outcomes.push({ sceneIndex, status: "fallback", reason: "missing EDL or candidate after approval" });
      continue;
    }
    try {
      const outputPath = await renderSceneWithProfessionalEngine(approvedEDL, sceneEdl, candidate, input, options);
      outcomes.push({ sceneIndex, status: "rendered", outputPath });
    } catch (err) {
      outcomes.push({ sceneIndex, status: "fallback", reason: `Professional Render Engine failed: ${(err as Error).message}` });
    }
  }

  return { outcomes, reviewReport, approved: approvedEDL !== null };
}

// Re-exported so orchestrator.ts (Phase 8.5) doesn't need a second import line for a beat-id
// helper it already needs alongside this file's exports.
export { sceneBeatId };
