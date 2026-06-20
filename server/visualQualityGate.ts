/**
 * Local visual quality gate — CLIP text↔image similarity + luma (no LLM vision API).
 */
import fs from "fs";
import path from "path";
import { curatedClipPathAssetId } from "./curatedMediaSourcing";
import { loadStoredFrameEmbeddings } from "./archiveClipEmbedding";
import {
  LOCAL_FRAME_FRACTIONS,
  extractFrameAtFraction,
  getLocalVisionStatus,
  localVisionEnabled,
  scoreFramePathsAgainstBeat,
} from "./localClipVision";

export function clipVisionGateEnabled(): boolean {
  return localVisionEnabled();
}

/** Critical per-clip voice/visual QA (default on with Vidrush quality). */
export function sceneCriticalReviewEnabled(): boolean {
  if (process.env.ENABLE_SCENE_CRITICAL_REVIEW === "false") return false;
  return process.env.ENABLE_VIDRUSH_QUALITY !== "false";
}

/** Minimum vision score for Wikimedia/Openverse stills — same bar as archive (default 8). */
export function minWikiClipQualityScore(): number {
  const raw = process.env.MIN_WIKI_CLIP_QUALITY_SCORE?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 5 && n <= 10) return n;
  }
  return minClipQualityScore();
}

/** Minimum quality score (0–10). Default 8. */
export function minClipQualityScore(): number {
  const raw = process.env.MIN_CLIP_QUALITY_SCORE?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 5 && n <= 10) return n;
  }
  return 8;
}

/** When true, inconclusive local vision (CLIP load fail / no frames) rejects the clip. */
export function strictVisionInconclusiveFails(): boolean {
  if (process.env.STRICT_CLIP_VISION === "false") return false;
  if (process.env.STRICT_CLIP_VISION === "true") return true;
  return minClipQualityScore() >= 8;
}

/** Frames scored per clip (1–6). Default 4 across the full duration. */
export function clipVisionSampleCount(): number {
  const raw = process.env.CLIP_VISION_SAMPLE_COUNT?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 1 && n <= 6) return n;
  }
  return 4;
}

/** Runtime status for /api/health. */
export function getVisionQaStatus(): {
  ready: boolean;
  clipVisionGate: boolean;
  visionGeoGate: boolean;
  sceneCriticalReview: boolean;
  minScore: number;
  visionSamplesPerClip: number;
  strictInconclusive: boolean;
  llmKeyConfigured: boolean;
  llmProvider: "local-clip";
  localVision: ReturnType<typeof getLocalVisionStatus>;
  hint: string;
} {
  const localVision = getLocalVisionStatus();
  const clipVisionGate = clipVisionGateEnabled();
  const sceneCriticalReview = sceneCriticalReviewEnabled();
  const minScore = minClipQualityScore();
  const visionSamplesPerClip = clipVisionSampleCount();
  const strictInconclusive = strictVisionInconclusiveFails();
  const ready = clipVisionGate && sceneCriticalReview;

  let hint = localVision.hint;
  if (!clipVisionGate) {
    hint = "Local vision disabled — remove ENABLE_LOCAL_VISION=false if set.";
  } else if (!sceneCriticalReview) {
    hint = "Scene critical review disabled — remove ENABLE_SCENE_CRITICAL_REVIEW=false if set.";
  } else {
    hint += ` ${visionSamplesPerClip} frames/clip (2 on fast mode), pass ≥${minScore}/10.`;
  }

  return {
    ready,
    clipVisionGate,
    visionGeoGate: false,
    sceneCriticalReview,
    minScore,
    visionSamplesPerClip,
    strictInconclusive,
    llmKeyConfigured: false,
    llmProvider: "local-clip",
    localVision,
    hint,
  };
}

/** Every adopted montage clip must pass vision QA — all scenes, all sources. */
export function shouldVisionCheckClip(filePath: string, _fastMode = false): boolean {
  if (!localVisionEnabled()) return false;
  const base = path.basename(filePath).toLowerCase();
  if (
    /guaranteed|_guaranteed|_slot\d+_guaranteed|motion_graphic|_mgfx|_intro_card|_outro_card|silent\.mp4$/i.test(
      base
    )
  ) {
    return false;
  }
  return true;
}

function visionSampleFractions(fastMode = false): number[] {
  const count = fastMode ? Math.min(2, clipVisionSampleCount()) : clipVisionSampleCount();
  return LOCAL_FRAME_FRACTIONS.slice(0, count);
}

async function extractPreviewFrames(
  clipPath: string,
  workDir: string,
  sceneIndex: number,
  beatIndex: number,
  fastMode = false
): Promise<string[]> {
  const fractions = visionSampleFractions(fastMode);
  const paths: string[] = [];
  for (let i = 0; i < fractions.length; i++) {
    const outPath = path.join(
      workDir,
      `scene_${sceneIndex}_b${beatIndex}_lv${i}_${path.basename(clipPath).replace(/\.[^.]+$/, "")}.jpg`
    );
    const ok = await extractFrameAtFraction(clipPath, outPath, fractions[i]!);
    if (ok) paths.push(outPath);
  }
  return paths;
}

function cleanupFramePaths(framePaths: string[]): void {
  for (const fp of framePaths) {
    try { fs.unlinkSync(fp); } catch { /* ignore */ }
  }
}

/** Score multiple frames via local CLIP; all must pass for clip acceptance. */
async function scoreClipAcrossFrames(
  clipPath: string,
  beatText: string,
  visualDescription: string | undefined,
  videoTitle: string | undefined,
  workDir: string,
  sceneIndex: number,
  beatIndex: number,
  minScore: number,
  fastMode: boolean
): Promise<{ pass: boolean; worstScore: number | null; framesScored: number }> {
  const framePaths = await extractPreviewFrames(clipPath, workDir, sceneIndex, beatIndex, fastMode);
  if (framePaths.length === 0) {
    return { pass: !strictVisionInconclusiveFails(), worstScore: null, framesScored: 0 };
  }

  const assetId = curatedClipPathAssetId(clipPath);
  const storedEmbeddings =
    assetId != null ? loadStoredFrameEmbeddings(assetId) : undefined;

  const result = await scoreFramePathsAgainstBeat(
    framePaths,
    beatText,
    visualDescription,
    videoTitle,
    clipPath,
    minScore,
    storedEmbeddings
  );
  cleanupFramePaths(framePaths);

  if (!result) {
    return { pass: !strictVisionInconclusiveFails(), worstScore: null, framesScored: 0 };
  }

  const worstScore10 = Math.max(0, Math.min(10, Math.round(result.worstSimilarity * 40)));
  const pass =
    result.framesScored > 0 &&
    result.matchesNarration &&
    result.showsSubject &&
    !result.wrongSubject &&
    result.wellFramed &&
    worstScore10 >= minScore &&
    result.score >= minScore;

  return {
    pass,
    worstScore: worstScore10,
    framesScored: result.framesScored,
  };
}

/** Returns true when clip passes local vision gate (or gate skipped). */
export async function clipPassesVisionGate(
  clipPath: string,
  beatText: string,
  videoTitle: string | undefined,
  workDir: string,
  sceneIndex: number,
  beatIndex: number,
  fastMode: boolean,
  minScore = minClipQualityScore(),
  visualDescription?: string,
  _segmentLock?: unknown
): Promise<boolean> {
  if (!clipVisionGateEnabled() || !shouldVisionCheckClip(clipPath, fastMode)) return true;

  const result = await scoreClipAcrossFrames(
    clipPath,
    beatText,
    visualDescription,
    videoTitle,
    workDir,
    sceneIndex,
    beatIndex,
    minScore,
    fastMode
  );

  if (!result.pass) {
    console.warn(
      `[LocalVision] Scene ${sceneIndex} beat ${beatIndex}: reject "${path.basename(clipPath)}" ` +
        `(${result.framesScored} frames, worst=${result.worstScore ?? "?"}/10 avg needed ≥${minScore})`
    );
  }
  return result.pass;
}

/** Score clip against narration for post-adoption QA (returns null when local vision unavailable). */
export async function scoreAdoptedClipQuality(
  clipPath: string,
  beatText: string,
  visualDescription: string | undefined,
  videoTitle: string | undefined,
  workDir: string,
  sceneIndex: number,
  beatIndex: number,
  fastMode = false
): Promise<{
  score: number;
  matchesNarration: boolean;
  showsSubject: boolean;
  wellFramed: boolean;
  wrongSubject: boolean;
} | null> {
  if (!clipVisionGateEnabled() || !shouldVisionCheckClip(clipPath)) return null;

  const framePaths = await extractPreviewFrames(clipPath, workDir, sceneIndex, beatIndex, fastMode);
  if (framePaths.length === 0) return null;

  const assetId = curatedClipPathAssetId(clipPath);
  const storedEmbeddings =
    assetId != null ? loadStoredFrameEmbeddings(assetId) : undefined;

  const result = await scoreFramePathsAgainstBeat(
    framePaths,
    beatText,
    visualDescription,
    videoTitle,
    clipPath,
    minClipQualityScore(),
    storedEmbeddings
  );
  cleanupFramePaths(framePaths);

  if (!result) return null;

  return {
    score: result.score,
    matchesNarration: result.matchesNarration,
    showsSubject: result.showsSubject,
    wellFramed: result.wellFramed,
    wrongSubject: result.wrongSubject,
  };
}
