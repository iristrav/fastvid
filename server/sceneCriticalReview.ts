/**
 * Critical per-scene QA — voice/visual match, motion graphics, still style, transitions.
 */
import * as path from "path";
import { PIPELINE_ERROR, pipelineError } from "@shared/appErrors";
import { autoMotionGraphicsLayerEnabled, framedArchiveStillsEnabled } from "./sourcingPolicy";
import {
  planMotionGraphicsScene,
  STANDARD_TRANSITION,
} from "./motionGraphicsLayer";
import { auditMotionGraphicsCoverage } from "./vidrushQuality";
import {
  minClipQualityScore,
  sceneCriticalReviewEnabled,
  scoreAdoptedClipQuality,
} from "./visualQualityGate";

export type ClipCriticalReviewInput = {
  sceneIndex: number;
  beatIndex: number;
  clipIndex: number;
  clipPath: string;
  beatText: string;
  visualDescription?: string;
  keywords?: string[];
  searchQuery?: string;
  powerWord?: string;
  highlightWords?: string[];
  videoTitle?: string;
  workDir: string;
};

export type ClipCriticalReviewResult = {
  clipIndex: number;
  beatIndex: number;
  clipPath: string;
  score: number | null;
  pass: boolean;
  isStill: boolean;
  issues: string[];
};

export type SceneCriticalReviewResult = {
  ok: boolean;
  clipResults: ClipCriticalReviewResult[];
  motionOverlayIssues: string[];
  summary: string;
};

const STOCK_STILL_RE =
  /_serp_|_wiki_|_openverse_|_unsplash_|_p0_|_p2_|_yt_\d/i;

export function isLikelyStillClip(clipPath: string): boolean {
  const base = path.basename(clipPath).toLowerCase();
  if (/_curated_a\d+_still\.mp4$/i.test(base)) return true;
  return STOCK_STILL_RE.test(base);
}

function stillUsesDocumentaryStyle(clipPath: string): boolean {
  if (!isLikelyStillClip(clipPath)) return true;
  if (/_curated_a\d+_still\.mp4$/i.test(path.basename(clipPath))) {
    return framedArchiveStillsEnabled();
  }
  return false;
}

/** Review one adopted clip against narration and layout rules. */
export async function reviewClipCritical(
  input: ClipCriticalReviewInput
): Promise<ClipCriticalReviewResult> {
  const issues: string[] = [];
  const isStill = isLikelyStillClip(input.clipPath);
  let score: number | null = null;

  if (!input.visualDescription?.trim()) {
    issues.push("missing visual_description");
  }
  if ((input.keywords ?? []).filter((k) => k.trim().length >= 2).length < 1) {
    issues.push("missing keywords");
  }
  if (!input.searchQuery?.trim()) {
    issues.push("missing image_prompt/search query");
  }
  if (STANDARD_TRANSITION !== "crossfade") {
    issues.push(`transition must be crossfade (got ${STANDARD_TRANSITION})`);
  }

  if (isStill && !stillUsesDocumentaryStyle(input.clipPath)) {
    issues.push("still clip must use documentary blur-fill/mat framing (see archive still style)");
  }

  if (sceneCriticalReviewEnabled()) {
    const vision = await scoreAdoptedClipQuality(
      input.clipPath,
      input.beatText,
      input.visualDescription,
      input.videoTitle,
      input.workDir,
      input.sceneIndex,
      input.beatIndex
    );
    if (vision) {
      score = vision.score;
      if (vision.wrongSubject) issues.push("visual shows wrong subject vs narration");
      if (!vision.matchesNarration) issues.push("visual does not match voiceover");
      if (vision.score < minClipQualityScore()) {
        issues.push(`quality ${vision.score}/10 below target ${minClipQualityScore()}/10`);
      }
    }
  }

  const pass = issues.length === 0;
  if (!pass) {
    console.error(
      `[SceneCritical] Scene ${input.sceneIndex} beat ${input.beatIndex} clip "${path.basename(input.clipPath)}" FAIL: ${issues.join("; ")}` +
        (score != null ? ` (vision ${score}/10)` : "")
    );
  } else {
    console.log(
      `[SceneCritical] Scene ${input.sceneIndex} beat ${input.beatIndex} "${path.basename(input.clipPath)}" OK` +
        (score != null ? ` (${score}/10)` : "")
    );
  }

  return {
    clipIndex: input.clipIndex,
    beatIndex: input.beatIndex,
    clipPath: input.clipPath,
    score,
    pass,
    isStill,
    issues,
  };
}

/** Review all clips in a scene + motion-graphics coverage. */
export async function reviewSceneCritical(
  sceneIndex: number,
  sceneDuration: number,
  clips: string[],
  clipBeatIndices: number[],
  beats: Array<{
    index: number;
    text: string;
    searchQuery: string;
    powerWord: string;
    keywords: string[];
    holdSec: number;
    visualDescription?: string;
  }>,
  workDir: string,
  videoTitle?: string
): Promise<SceneCriticalReviewResult> {
  if (!sceneCriticalReviewEnabled()) {
    return {
      ok: true,
      clipResults: [],
      motionOverlayIssues: [],
      summary: "Scene critical review disabled",
    };
  }

  const clipResults: ClipCriticalReviewResult[] = [];
  for (let i = 0; i < clips.length; i++) {
    const beatIdx = clipBeatIndices[i] ?? i;
    const beat = beats.find((b) => b.index === beatIdx) ?? beats[i % Math.max(1, beats.length)];
    if (!beat) continue;
    clipResults.push(
      await reviewClipCritical({
        sceneIndex,
        beatIndex: beatIdx,
        clipIndex: i,
        clipPath: clips[i]!,
        beatText: beat.text,
        visualDescription: beat.visualDescription,
        keywords: beat.keywords,
        searchQuery: beat.searchQuery,
        powerWord: beat.powerWord,
        highlightWords: beat.keywords,
        videoTitle,
        workDir,
      })
    );
  }

  let motionOverlayIssues: string[] = [];
  if (autoMotionGraphicsLayerEnabled()) {
    const beatInputs = beats.map((b) => ({
      text: b.text,
      holdSec: b.holdSec,
      powerWord: b.powerWord,
      highlightWords: b.keywords,
    }));
    const visualDescription = beats.find((b) => b.visualDescription?.trim())?.visualDescription;
    const mgPlan = planMotionGraphicsScene(
      sceneIndex,
      0,
      sceneDuration,
      beatInputs,
      visualDescription
    );
    motionOverlayIssues = auditMotionGraphicsCoverage(beatInputs, mgPlan.overlays);
    for (const o of mgPlan.overlays) {
      if (o.position !== "bottom_left") {
        motionOverlayIssues.push(`overlay "${o.text}" position must be bottom_left`);
      }
    }
    if (mgPlan.transition !== "crossfade") {
      motionOverlayIssues.push(`scene transition must be crossfade`);
    }
    if (motionOverlayIssues.length > 0) {
      console.warn(
        `[SceneCritical] Scene ${sceneIndex} motion graphics: ${motionOverlayIssues.slice(0, 4).join("; ")}`
      );
    } else if (mgPlan.overlays.length > 0) {
      console.log(
        `[SceneCritical] Scene ${sceneIndex}: ${mgPlan.overlays.length} overlay(s) planned (bottom_left, crossfade)`
      );
    }
  }

  const failedClips = clipResults.filter((r) => !r.pass);
  if (autoMotionGraphicsLayerEnabled() && motionOverlayIssues.length > 0) {
    console.warn(
      `[SceneCritical] Scene ${sceneIndex}: on-screen text gaps — ${motionOverlayIssues.slice(0, 3).join("; ")}`
    );
  }
  const ok = failedClips.length === 0;
  const summary = ok
    ? `Scene ${sceneIndex}: ${clipResults.length} clip(s) passed critical review`
    : `Scene ${sceneIndex}: ${failedClips.length}/${clipResults.length} clip(s) failed critical review`;

  return { ok, clipResults, motionOverlayIssues, summary };
}

export function assertSceneCriticalReview(
  sceneIndex: number,
  result: SceneCriticalReviewResult
): void {
  if (result.ok) return;
  const failed = result.clipResults.filter((r) => !r.pass);
  const detail = failed
    .map((r) => `beat ${r.beatIndex}: ${r.issues.join(", ")}`)
    .join("; ");
  throw pipelineError(
    PIPELINE_ERROR.NO_SCENES,
    `Scene ${sceneIndex} critical review failed — ${detail}`
  );
}
