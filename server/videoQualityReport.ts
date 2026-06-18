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
  pipelineSec?: number;
  stockBeatsUsed?: number;
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
  if (
    /_ai_fallback|_stability_|_leonardo_|_grok_|_runway_|_kling_|_luma_|_pika_|_veo_|_forge_|scene_\d+_b\d+_ai/i.test(
      base
    )
  ) {
    return "ai";
  }
  if (/_fallback/i.test(base)) return "fallback";
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

export function buildVideoQualityReport(
  clipPaths: string[],
  videoTitle: string,
  opts?: { pipelineSec?: number; stockBeatsUsed?: number; rejectAudit?: ClipRejectEntry[] }
): VideoQualityReport {
  const bySource: Record<string, number> = {};
  const byMixKind = emptyMixCounts();
  const warnings: string[] = [];
  const offTopicSuspects: Array<{ basename: string; reason: string }> = [];
  const primaryGeo = inferPrimaryGeoFromTitle(videoTitle);
  const unique = [...new Set(clipPaths.filter(Boolean))];

  for (const clipPath of unique) {
    const source = inferClipSourceFromPath(clipPath);
    bySource[source] = (bySource[source] ?? 0) + 1;
    const mix = classifyClipMixKind(clipPath);
    byMixKind[mix]++;

    const hay = `${path.basename(clipPath)} ${videoTitle}`.toLowerCase();
    if (isOffTopicGeoUrbanVisual(hay) && !offTopicVisualAllowedForBeat(hay, videoTitle)) {
      offTopicSuspects.push({ basename: path.basename(clipPath), reason: "off-topic visual" });
    } else {
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

  if (wikimediaCount === 0 && unique.length >= 3) {
    warnings.push("Geen Wikimedia-stills — controleer zoekqueries of WIKIMEDIA_V1_THRESHOLD.");
  }
  if (stockCount > unique.length * 0.45) {
    warnings.push(`Veel stock (${stockCount}/${unique.length}) — vul archief aan met geo-tags.`);
  }
  if (offTopicSuspects.length > 0) {
    warnings.push(`${offTopicSuspects.length} clip(s) met kwaliteitswaarschuwing.`);
  }
  if ((bySource.unknown ?? 0) > 0) {
    warnings.push(`${bySource.unknown} clip(s) met onbekende bron.`);
  }

  let score = 100;
  score -= Math.min(30, stockCount * 4);
  score -= Math.min(25, offTopicSuspects.length * 12);
  if (wikimediaCount === 0 && unique.length > 2) score -= 8;
  if (archiveCount === 0 && unique.length > 2) score -= 10;
  score = Math.max(0, Math.min(100, score));

  const rejectSummary = opts?.rejectAudit?.length
    ? summarizeClipRejectAudit(opts.rejectAudit)
    : undefined;
  const topRejects = opts?.rejectAudit?.slice(0, 12);

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
    rejectSummary,
    topRejects,
    pipelineSec: opts?.pipelineSec,
    stockBeatsUsed: opts?.stockBeatsUsed,
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
}
