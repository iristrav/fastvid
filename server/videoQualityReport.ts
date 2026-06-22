/**
 * Per-video quality summary — clip mix, source breakdown, geo warnings.
 */
import * as path from "path";
import { classifyClipMixKind, type VisualMixKind } from "./visualMixPolicy";
import { inferVideoVisualTopic } from "./visualBeatTags";
import {
  inferPrimaryGeoFromTitle,
  isOffTopicGeoUrbanVisual,
  isWrongRegionForSegmentLock,
  offTopicVisualAllowedForBeat,
  resolveBeatRegionLock,
} from "./vidrushQuality";

import type { ClipRejectEntry } from "./clipRejectAudit";
import { summarizeClipRejectAudit } from "./clipRejectAudit";
import type { ClipAdoptEntry, AdoptAuditSummary } from "./clipAdoptAudit";
import { summarizeAdoptAudit } from "./clipAdoptAudit";
import { isArchiveGeoBlockedForBeat, resolveRequiredGeoTagsForBeat } from "./curatedMediaSourcing";
import type { BeatGeoRegion } from "./vidrushQuality";
import { targetClipVisionScore } from "./visualQualityGate";
import type { VoiceVisualMatchSummary } from "./voiceVisualMatch";
import { buildVoiceVisualMatchSummary } from "./voiceVisualMatch";

export type { VoiceVisualMatchSummary };

export type VideoQualityReport = {
  generatedAt: string;
  videoTitle: string;
  visualTopic: string;
  totalClips: number;
  bySource: Record<string, number>;
  byMixKind: Record<VisualMixKind, number>;
  wikimediaCount: number;
  archiveCount: number;
  stockCount: number;
  warnings: string[];
  offTopicSuspects: Array<{ basename: string; reason: string }>;
  rejectSummary?: Record<string, number>;
  topRejects?: ClipRejectEntry[];
  criticalGeoViolations?: Array<{
    basename: string;
    reason: string;
    beatText: string;
    assetTitle?: string;
  }>;
  pipelineSec?: number;
  stockBeatsUsed?: number;
  postRenderSpotCheck?: {
    ok: boolean;
    blackFrameCount: number;
    framesChecked: number;
    worstMeanLuma: number | null;
    warnings: string[];
  };
  adoptAuditSummary?: AdoptAuditSummary;
  voiceMontageSync?: {
    ok: boolean;
    sceneCount: number;
    failedScenes: number[];
    warnings: string[];
  };
  voiceVisualMatch?: VoiceVisualMatchSummary;
  score: number;
};

/** Map temp clip filename → source bucket (mirrors videoPipeline.inferClipSourceFromPath). */
export function inferClipSourceFromPath(filePath: string): string {
  const base = path.basename(filePath).replace(/_transformed(?=\.mp4)$/i, "").toLowerCase();
  if (/_ytfu_|_ytcc_|_b\d+_yt_|_yt_\d/i.test(base)) return "youtube";
  if (
    /pexels|_pex_|lr_pex|_b\d+_fast|_fast_vid|_b\d+_script|_script_vid|_golden|_b\d+_lr_pex|scene_\d+_b\d+_vid\d+|person_stock/i.test(
      base
    )
  ) {
    return "pexels";
  }
  if (/serp/i.test(base)) return "serpapi";
  if (/wikivid|_wiki_|v1wiki/i.test(base)) return "wikimedia";
  if (/septube/i.test(base)) return "peertube";
  if (/gdelt/i.test(base)) return "gdelt";
  if (/euro_/i.test(base)) return "europeana";
  if (/vimeo/i.test(base)) return "vimeo";
  if (/openverse|_ov_/i.test(base)) return "openverse";
  if (/nasa/i.test(base)) return "nasa";
  if (/archive|curated|_hist/i.test(base)) return "archive";
  if (/pixabay|_pix_|beat_vid|fb_vid/i.test(base)) return "pixabay";
  if (/_kling_|scene_\d+_b\d+_kling/i.test(base)) return "kling";
  if (
    /_ai_fallback|_stability_|_leonardo_|_grok_|_runway_|_kling_|_luma_|_pika_|_veo_|_forge_|scene_\d+_b\d+_ai/i.test(
      base
    )
  ) {
    return "ai";
  }
  if (/_fallback|guaranteed|_slot\d+_guaranteed/i.test(base)) return "fallback";
  if (/broll_vid/i.test(base)) return "broll";
  return "unknown";
}

function emptyMixCounts(): Record<VisualMixKind, number> {
  return {
    real_video: 0,
    photo: 0,
    stock: 0,
    screenshot: 0,
    motion_graphics: 0,
  };
}

/** Merit-based score from vision QA + sourcing mix (not subtract-from-100 heuristics). */
export function computeMeritQualityScore(params: {
  totalClips: number;
  archiveCount: number;
  stockCount: number;
  fallbackBeats: number;
  offTopicCount: number;
  geoViolationCount: number;
  adoptAudit?: ClipAdoptEntry[];
  archiveOnly: boolean;
  fastShort: boolean;
  byMixKind: Record<VisualMixKind, number>;
  postRenderOk?: boolean;
}): number {
  const visionScores = (params.adoptAudit ?? [])
    .map((e) => e.visionScore10)
    .filter((s): s is number => typeof s === "number" && s > 0);

  let score: number;
  if (visionScores.length > 0) {
    const avg = visionScores.reduce((a, b) => a + b, 0) / visionScores.length;
    const min = Math.min(...visionScores);
    score = Math.round(45 + avg * 5.5 + min * 0.5);
  } else if (params.archiveOnly && params.archiveCount >= params.totalClips * 0.8) {
    score = 84;
  } else {
    score = 72;
  }

  const archiveRatio = params.totalClips > 0 ? params.archiveCount / params.totalClips : 0;
  if (params.archiveOnly && archiveRatio >= 0.85) score += 4;
  if ((params.byMixKind.real_video ?? 0) >= params.totalClips * 0.55) score += 4;
  if (visionScores.length > 0 && visionScores.every((s) => s >= targetClipVisionScore() - 1)) {
    score += 3;
  }

  score -= params.fallbackBeats * 14;
  score -= Math.min(12, params.stockCount * 3);
  score -= Math.min(params.fastShort ? 8 : 16, params.offTopicCount * (params.fastShort ? 4 : 8));
  score -= Math.min(params.fastShort ? 10 : 20, params.geoViolationCount * (params.fastShort ? 6 : 12));
  if (params.postRenderOk === false) score -= 8;

  const beatsFilled = new Set(
    (params.adoptAudit ?? []).map((e) => `${e.sceneIndex}:${e.beatIndex}`)
  ).size;
  const visionCoverage =
    beatsFilled > 0 ? visionScores.length / beatsFilled : params.totalClips > 0 ? 1 : 0;
  if (
    params.archiveOnly &&
    params.fallbackBeats === 0 &&
    params.stockCount === 0 &&
    visionCoverage >= 0.5 &&
    (visionScores.length === 0 || visionScores.every((s) => s >= targetClipVisionScore() - 1))
  ) {
    score = Math.max(score, 82);
  }
  if (
    visionScores.length >= 3 &&
    visionScores.every((s) => s >= targetClipVisionScore()) &&
    params.fallbackBeats === 0
  ) {
    score = Math.max(score, 88);
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

export function buildVideoQualityReport(
  clipPaths: string[],
  videoTitle: string,
  opts?: {
    pipelineSec?: number;
    stockBeatsUsed?: number;
    rejectAudit?: ClipRejectEntry[];
    adoptAudit?: ClipAdoptEntry[];
    archiveOnly?: boolean;
    fastShort?: boolean;
    sceneCriticalFailed?: number[];
  }
): VideoQualityReport {
  const bySource: Record<string, number> = {};
  const byMixKind = emptyMixCounts();
  const warnings: string[] = [];
  const offTopicSuspects: Array<{ basename: string; reason: string }> = [];
  const primaryGeo = inferPrimaryGeoFromTitle(videoTitle);
  const visualTopic = inferVideoVisualTopic(videoTitle, videoTitle);
  const archiveOnly = opts?.archiveOnly === true;
  const fastShort = opts?.fastShort === true;
  const skipUrbanOffTopic =
    archiveOnly &&
    (visualTopic === "wwii" || visualTopic === "cold_war" || visualTopic === "general");
  const unique = [...new Set(clipPaths.filter(Boolean))];

  for (const clipPath of unique) {
    const source = inferClipSourceFromPath(clipPath);
    bySource[source] = (bySource[source] ?? 0) + 1;
    const mix = classifyClipMixKind(clipPath);
    byMixKind[mix]++;

    const hay = `${path.basename(clipPath)} ${videoTitle}`.toLowerCase();
    if (
      !skipUrbanOffTopic &&
      isOffTopicGeoUrbanVisual(hay) &&
      !offTopicVisualAllowedForBeat(hay, videoTitle)
    ) {
      offTopicSuspects.push({ basename: path.basename(clipPath), reason: "off-topic visual" });
    } else if (!skipUrbanOffTopic) {
      const lock = resolveBeatRegionLock(videoTitle, videoTitle);
      if (lock !== "neutral" && lock !== "both" && isWrongRegionForSegmentLock(hay, lock)) {
        offTopicSuspects.push({ basename: path.basename(clipPath), reason: "wrong region" });
      } else if (primaryGeo !== "neutral" && primaryGeo !== "both" && isWrongRegionForSegmentLock(hay, primaryGeo)) {
        offTopicSuspects.push({ basename: path.basename(clipPath), reason: "wrong region for title" });
      }
    }
  }

  const wikimediaCount = (bySource.wikimedia ?? 0) + (bySource.openverse ?? 0);
  const archiveCount = bySource.archive ?? 0;
  const stockCount = (bySource.pexels ?? 0) + (bySource.pixabay ?? 0);

  if (!archiveOnly && wikimediaCount === 0 && unique.length >= 3) {
    warnings.push("Geen Wikimedia-stills — controleer zoekqueries of WIKIMEDIA_V1_THRESHOLD.");
  }
  if (stockCount > unique.length * 0.25) {
    warnings.push(`Veel stock (${stockCount}/${unique.length}) — vul archief aan met relevante clips (titel volstaat; AI tagt bij upload).`);
  }
  if (offTopicSuspects.length > 0) {
    warnings.push(`${offTopicSuspects.length} clip(s) met kwaliteitswaarschuwing.`);
  }
  if ((bySource.unknown ?? 0) > 0) {
    warnings.push(`${bySource.unknown} clip(s) met onbekende bron.`);
  }

  const adoptAuditSummary = opts?.adoptAudit?.length
    ? summarizeAdoptAudit(opts.adoptAudit)
    : undefined;
  if (adoptAuditSummary) {
    for (const hint of adoptAuditSummary.hints) {
      warnings.push(hint);
    }
  }

  const criticalGeoViolations: VideoQualityReport["criticalGeoViolations"] = [];
  const skipPostHocGeo =
    archiveOnly &&
    (visualTopic === "wwii" || visualTopic === "cold_war" || visualTopic === "general");
  for (const adopt of opts?.adoptAudit ?? []) {
    if (skipPostHocGeo && (adopt.source === "archive" || adopt.source === "archive_fetch")) {
      continue;
    }
    if (adopt.source !== "archive" && adopt.source !== "archive_fetch") continue;
    const assetLike = {
      title: adopt.assetTitle ?? adopt.basename.replace(/_/g, " "),
      tags: [] as string[],
    };
    if (isArchiveGeoBlockedForBeat(assetLike, adopt.beatText, videoTitle, adopt.segmentGeoLock as BeatGeoRegion | null)) {
      const required = resolveRequiredGeoTagsForBeat(
        adopt.beatText,
        videoTitle,
        adopt.segmentGeoLock as BeatGeoRegion | null
      );
      criticalGeoViolations.push({
        basename: adopt.basename,
        beatText: adopt.beatText.slice(0, 120),
        assetTitle: adopt.assetTitle,
        reason:
          required.some((t) => /singapore|berlin|netherlands|holland|dutch/.test(t))
            ? "wrong region for title/beat"
            : "wrong region for beat",
      });
    }
  }

  if (criticalGeoViolations.length > 0) {
    warnings.push(`${criticalGeoViolations.length} kritieke geo-fout(en).`);
  }

  const rejectSummary = opts?.rejectAudit?.length
    ? summarizeClipRejectAudit(opts.rejectAudit)
    : undefined;
  const topRejects = opts?.rejectAudit?.slice(0, 12);

  const score = computeMeritQualityScore({
    totalClips: unique.length,
    archiveCount,
    stockCount,
    fallbackBeats: adoptAuditSummary?.fallbackBeats ?? 0,
    offTopicCount: offTopicSuspects.length,
    geoViolationCount: criticalGeoViolations.length,
    adoptAudit: opts?.adoptAudit,
    archiveOnly,
    fastShort,
    byMixKind,
  });

  const voiceVisualMatch = buildVoiceVisualMatchSummary(
    opts?.adoptAudit,
    unique,
    opts?.sceneCriticalFailed ?? []
  );
  for (const w of voiceVisualMatch.warnings) {
    warnings.push(`VoiceVisual: ${w}`);
  }

  return {
    generatedAt: new Date().toISOString(),
    videoTitle,
    visualTopic: inferVideoVisualTopic(videoTitle, videoTitle),
    totalClips: unique.length,
    bySource,
    byMixKind,
    wikimediaCount,
    archiveCount,
    stockCount,
    warnings,
    offTopicSuspects,
    criticalGeoViolations: criticalGeoViolations.length > 0 ? criticalGeoViolations : undefined,
    rejectSummary,
    topRejects,
    pipelineSec: opts?.pipelineSec,
    stockBeatsUsed: opts?.stockBeatsUsed,
    adoptAuditSummary,
    voiceVisualMatch,
    score,
  };
}

export function logVideoQualityReport(videoId: number, report: VideoQualityReport): void {
  const mix = Object.entries(report.byMixKind)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k}=${n}`)
    .join(", ");
  const sources = Object.entries(report.bySource)
    .map(([k, n]) => `${k}=${n}`)
    .join(", ");
  console.log(
    `[Quality] Video ${videoId}: score=${report.score}/100, clips=${report.totalClips} ` +
      `[${sources}] mix=[${mix}]`
  );
  for (const w of report.warnings) {
    console.warn(`[Quality] Video ${videoId}: ${w}`);
  }
  for (const s of report.offTopicSuspects.slice(0, 5)) {
    console.warn(`[Quality] Video ${videoId}: suspect ${s.basename} — ${s.reason}`);
  }
  for (const v of (report.criticalGeoViolations ?? []).slice(0, 5)) {
    console.warn(
      `[Quality] Video ${videoId}: CRITICAL GEO ${v.basename} — ${v.reason}` +
        (v.assetTitle ? ` ("${v.assetTitle.slice(0, 60)}")` : "")
    );
  }
  if (report.adoptAuditSummary) {
    const a = report.adoptAuditSummary;
    console.log(
      `[Quality] Video ${videoId}: adopt audit beats=${a.beatsFilled} wiki=${a.wikiBeats} arch=${a.archiveBeats} stock=${a.stockBeats} kling=${a.klingBeats}`
    );
  }
}

/** Log geo export warnings when strict mode off. */
export function assertQualityReportExportGate(report: VideoQualityReport): void {
  const violations = report.criticalGeoViolations ?? [];
  if (violations.length === 0) return;
  const summary = violations
    .slice(0, 4)
    .map((v) => `${v.basename}${v.assetTitle ? ` (${v.assetTitle.slice(0, 40)})` : ""}`)
    .join("; ");
  console.warn(
    `[Quality] Geo warning (non-blocking): ${violations.length} issue(s): ${summary}`
  );
}
