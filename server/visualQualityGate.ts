/**
 * Local visual quality gate — CLIP text↔image similarity + luma (no LLM vision API).
 */
import fs from "fs";
import path from "path";
import { curatedClipPathAssetId } from "./curatedMediaSourcing";
import { strictVoiceVisualMatchEnabled, isFastShortVideoLength } from "./sourcingPolicy";
import { loadStoredFrameEmbeddings } from "./archiveClipEmbedding";
import { loadStoredStockFrameEmbeddingsFromPath } from "./stockClipEmbedding";
import {
  LOCAL_FRAME_FRACTIONS,
  ensureClipPipelinesLoaded,
  extractFrameAtFraction,
  getLocalVisionStatus,
  localVisionEnabled,
  probeImageMeanLuma,
  resolveBeatQueryEmbedding,
  scoreEmbeddingsAgainstBeat,
  scoreFramePathsAgainstBeat,
} from "./localClipVision";

const VISION_GATE_CACHE_MAX = 512;
const visionGateCache = new Map<string, boolean>();

function visionGateCacheKey(
  clipPath: string,
  beatText: string,
  minScore: number,
  visualDescription?: string
): string {
  return `${path.basename(clipPath)}|${minScore}|${beatText.slice(0, 120)}|${(visualDescription ?? "").slice(0, 80)}`;
}

function rememberVisionGateResult(key: string, pass: boolean): void {
  if (visionGateCache.size >= VISION_GATE_CACHE_MAX) {
    const oldest = visionGateCache.keys().next().value;
    if (oldest) visionGateCache.delete(oldest);
  }
  visionGateCache.set(key, pass);
}

export function clipVisionGateEnabled(): boolean {
  return localVisionEnabled();
}

/** 1-frame-first cascade before full multi-frame scoring (default on). */
export function cascadeVisionGateEnabled(): boolean {
  if (process.env.ENABLE_CASCADE_VISION_GATE === "false") return false;
  return localVisionEnabled();
}

export function cascadeVisionExpandBelow(minScore: number): number {
  return Math.max(5, minScore - 2);
}

const CASCADE_PRIMARY_FRAME_FRAC = 0.38;

/** Critical per-clip voice/visual QA — skipped on 1-min fast path for speed. */
export function sceneCriticalReviewEnabled(videoLength?: string | null): boolean {
  if (isFastShortVideoLength(videoLength)) return false;
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

/** Minimum quality score (0–10). Default 7 — balanced hit-rate vs speed on 1-min. */
export function minClipQualityScore(): number {
  const raw = process.env.MIN_CLIP_QUALITY_SCORE?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 5 && n <= 10) return n;
  }
  return 7;
}

/** When true, inconclusive local vision (CLIP load fail / no frames) rejects the clip. */
export function strictVisionInconclusiveFails(fastMode = false): boolean {
  if (strictVoiceVisualMatchEnabled()) return true;
  if (fastMode) return false;
  if (process.env.STRICT_CLIP_VISION === "false") return false;
  if (process.env.STRICT_CLIP_VISION === "true") return true;
  return minClipQualityScore() >= 8;
}

/** Min CLIP score — no fast-path relaxation when strict voice↔visual match is on. */
export function effectiveMinClipQualityScore(fastMode = false, shortVideo = false): number {
  if (strictVoiceVisualMatchEnabled()) return minClipQualityScore();
  if (fastMode && shortVideo) return Math.min(minClipQualityScore(), 7);
  if (fastMode) return Math.min(minClipQualityScore(), 7);
  return minClipQualityScore();
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

/**
 * Fraction of preview frames scored per clip (0.5–1).
 * Default 0.8 → 3/4 frames (or 1/2 in fast mode) with the same ≥8/10 pass bar.
 */
export function clipVisionFrameCoverage(fastMode = false, shortVideo = false): number {
  const raw = process.env.CLIP_VISION_COVERAGE?.trim();
  if (raw) {
    const n = parseFloat(raw);
    if (!isNaN(n) && n >= 0.5 && n <= 1) return n;
  }
  if (shortVideo && fastMode) return 0.35;
  if (strictVoiceVisualMatchEnabled()) return 0.8;
  return fastMode ? 0.5 : 0.8;
}

/** Effective frame count after CLIP_VISION_COVERAGE (same min score on worst sampled frame). */
export function effectiveVisionSampleCount(fastMode = false, shortVideo = false): number {
  if (shortVideo && fastMode) return 1;
  const base = fastMode ? Math.min(2, clipVisionSampleCount()) : clipVisionSampleCount();
  const coverage = clipVisionFrameCoverage(fastMode, shortVideo);
  if (fastMode) {
    return Math.max(1, Math.floor(base * coverage + 0.001));
  }
  return Math.max(1, Math.min(base, Math.round(base * coverage)));
}

/** Merge worker-reported CLIP status into web /api/health (CLIP runs on worker, not web). */
export function mergeWorkerClipVisionStatus(
  visionQa: ReturnType<typeof getVisionQaStatus>,
  workerClipReady: boolean | null,
  workerClipHint: string | null | undefined
): ReturnType<typeof getVisionQaStatus> {
  if (workerClipReady == null) return visionQa;
  const localVision = {
    ...visionQa.localVision,
    pipelineReady: workerClipReady,
    hint: workerClipHint?.trim() || visionQa.localVision.hint,
  };
  const ready = visionQa.clipVisionGate && visionQa.sceneCriticalReview && workerClipReady;
  let hint = localVision.hint;
  if (visionQa.clipVisionGate && visionQa.sceneCriticalReview && workerClipReady) {
    hint += ` ${visionQa.effectiveSamplesFull} frames/clip (${visionQa.effectiveSamplesFast} fast), ${Math.round(visionQa.visionFrameCoverage * 100)}% coverage, pass ≥${visionQa.minScore}/10.`;
  }
  return { ...visionQa, ready, localVision, hint };
}

/** Runtime status for /api/health. */
export function getVisionQaStatus(): {
  ready: boolean;
  clipVisionGate: boolean;
  visionGeoGate: boolean;
  sceneCriticalReview: boolean;
  minScore: number;
  visionSamplesPerClip: number;
  visionFrameCoverage: number;
  effectiveSamplesFast: number;
  effectiveSamplesFull: number;
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
  const visionFrameCoverage = clipVisionFrameCoverage();
  const effectiveSamplesFast = effectiveVisionSampleCount(true);
  const effectiveSamplesFull = effectiveVisionSampleCount(false);
  const strictInconclusive = strictVisionInconclusiveFails();
  const ready = clipVisionGate && sceneCriticalReview;

  let hint = localVision.hint;
  if (!clipVisionGate) {
    hint = "Local vision disabled — remove ENABLE_LOCAL_VISION=false if set.";
  } else if (!sceneCriticalReview) {
    hint = "Scene critical review disabled — remove ENABLE_SCENE_CRITICAL_REVIEW=false if set.";
  } else {
    hint += ` ${effectiveSamplesFull} frames/clip (${effectiveSamplesFast} fast), ${Math.round(visionFrameCoverage * 100)}% coverage, pass ≥${minScore}/10.`;
  }

  return {
    ready,
    clipVisionGate,
    visionGeoGate: false,
    sceneCriticalReview,
    minScore,
    visionSamplesPerClip,
    visionFrameCoverage,
    effectiveSamplesFast,
    effectiveSamplesFull,
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

function visionSampleFractions(fastMode = false, shortVideo = false): number[] {
  const count = effectiveVisionSampleCount(fastMode, shortVideo);
  return LOCAL_FRAME_FRACTIONS.slice(0, count);
}

async function extractPreviewFrames(
  clipPath: string,
  workDir: string,
  sceneIndex: number,
  beatIndex: number,
  fastMode = false,
  shortVideo = false
): Promise<string[]> {
  const fractions = visionSampleFractions(fastMode, shortVideo);
  const extractMs = fastMode ? 4_500 : 8_000;
  const paths = await Promise.all(
    fractions.map(async (frac, i) => {
      const outPath = path.join(
        workDir,
        `scene_${sceneIndex}_b${beatIndex}_lv${i}_${path.basename(clipPath).replace(/\.[^.]+$/, "")}.jpg`
      );
      const ok = await extractFrameAtFraction(clipPath, outPath, frac, extractMs);
      return ok ? outPath : null;
    })
  );
  return paths.filter((p): p is string => p != null);
}

function cleanupFramePaths(framePaths: string[]): void {
  for (const fp of framePaths) {
    try { fs.unlinkSync(fp); } catch { /* ignore */ }
  }
}

function simToScore10(sim: number): number {
  return Math.max(0, Math.min(10, Math.round(sim * 40)));
}

async function extractSinglePreviewFrame(
  clipPath: string,
  workDir: string,
  sceneIndex: number,
  beatIndex: number,
  fraction: number,
  fastMode: boolean
): Promise<string | null> {
  const outPath = path.join(
    workDir,
    `scene_${sceneIndex}_b${beatIndex}_lv0_${path.basename(clipPath).replace(/\.[^.]+$/, "")}.jpg`
  );
  const ok = await extractFrameAtFraction(
    clipPath,
    outPath,
    fraction,
    fastMode ? 4_500 : 8_000
  );
  return ok ? outPath : null;
}

async function lumaRejectAtFraction(
  clipPath: string,
  workDir: string,
  sceneIndex: number,
  beatIndex: number,
  fraction: number,
  fastMode: boolean
): Promise<boolean> {
  const lumaPath = path.join(
    workDir,
    `scene_${sceneIndex}_b${beatIndex}_lv_luma_${path.basename(clipPath).replace(/\.[^.]+$/, "")}.jpg`
  );
  const lumaOk = await extractFrameAtFraction(
    clipPath,
    lumaPath,
    fraction,
    fastMode ? 6_000 : 10_000
  );
  if (!lumaOk) return false;
  const luma = await probeImageMeanLuma(lumaPath);
  cleanupFramePaths([lumaPath]);
  return luma !== null && luma < 12;
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
  fastMode: boolean,
  queryEmb?: number[] | null,
  shortVideo = false
): Promise<{ pass: boolean; worstScore: number | null; framesScored: number }> {
  const assetId = curatedClipPathAssetId(clipPath);
  const storedEmbeddings =
    assetId != null
      ? loadStoredFrameEmbeddings(assetId)
      : loadStoredStockFrameEmbeddingsFromPath(clipPath);
  const queryEmbResolved =
    queryEmb ?? (await resolveBeatQueryEmbedding(beatText, visualDescription, videoTitle));

  if (storedEmbeddings?.length && queryEmbResolved) {
    const useCascade = cascadeVisionGateEnabled();
    const primaryIdx = Math.min(
      Math.max(0, Math.floor(storedEmbeddings.length * CASCADE_PRIMARY_FRAME_FRAC)),
      storedEmbeddings.length - 1
    );

    if (useCascade && storedEmbeddings.length > 1) {
      const quickEmb = [storedEmbeddings[primaryIdx]!];
      const quick = await scoreEmbeddingsAgainstBeat(
        quickEmb,
        beatText,
        visualDescription,
        videoTitle,
        clipPath,
        minScore,
        queryEmbResolved
      );
      if (quick?.definiteFail) {
        const worstScore10 = simToScore10(quick.worstSimilarity);
        return { pass: false, worstScore: worstScore10, framesScored: 1 };
      }
      const quickScore10 = simToScore10(quick?.worstSimilarity ?? 0);
      if (
        quick &&
        quickScore10 >= minScore &&
        !quick.modernMismatch &&
        !(await lumaRejectAtFraction(
          clipPath,
          workDir,
          sceneIndex,
          beatIndex,
          CASCADE_PRIMARY_FRAME_FRAC,
          fastMode
        ))
      ) {
        return { pass: true, worstScore: quickScore10, framesScored: 1 };
      }
      if (quick && quickScore10 < cascadeVisionExpandBelow(minScore)) {
        return { pass: false, worstScore: quickScore10, framesScored: 1 };
      }
    }

    const storedOnly = await scoreEmbeddingsAgainstBeat(
      storedEmbeddings,
      beatText,
      visualDescription,
      videoTitle,
      clipPath,
      minScore,
      queryEmbResolved
    );
    if (storedOnly?.definiteFail) {
      const worstScore10 = Math.max(0, Math.min(10, Math.round(storedOnly.worstSimilarity * 40)));
      return { pass: false, worstScore: worstScore10, framesScored: storedEmbeddings.length };
    }
    if (storedOnly?.similarityPass) {
      const worstScore10 = simToScore10(storedOnly.worstSimilarity);
      if (
        fastMode &&
        storedOnly.score >= minScore &&
        worstScore10 >= minScore &&
        !storedOnly.modernMismatch
      ) {
        return { pass: true, worstScore: worstScore10, framesScored: storedEmbeddings.length };
      }
      const darkReject = await lumaRejectAtFraction(
        clipPath,
        workDir,
        sceneIndex,
        beatIndex,
        CASCADE_PRIMARY_FRAME_FRAC,
        fastMode
      );
      const pass =
        !darkReject &&
        storedOnly.score >= minScore &&
        worstScore10 >= minScore;
      return { pass, worstScore: worstScore10, framesScored: storedEmbeddings.length };
    }
  }

  if (cascadeVisionGateEnabled()) {
    const primaryPath = await extractSinglePreviewFrame(
      clipPath,
      workDir,
      sceneIndex,
      beatIndex,
      CASCADE_PRIMARY_FRAME_FRAC,
      fastMode
    );
    if (primaryPath) {
      const primaryResult = await scoreFramePathsAgainstBeat(
        [primaryPath],
        beatText,
        visualDescription,
        videoTitle,
        clipPath,
        minScore,
        storedEmbeddings,
        queryEmbResolved
      );
      cleanupFramePaths([primaryPath]);

      if (primaryResult) {
        const primaryScore10 = simToScore10(primaryResult.worstSimilarity);
        const primaryPass =
          primaryResult.framesScored > 0 &&
          primaryResult.matchesNarration &&
          primaryResult.showsSubject &&
          !primaryResult.wrongSubject &&
          primaryResult.wellFramed &&
          primaryScore10 >= minScore &&
          primaryResult.score >= minScore;

        if (primaryPass) {
          return { pass: true, worstScore: primaryScore10, framesScored: 1 };
        }
        if (primaryScore10 < cascadeVisionExpandBelow(minScore) || primaryResult.wrongSubject) {
          return { pass: false, worstScore: primaryScore10, framesScored: 1 };
        }
      }
    }
  }

  const framePaths = await extractPreviewFrames(clipPath, workDir, sceneIndex, beatIndex, fastMode, shortVideo);
  if (framePaths.length === 0) {
    return { pass: !strictVisionInconclusiveFails(fastMode), worstScore: null, framesScored: 0 };
  }

  const result = await scoreFramePathsAgainstBeat(
    framePaths,
    beatText,
    visualDescription,
    videoTitle,
    clipPath,
    minScore,
    storedEmbeddings,
    queryEmbResolved
  );
  cleanupFramePaths(framePaths);

  if (!result) {
    return { pass: !strictVisionInconclusiveFails(fastMode), worstScore: null, framesScored: 0 };
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

export type VisionGateResult = {
  pass: boolean;
  worstScore10: number | null;
  skipped: boolean;
};

/** Evaluate local CLIP vision gate and return pass + worst frame score. */
export async function evaluateClipVisionGate(
  clipPath: string,
  beatText: string,
  videoTitle: string | undefined,
  workDir: string,
  sceneIndex: number,
  beatIndex: number,
  fastMode: boolean,
  minScore = minClipQualityScore(),
  visualDescription?: string,
  _segmentLock?: unknown,
  queryEmb?: number[] | null,
  shortVideo = false
): Promise<VisionGateResult> {
  if (!clipVisionGateEnabled() || !shouldVisionCheckClip(clipPath, fastMode)) {
    return { pass: true, worstScore10: null, skipped: true };
  }

  await ensureClipPipelinesLoaded();

  const cacheKey = visionGateCacheKey(clipPath, beatText, minScore, visualDescription);
  if (visionGateCache.has(cacheKey)) {
    const pass = visionGateCache.get(cacheKey)!;
    return { pass, worstScore10: pass ? minScore : null, skipped: false };
  }

  const result = await scoreClipAcrossFrames(
    clipPath,
    beatText,
    visualDescription,
    videoTitle,
    workDir,
    sceneIndex,
    beatIndex,
    minScore,
    fastMode,
    queryEmb,
    shortVideo
  );

  if (!result.pass) {
    console.warn(
      `[LocalVision] Scene ${sceneIndex} beat ${beatIndex}: reject "${path.basename(clipPath)}" ` +
        `(${result.framesScored} frames, worst=${result.worstScore ?? "?"}/10 avg needed ≥${minScore})`
    );
  }
  rememberVisionGateResult(cacheKey, result.pass);
  return { pass: result.pass, worstScore10: result.worstScore, skipped: false };
}

/** Target vision score for high-quality beat adoption (0–10). */
export function targetClipVisionScore(): number {
  const raw = process.env.TARGET_CLIP_VISION_SCORE?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 5 && n <= 10) return n;
  }
  return 8;
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
  _segmentLock?: unknown,
  queryEmb?: number[] | null
): Promise<boolean> {
  return (
    await evaluateClipVisionGate(
      clipPath,
      beatText,
      videoTitle,
      workDir,
      sceneIndex,
      beatIndex,
      fastMode,
      minScore,
      visualDescription,
      _segmentLock,
      queryEmb
    )
  ).pass;
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
  fastMode = false,
  shortVideo = false
): Promise<{
  score: number;
  matchesNarration: boolean;
  showsSubject: boolean;
  wellFramed: boolean;
  wrongSubject: boolean;
} | null> {
  if (!clipVisionGateEnabled() || !shouldVisionCheckClip(clipPath)) return null;

  const framePaths = await extractPreviewFrames(clipPath, workDir, sceneIndex, beatIndex, fastMode, shortVideo);
  if (framePaths.length === 0) return null;

  const assetId = curatedClipPathAssetId(clipPath);
  const storedEmbeddings =
    assetId != null
      ? loadStoredFrameEmbeddings(assetId)
      : loadStoredStockFrameEmbeddingsFromPath(clipPath);

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
