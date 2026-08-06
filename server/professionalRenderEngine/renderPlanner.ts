/** Professional Render Engine — Render Planner (Phase 7).
 *
 *  The top-level orchestrator that turns an Approved EDL into a RenderPlan by calling every
 *  other renderer in this directory — it makes no creative decisions of its own (no shot,
 *  pacing, caption, or effect choice happens here; those already exist on the EditDecision).
 *  Its only job is deciding WHICH renderer to call for each EditDecision field and assembling
 *  the results, exactly matching this phase's "the renderer must only execute instructions"
 *  requirement.
 *
 *  `ClipInstruction`/`SoundInstruction` describe WHICH candidate asset or sound cue to use, but
 *  neither carries a resolved FFmpeg input stream label — that mapping (which `-i` input index
 *  a given candidateId ended up at, and that candidate's own pixel dimensions) only exists once
 *  real files have been downloaded and fed to ffmpeg, which is out of scope for a pure
 *  filter-string module. `ClipAssetResolver` is the injected seam for that, mirroring
 *  `CommandExecutor`'s injection for encoder.ts (task #118) — tests supply a fake resolver
 *  instead of touching the filesystem.
 *
 *  Motion graphics that need a pre-rendered image asset (map/timeline/animated_icon — see
 *  motionGraphicsRenderer.ts's `requiresImageAsset()`) are planned as a RenderStep with no
 *  filter fragments yet, for traceability — wiring in the actual `renderImageOverlayNode()`
 *  call needs a resolved PNG path, the same asset-resolution gap as clips, and stays future
 *  work rather than being faked here. Sound cues have the identical gap (no asset library
 *  exists in this codebase for SFX audio files yet — confirmed by this phase's research), so a
 *  scene's `audioFilterComplex` stays empty until that resolver exists; renderValidator.ts's
 *  `audio_desync` check correctly flags this as a real, honest gap rather than staying silent
 *  about it.
 */
import { dimensionsFor } from "./aspectRatio";
import { renderEffect } from "./effectsRenderer";
import { renderCameraMovement } from "./cameraRenderer";
import { renderCaption } from "./captionRenderer";
import { clipTimelineDurationSec, renderClip } from "./clipRenderer";
import { requiresImageAsset, renderMotionGraphicFragments } from "./motionGraphicsRenderer";
import { assembleSceneTimeline, type BeatRenderInput } from "./timelineRenderer";
import type {
  ApprovedEDL,
  AspectRatioName,
  ClipInstruction,
  Dimensions,
  EDL,
  EditDecision,
  FilterFragment,
  RenderStep,
  SceneRenderPlan,
  RenderPlan,
} from "./types";

export type ClipAssetResolver = (clip: ClipInstruction) => { inputLabel: string; sourceDims: Dimensions | null };

type DecisionPlan = { fragments: FilterFragment[]; steps: RenderStep[] };

/** Plans one beat's worth of work: calls clipRenderer/cameraRenderer/effectsRenderer/
 *  captionRenderer/motionGraphicsRenderer for every field on the EditDecision, in the visual
 *  order they should be chained — trim/scale, then camera movement, then color/grain/vignette
 *  style effects (so they grade the base image, not the overlays), then captions and motion
 *  graphics drawn last, on top. */
export function planEditDecision(
  decision: EditDecision,
  targetAspect: AspectRatioName,
  dims: Dimensions,
  resolveClipAsset: ClipAssetResolver
): DecisionPlan {
  const { beatId, sceneIndex, clip, camera, captions, motionGraphics, effects, sounds, transitionIn } = decision;
  const asset = resolveClipAsset(clip);
  const beatStart = clip.startSec;
  const beatEnd = clip.endSec;

  const clipFragments = renderClip(clip, targetAspect, asset.sourceDims);
  const cameraFragments = renderCameraMovement(camera, clipTimelineDurationSec(clip), dims);
  const effectFragments = effects.flatMap((e) => renderEffect(e));
  const captionFragments = captions.flatMap((c) => renderCaption(c));
  const graphicFragments = motionGraphics
    .filter((g) => !requiresImageAsset(g.graphicType))
    .flatMap((g) => renderMotionGraphicFragments(g, dims));

  const steps: RenderStep[] = [];

  steps.push({
    stepType: "clip",
    sceneIndex,
    beatId,
    description: `clip ${clip.candidateId} + camera ${camera.movement}`,
    filterFragments: [...clipFragments, ...cameraFragments],
    startSec: beatStart,
    endSec: beatEnd,
  });

  steps.push({
    stepType: "transition",
    sceneIndex,
    beatId,
    description: `transition in: ${transitionIn.type} (${transitionIn.durationSec}s) — actually joined by timelineRenderer.ts`,
    filterFragments: [],
    startSec: beatStart,
    endSec: beatStart,
  });

  for (const effect of effects) {
    steps.push({
      stepType: "effect",
      sceneIndex,
      beatId,
      description: `effect ${effect.effectType}`,
      filterFragments: renderEffect(effect),
      startSec: beatStart,
      endSec: beatEnd,
    });
  }

  for (const caption of captions) {
    steps.push({
      stepType: "caption",
      sceneIndex,
      beatId,
      description: `caption ${caption.captionType}: "${caption.text}"`,
      filterFragments: renderCaption(caption),
      startSec: caption.startSec,
      endSec: caption.endSec,
    });
  }

  for (const graphic of motionGraphics) {
    const needsAsset = requiresImageAsset(graphic.graphicType);
    steps.push({
      stepType: "motion_graphic",
      sceneIndex,
      beatId,
      description: needsAsset
        ? `motion graphic ${graphic.graphicType} (needs an image asset — not yet resolved)`
        : `motion graphic ${graphic.graphicType}`,
      filterFragments: needsAsset ? [] : renderMotionGraphicFragments(graphic, dims),
      startSec: graphic.startSec,
      endSec: graphic.startSec + graphic.durationSec,
    });
  }

  for (const sound of sounds) {
    steps.push({
      stepType: "audio",
      sceneIndex,
      beatId,
      description: `sound ${sound.soundType} (needs an SFX asset — not yet resolved)`,
      filterFragments: [],
      startSec: sound.timeSec,
      endSec: sound.timeSec + Math.max(0.35, sound.fadeInSec + sound.fadeOutSec),
    });
  }

  return {
    fragments: [...clipFragments, ...cameraFragments, ...effectFragments, ...captionFragments, ...graphicFragments],
    steps,
  };
}

/** Plans one scene: plans every beat's decision, then hands the per-beat fragments to
 *  timelineRenderer.ts to chain them together with the EDL's own transition choices. */
export function planScene(
  edl: EDL,
  targetAspect: AspectRatioName,
  dims: Dimensions,
  resolveClipAsset: ClipAssetResolver
): SceneRenderPlan {
  const allSteps: RenderStep[] = [];
  const beatInputs: BeatRenderInput[] = edl.decisions.map((decision) => {
    const { fragments, steps } = planEditDecision(decision, targetAspect, dims, resolveClipAsset);
    allSteps.push(...steps);
    const asset = resolveClipAsset(decision.clip);
    return {
      beatId: decision.beatId,
      inputLabel: asset.inputLabel,
      fragments,
      durationSec: clipTimelineDurationSec(decision.clip),
      transitionIn: decision.transitionIn,
    };
  });

  const timeline = assembleSceneTimeline(edl.sceneIndex, beatInputs);

  return {
    sceneIndex: edl.sceneIndex,
    steps: allSteps,
    filterComplex: timeline.filterComplex,
    outputLabel: timeline.outputLabel,
    audioFilterComplex: "",
    audioOutputLabel: "",
    durationSec: timeline.totalDurationSec,
  };
}

/** Plans the full RenderPlan for one output format — the entry point renderPlanner.ts exposes
 *  to exportManager.ts (task #119), one call per requested aspect ratio. */
export function planRender(approvedEdl: ApprovedEDL, targetAspect: AspectRatioName, resolveClipAsset: ClipAssetResolver): RenderPlan {
  const dims = dimensionsFor(targetAspect);
  const scenes = approvedEdl.edls.map((edl) => planScene(edl, targetAspect, dims, resolveClipAsset));
  const totalDurationSec = scenes.reduce((sum, s) => sum + s.durationSec, 0);

  return {
    videoId: approvedEdl.videoId,
    aspectRatio: targetAspect,
    dimensions: dims,
    scenes,
    totalDurationSec,
  };
}
