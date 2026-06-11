/**
 * Pipeline QA — validate visuals match narration before/after effects.
 */
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import {
  buildBeatMatchTags,
  curatedClipPathAssetId,
  isCuratedInterviewAsset,
  isCuratedPosterOrStillAsset,
  scoreCuratedAsset,
} from "./curatedMediaSourcing";
import { getAllMediaArchives, getMediaArchiveAssetById, normalizeMediaTags } from "./db";

const execFile = promisify(execFileCb);

export type SceneReviewInput = {
  index: number;
  text: string;
  duration: number;
  clipPaths: string[];
  visualCue?: string;
  pexelsQuery?: string;
};

export type ReviewIssue = {
  sceneIndex: number;
  severity: "warn" | "error";
  code: string;
  message: string;
};

export type PipelineReviewResult = {
  ok: boolean;
  issues: ReviewIssue[];
  summary: string;
};

const MIN_VISUAL_MATCH_SCORE = 12;
const DURATION_TOLERANCE_SEC = 1.25;

async function probeDurationSec(filePath: string): Promise<number> {
  if (!fs.existsSync(filePath)) return 0;
  try {
    const ffprobe = process.env.FFPROBE_BIN || process.env.FFPROBE_PATH || "ffprobe";
    const { stdout } = await execFile(ffprobe, [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      filePath,
    ]);
    const n = parseFloat(String(stdout).trim());
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

async function nicheTagsForAsset(assetId: number): Promise<string[]> {
  const asset = await getMediaArchiveAssetById(assetId);
  if (!asset) return [];
  const archives = await getAllMediaArchives();
  const archive = archives.find((a) => a.id === asset.archiveId);
  return normalizeMediaTags(archive?.nicheTags ?? []);
}

/** Check selected archive clips align with scene narration text. */
export async function reviewSceneVisualAlignment(
  scene: SceneReviewInput,
  videoTitle?: string
): Promise<ReviewIssue[]> {
  const issues: ReviewIssue[] = [];
  if (scene.clipPaths.length === 0) {
    issues.push({
      sceneIndex: scene.index,
      severity: "error",
      code: "NO_CLIPS",
      message: "Geen beelden gekoppeld aan deze scene",
    });
    return issues;
  }

  const beat = {
    index: 0,
    text: scene.text,
    keywords: [] as string[],
    searchQuery: scene.pexelsQuery ?? scene.visualCue,
  };
  const sceneCtx = {
    text: scene.text,
    visualCue: scene.visualCue,
    pexelsQuery: scene.pexelsQuery,
  };
  const { beatTags, topicAnchors } = buildBeatMatchTags(beat, sceneCtx, videoTitle);

  let posterCount = 0;
  let interviewCount = 0;
  let lowScoreCount = 0;

  for (const clipPath of scene.clipPaths) {
    const assetId = curatedClipPathAssetId(clipPath);
    if (assetId == null) continue;

    const asset = await getMediaArchiveAssetById(assetId);
    if (!asset) {
      issues.push({
        sceneIndex: scene.index,
        severity: "warn",
        code: "ASSET_MISSING",
        message: `Clip ${assetId} niet meer in archief`,
      });
      continue;
    }

    const nicheTags = await nicheTagsForAsset(assetId);
    const score = scoreCuratedAsset(asset, nicheTags, beatTags, topicAnchors, scene.text);
    if (score < MIN_VISUAL_MATCH_SCORE) {
      lowScoreCount++;
      issues.push({
        sceneIndex: scene.index,
        severity: "warn",
        code: "LOW_VISUAL_MATCH",
        message: `"${asset.title ?? assetId}" past mogelijk niet bij: "${scene.text.slice(0, 60)}…" (score ${score})`,
      });
    }
    if (isCuratedPosterOrStillAsset(asset)) posterCount++;
    if (isCuratedInterviewAsset(asset)) interviewCount++;
  }

  if (posterCount >= 2) {
    issues.push({
      sceneIndex: scene.index,
      severity: "warn",
      code: "MANY_STILLS",
      message: `${posterCount} poster/portret-beelden in één scene — montage kan statisch ogen`,
    });
  }
  if (interviewCount >= 2) {
    issues.push({
      sceneIndex: scene.index,
      severity: "warn",
      code: "MANY_INTERVIEWS",
      message: `${interviewCount} interview-clips in één scene`,
    });
  }
  if (lowScoreCount > 0 && lowScoreCount === scene.clipPaths.length) {
    issues.push({
      sceneIndex: scene.index,
      severity: "error",
      code: "ALL_CLIPS_MISMATCH",
      message: "Geen enkel beeld sluit duidelijk aan op de narratie",
    });
  }

  return issues;
}

/** Validate assembled scene files cover narration duration. */
export async function reviewAssembledScenes(
  scenes: SceneReviewInput[],
  assemblyPaths: string[]
): Promise<PipelineReviewResult> {
  const issues: ReviewIssue[] = [];

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const assemblyPath = assemblyPaths[i];
    if (!assemblyPath || !fs.existsSync(assemblyPath) || fs.statSync(assemblyPath).size < 1000) {
      issues.push({
        sceneIndex: scene.index,
        severity: "error",
        code: "ASSEMBLY_MISSING",
        message: "Gemonteerde scene ontbreekt of is te klein",
      });
      continue;
    }

    const probed = await probeDurationSec(assemblyPath);
    const expected = Math.max(0.5, scene.duration - 0.2);
    if (probed > 0 && Math.abs(probed - expected) > DURATION_TOLERANCE_SEC) {
      issues.push({
        sceneIndex: scene.index,
        severity: "warn",
        code: "DURATION_DRIFT",
        message: `Scene duurt ${probed.toFixed(1)}s i.p.v. ~${expected.toFixed(1)}s — mogelijk bevroren frame`,
      });
    }
  }

  const errors = issues.filter((i) => i.severity === "error").length;
  const warns = issues.filter((i) => i.severity === "warn").length;
  return {
    ok: errors === 0,
    issues,
    summary:
      errors === 0 && warns === 0
        ? `${scenes.length} scenes gecontroleerd — beelden en timing OK`
        : `${scenes.length} scenes: ${errors} fout(en), ${warns} waarschuwing(en)`,
  };
}

/** Full visual + assembly review before effects pass. */
export async function reviewPipelineBeforeEffects(
  scenes: SceneReviewInput[],
  assemblyPaths: string[],
  videoTitle?: string
): Promise<PipelineReviewResult> {
  const issues: ReviewIssue[] = [];

  for (const scene of scenes) {
    const visualIssues = await reviewSceneVisualAlignment(scene, videoTitle);
    issues.push(...visualIssues);
  }

  const assemblyReview = await reviewAssembledScenes(scenes, assemblyPaths);
  issues.push(...assemblyReview.issues);

  const errors = issues.filter((i) => i.severity === "error").length;
  const warns = issues.filter((i) => i.severity === "warn").length;
  return {
    ok: errors === 0,
    issues,
    summary:
      errors === 0 && warns === 0
        ? `Hele video doorgenomen (${scenes.length} scenes) — klaar voor effecten`
        : `Controle vóór effecten: ${errors} fout(en), ${warns} waarschuwing(en)`,
  };
}

/** Final check on composed scenes before concat + export. */
export async function reviewPipelineBeforeExport(
  scenes: SceneReviewInput[],
  composedPaths: string[]
): Promise<PipelineReviewResult> {
  const issues: ReviewIssue[] = [];

  for (let i = 0; i < scenes.length; i++) {
    const composedPath = composedPaths[i];
    if (!composedPath || !fs.existsSync(composedPath) || fs.statSync(composedPath).size < 1000) {
      issues.push({
        sceneIndex: scenes[i].index,
        severity: "error",
        code: "COMPOSED_MISSING",
        message: "Scene na effecten ontbreekt",
      });
    }
  }

  const errors = issues.filter((i) => i.severity === "error").length;
  return {
    ok: errors === 0,
    issues,
    summary:
      errors === 0
        ? `Eindcontrole OK — ${scenes.length} scenes klaar om samen te voegen`
        : `Eindcontrole: ${errors} scene(s) ontbreken`,
  };
}

export function logPipelineReview(stage: string, result: PipelineReviewResult): void {
  console.log(`[PipelineReview] ${stage}: ${result.summary}`);
  for (const issue of result.issues) {
    const prefix = issue.severity === "error" ? "ERROR" : "WARN";
    console.log(`[PipelineReview] ${prefix} scene ${issue.sceneIndex} [${issue.code}]: ${issue.message}`);
  }
}
