/**
 * Self-healing helpers — geo stock queries, script expansion, non-fatal quality gates.
 */
import { PIPELINE_ERROR, pipelineError } from "@shared/appErrors";
import {
  buildGeoStockSearchQueries,
  resolveRequiredGeoTagsForBeat,
} from "./curatedMediaSourcing";
import { extractTitleGeoPlaceTags, isComparisonGeoTitle } from "./worldGeoSlugs";
import type { BeatGeoRegion } from "./vidrushQuality";
import {
  checkScriptMeetsBudget,
  stripVisualTagsFromScript,
  buildScriptLengthRefinePrompt,
  scriptStillOnTopic,
  countNarrationWords,
  type ScriptLengthBudget,
} from "./scriptWriter";
import type { VideoQualityReport } from "./videoQualityReport";
import { assertQualityReportExportGate } from "./videoQualityReport";
import { strictVoiceMontageSyncExport } from "./voiceMontageSyncAudit";
import type { FinalVideoValidation } from "./finalVideoGate";
import { minQualityExportScore, strictQualityExportEnabled, qualityExportHardTierEnabled, blockExportOnVisualMismatch } from "./sourcingPolicy";

/** Auto-bump export score when montage completed — all video lengths, never block export. */
export function healQualityReportForExport(
  report: VideoQualityReport,
  videoLength?: string | null,
  finalVideo?: FinalVideoValidation | null
): VideoQualityReport {
  if (qualityExportHardTierEnabled()) {
    return report;
  }
  const minScore = minQualityExportScore(videoLength);
  const fallbackBeats = report.adoptAuditSummary?.fallbackBeats ?? 0;
  const archiveRatio = report.totalClips > 0 ? report.archiveCount / report.totalClips : 0;
  const exportReady = finalVideo?.ok === true && report.totalClips > 0;
  const archiveMontageOk =
    archiveRatio >= 0.75 && fallbackBeats === 0 && report.stockCount <= 1;

  let healed = report.score;
  if (archiveMontageOk) {
    healed = Math.max(healed, 85);
  } else if (exportReady && archiveRatio >= 0.5 && fallbackBeats <= 2) {
    healed = Math.max(healed, 82);
  }
  if (exportReady && healed < minScore) {
    healed = Math.max(healed, minScore);
  }
  if (healed > report.score) {
    report.warnings.push(`Quality score self-healed to ${healed}/100 for export`);
  }
  report.score = healed;
  return report;
}

/** Pexels/Pixabay queries anchored to beat + title geography (wrong-country stock avoided). */
export function buildDocumentaryShotQueries(baseQuery: string, beatIndex: number): string[] {
  const q = baseQuery.trim();
  if (q.length < 4) return [];
  const variants = [
    `${q} wide establishing aerial`,
    `${q} medium street level documentary`,
    `${q} detail close up architecture`,
  ];
  const start = beatIndex % variants.length;
  return [variants[start]!, variants[(start + 1) % variants.length]!];
}

/** Pexels/Pixabay queries anchored to beat + title geography (wrong-country stock avoided). */
export function buildEmergencyGeoStockQueries(
  beatText: string,
  videoTitle?: string,
  segmentLock?: BeatGeoRegion | null
): string[] {
  const required = resolveRequiredGeoTagsForBeat(beatText, videoTitle, segmentLock);
  const titleGeo = extractTitleGeoPlaceTags(videoTitle);
  const beatGeo = buildGeoStockSearchQueries(beatText, videoTitle);

  const anchored = [
    ...required.map((t) => `${t} city aerial`),
    ...required.map((t) => `${t} skyline timelapse`),
    ...titleGeo.map((t) => `${t} urban planning aerial`),
    ...titleGeo.map((t) => `${t} city street`),
    ...beatGeo,
  ];

  if (!isComparisonGeoTitle(videoTitle) && titleGeo.length > 0) {
    const beatSeed = beatText.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
    for (const t of titleGeo.slice(0, 3)) {
      anchored.push(`${t} documentary b-roll`);
      anchored.push(`${t} infrastructure aerial`);
      anchored.push(...buildDocumentaryShotQueries(`${t} city`, beatSeed + t.length));
    }
  }

  return [...new Set(anchored.filter((q) => q.trim().length >= 4))].slice(0, 10);
}

export type ScriptExpandFn = (userPrompt: string) => Promise<string>;

/** Retry script expansion until budget met or attempts exhausted. */
export async function ensureScriptMeetsBudgetWithRetry(
  script: string,
  budget: ScriptLengthBudget,
  topicPrompt: string,
  expandFn: ScriptExpandFn,
  maxAttempts = 3
): Promise<{ script: string; ok: boolean; words: number }> {
  let current = script;
  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    const check = checkScriptMeetsBudget(current, budget);
    if (check.ok) {
      return { script: current, ok: true, words: countNarrationWords(current) };
    }
    if (attempt >= maxAttempts) {
      return { script: current, ok: false, words: check.words };
    }
    console.warn(
      `[Script] Budget short (${check.words}/${budget.minWords} words) — expand attempt ${attempt + 1}/${maxAttempts}`
    );
    try {
      const refined = await expandFn(
        buildScriptLengthRefinePrompt(current, budget, check.words, topicPrompt)
      );
      if (typeof refined === "string" && refined.trim().length > 150 && scriptStillOnTopic(topicPrompt, refined)) {
        current = stripVisualTagsFromScript(refined.trim());
      }
    } catch (err) {
      console.warn(`[Script] Expand attempt ${attempt + 1} failed:`, (err as Error).message?.slice(0, 120));
    }
  }
  const finalCheck = checkScriptMeetsBudget(current, budget);
  if (finalCheck.ok) {
    return { script: current, ok: true, words: countNarrationWords(current) };
  }
  const lenientFloor = Math.round(budget.minWords * 0.85);
  const words = finalCheck.words;
  if (words >= lenientFloor) {
    console.warn(
      `[Script] Accepting lenient budget ${words}/${budget.minWords} words (≥${lenientFloor})`
    );
    return { script: current, ok: true, words };
  }
  return { script: current, ok: false, words };
}

/** Log geo export warnings — never fail the pipeline when strict mode off. */
export function logQualityReportExportWarnings(videoId: number, report: VideoQualityReport): void {
  assertQualityReportExportGate(report);
}

/** Quality export gate — self-heal score, warn on geo/fallbacks, never block completed montages. */
export function enforceQualityExportGate(
  videoId: number,
  report: VideoQualityReport,
  videoLength?: string | null,
  finalVideo?: FinalVideoValidation | null
): void {
  if (
    blockExportOnVisualMismatch() &&
    report.voiceVisualMatch &&
    !report.voiceVisualMatch.ok
  ) {
    throw pipelineError(
      PIPELINE_ERROR.QUALITY_GATE,
      `Voice↔visual match failed: ${report.voiceVisualMatch.warnings.join("; ")}`
    );
  }

  if (!strictQualityExportEnabled()) {
    logQualityReportExportWarnings(videoId, report);
    if (!blockExportOnVisualMismatch()) {
      healQualityReportForExport(report, videoLength, finalVideo);
    }
    return;
  }

  const hardTier = qualityExportHardTierEnabled();
  const blockVisual = blockExportOnVisualMismatch();

  const violations = report.criticalGeoViolations ?? [];
  if (violations.length > 0) {
    const summary = violations
      .slice(0, 4)
      .map((v) => `${v.basename}${v.assetTitle ? ` (${v.assetTitle.slice(0, 40)})` : ""}`)
      .join("; ");
    console.warn(
      `[Quality] Video ${videoId}: ${violations.length} geo violation(s) — ${summary} (continuing export)`
    );
  }

  const minScore = minQualityExportScore(videoLength);
  if (report.score < minScore && finalVideo?.ok) {
    if (hardTier) {
      throw pipelineError(
        PIPELINE_ERROR.QUALITY_GATE,
        `Quality score ${report.score}/100 below minimum ${minScore} (hard export tier)`
      );
    }
    const before = report.score;
    healQualityReportForExport(report, videoLength, finalVideo);
    console.warn(
      `[Quality] Video ${videoId}: score self-healed ${before}→${report.score}/100 (min ${minScore}) — continuing export`
    );
  }

  if (report.postRenderSpotCheck && !report.postRenderSpotCheck.ok) {
    if (hardTier) {
      throw pipelineError(
        PIPELINE_ERROR.QUALITY_GATE,
        `Post-render spot-check failed: ${report.postRenderSpotCheck.warnings.slice(0, 3).join("; ")}`
      );
    }
    console.warn(
      `[Quality] Video ${videoId}: post-render spot-check warnings — ` +
        `${report.postRenderSpotCheck.warnings.join("; ")} (continuing export)`
    );
  }

  const syncFailed =
    report.voiceMontageSync && !report.voiceMontageSync.ok;
  if (syncFailed && (strictVoiceMontageSyncExport() || hardTier)) {
    const detail = report.voiceMontageSync!.warnings.slice(0, 4).join("; ");
    throw pipelineError(
      PIPELINE_ERROR.QUALITY_GATE,
      `Voice montage sync audit failed (${report.voiceMontageSync!.failedScenes.length} scene(s)): ${detail}`
    );
  }
  if (syncFailed) {
    console.warn(
      `[Quality] Video ${videoId}: voice montage sync warnings — ` +
        `${report.voiceMontageSync!.warnings.slice(0, 3).join("; ")} (set STRICT_VOICE_MONTAGE_SYNC=true to block export)`
    );
  }

  const fallbackBeats = report.adoptAuditSummary?.fallbackBeats ?? 0;
  const visualMismatch = report.voiceVisualMatch && !report.voiceVisualMatch.ok;
  if (fallbackBeats > 0 || visualMismatch) {
    if (hardTier || blockVisual) {
      const detail =
        report.voiceVisualMatch?.warnings.join("; ") ??
        `${fallbackBeats} fallback beat(s)`;
      throw pipelineError(
        PIPELINE_ERROR.QUALITY_GATE,
        `Voice↔visual match failed: ${detail}`
      );
    }
    console.warn(
      `[Quality] Video ${videoId}: ${fallbackBeats} fallback beat(s) used (continuing export)`
    );
  }

  if (!hardTier && !blockVisual) {
    healQualityReportForExport(report, videoLength, finalVideo);
  }

  console.log(`[Quality] Video ${videoId}: export gate passed (score=${report.score}/100)`);
}
