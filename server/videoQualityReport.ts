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

import type { ClipRejectAudit, ClipRejectEntry } from "./clipRejectAudit";
import { summarizeClipRejectAudit } from "./clipRejectAudit";
import type { ClipAdoptEntry, AdoptAuditSummary } from "./clipAdoptAudit";
import { summarizeAdoptAudit } from "./clipAdoptAudit";
import { isArchiveGeoBlockedForBeat, resolveRequiredGeoTagsForBeat } from "./curatedMediaSourcing";
import type { BeatGeoRegion } from "./vidrushQuality";
import type { VoiceVisualMatchSummary } from "./voiceVisualMatch";
import { buildVoiceVisualMatchSummary } from "./voiceVisualMatch";
import { UNVERIFIED_PROVIDER as UNVERIFIED_SOURCE } from "./visualSourceLineage";
import { PIPELINE_ERROR, pipelineError } from "@shared/appErrors";
import {
  buildBeatVisualStatuses,
  tallyBeatVisualStatuses,
  type BeatVisualStatus,
  type BeatVisualTally,
} from "./beatVisualStatus";
import type { BeatRelevanceLedger } from "./beatVisualRelevance";

export type { VoiceVisualMatchSummary };

export type VideoQualityReport = {
  generatedAt: string;
  videoTitle: string;
  visualTopic: string;
  totalClips: number;
  /**
   * RONDE 87 — the OFFICIAL source attribution, from the lineage ledger only.
   *
   * A clip whose origin the render could not prove is counted under UNVERIFIED_SOURCE. It is never
   * reassigned to a plausible provider read off its filename.
   */
  bySource: Record<string, number>;
  /**
   * The filename reading, for debugging only. Never an official statistic: a filename says what a
   * file was named, not where its content came from, and the two stopped agreeing the first time
   * the compose path renamed a clip.
   */
  diagnosticBySource: Record<string, number>;
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
  /**
   * RONDE 133 — what the finished MP4 actually looks like, measured frame by frame.
   *
   * Every other number in this report is derived from what the pipeline BELIEVED it did. This one
   * is read back off the exported file by ./videoStillnessAudit, so a filter that silently did
   * nothing, a concat that repeated a segment, or a still that outstayed its cap shows up here
   * even when every plan upstream says otherwise. Absent when the audit could not run — which is
   * reported as absent, never as a pass.
   */
  stillness?: {
    durationSec: number;
    /** Longest stretch of unchanging picture. The number the no-frozen-frame chain exists for. */
    longestStillSec: number;
    longestStillStartSec: number;
    visualChanges: number;
    stillSegments: number;
    /** RONDE 136 — how many stills outstayed the cap. §12's `imagesOver5Sec`. */
    imagesOverLimit: number;
    /**
     * RONDE 136 — the mean luma of the film's actual last frame, or null when it could not be
     * read. Null is reported as NOT_MEASURED and never as a pass: an unread frame is not a bright
     * one, and the two checks that ran before this one both stopped short of the ending.
     */
    endFrameLuma: number | null;
    endsOnBlack: boolean;
    limitSec: number;
    ok: boolean;
  };
  /**
   * RONDE 156 — does the finished film show the same picture twice?
   *
   * Read off the exported MP4 by ./videoRepeatAudit, for the same reason the stillness block is:
   * the sourcing dedup is thorough but runs entirely BEFORE adoption, and the coverage-fill routes
   * step around it on purpose when a scene is starved. Only the file itself can say whether the
   * viewer ends up seeing a picture come back. Absent when the audit could not run — reported as
   * absent, never as a pass.
   */
  repeats?: {
    /** How many visually distinct pictures the film contains. */
    distinctPictures: number;
    /** How many of them appear more than once, with a real gap in between. */
    repeatedPictures: number;
    /** Seconds the viewer spent looking at something already seen. */
    repeatedSec: number;
    repeatedShare: number;
    limitShare: number;
    ok: boolean;
  };
  adoptAuditSummary?: AdoptAuditSummary;
  voiceMontageSync?: {
    ok: boolean;
    sceneCount: number;
    failedScenes: number[];
    warnings: string[];
  };
  voiceVisualMatch?: VoiceVisualMatchSummary;
  /** True when one or more narration chunks fell back to silent audio (every configured real
   *  TTS provider was tried and failed) — set from videoPipeline.ts's generateVoiceover(). A
   *  video with this set must never be indistinguishable from a normal successful render. */
  hasSilentVoiceover?: boolean;
  score: number;
  /**
   * RONDE 124 — the two numbers that were being collapsed into one.
   *
   * `score` is the EXPORT score: what the render is allowed to ship with, after the
   * export-availability policy has had its say. That policy exists for a real reason (a finished
   * video with real archive footage should not be blocked), but it is a statement about
   * availability, not about whether the pictures match the narration.
   *
   * Until this round it overwrote `score` in place, and the pre-policy number survived only in a
   * console line. Video 544 shipped as `score=85` when what the quality inputs actually measured
   * was 10 — held frames, unverified provenance, a scene covered by one clip. Anything reading
   * the stored report saw 85 and nothing else.
   *
   * Both are kept now. `rawVisualQualityScore` is what the quality inputs measured, and no policy
   * may ever raise it; `availabilityAdjustedScore` is what the policy raised it to, present only
   * when the policy actually fired. When they differ, that difference is the finding.
   */
  rawVisualQualityScore?: number;
  availabilityAdjustedScore?: number;
  /**
   * RONDE 105 — what the score is allowed to claim.
   *
   * A number on its own cannot say "nobody checked this". `status` can, and every reader that
   * shows the score should show this beside it: INSUFFICIENT_VERIFICATION means the content
   * decider approved nothing and the number is a floor, not a measurement.
   */
  qualityStatus: QualityStatus;
  qualityReason: string;
  /** Per-beat coverage and verification, from the single definition in ./beatVisualStatus. */
  beatVisuals?: BeatVisualTally;
  /** The beats that are not finished, one entry each, so the report can name them. */
  beatVisualProblems?: BeatVisualStatus[];
  /**
   * RONDE 166 — every beat, not only the unfinished ones.
   *
   * `beatVisualProblems` is this list filtered to the failures, which is right for a warning block
   * and wrong for an audit: [VisualFitAudit] has to report `verifiedFit` and `adoptedFit` too, and
   * counting those from a list the successes were removed from would print zero for both.
   */
  beatVisualStatuses?: BeatVisualStatus[];
};

/**
 * DIAGNOSTIC ONLY — a guess at a clip's source from its filename.
 *
 * RONDE 87: feeds `diagnosticBySource` and the quality score's existing inputs, never the official
 * `bySource`. See the long note on videoPipeline.inferClipSourceFromPath for why a filename cannot
 * establish a provider. Official attribution comes from the lineage ledger via `opts.resolveSource`.
 */
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

/**
 * RONDE 105 — how confident the report is allowed to sound.
 *
 * A numeric score implies a measurement. When the content decider answered nothing, there is no
 * measurement, and printing a number anyway is the defect this round exists to remove: a
 * production render shipped `100/100 (Excellent)` on a montage where the vision model had
 * approved not one frame and thirteen beats had no picture of their own.
 */
export type QualityStatus =
  /** Enough beats were checked, and enough passed, for the number to mean something. */
  | "VERIFIED"
  /** Some beats were checked; too many were not for the number to stand on its own. */
  | "PARTIALLY_VERIFIED"
  /** The content decider approved nothing. No numeric claim about relevance is defensible. */
  | "INSUFFICIENT_VERIFICATION";

/** What the score is computed from, and what it is allowed to say. */
export type QualityVerdict = {
  score: number;
  status: QualityStatus;
  /** Plain-language reason, for the report and the log. */
  reason: string;
};

/**
 * The ceiling each status may reach.
 *
 * 85 is where `qualityScoreLabel` in shared/videoQuality.ts starts saying "Excellent", so
 * INSUFFICIENT_VERIFICATION is capped well below it and PARTIALLY_VERIFIED just below it. These
 * are not arbitrary: they are the two bands that must be unreachable when nobody looked.
 */
const STATUS_CEILING: Record<QualityStatus, number> = {
  VERIFIED: 100,
  PARTIALLY_VERIFIED: 79,
  INSUFFICIENT_VERIFICATION: 45,
};

/**
 * Merit-based score from what the content decider actually verified, plus the sourcing mix.
 *
 * ── What changed in RONDE 105, and why ───────────────────────────────────────────────────────
 *
 * The base used to be `45 + avg * 5.5 + min * 0.5`, where avg and min were `visionScore10` — the
 * CLIP score. RONDE 103 removed CLIP as the content decider because its verdicts on this material
 * are measurably inverted (RONDE 58: a white-lives-matter sticker at 0.2226 against a signed
 * photograph of Hitler at 0.2116, same beat). The report went on grading the render with exactly
 * that number, and only four of the pipeline's adopt sites record it at all — so the average was
 * over a handful of clips and reached 100 whenever those few scored well.
 *
 * The base is now the share of beats that have a picture of their own AND were approved by the
 * one content decider this pipeline has. That is the claim the score was always pretending to
 * make. CLIP scores are still recorded and still shown in diagnostics; they no longer move it.
 *
 * The mix bonuses and the penalties below are RONDE 87's, unchanged in shape and weight — this
 * round replaces what the base measures, not how the rest of the report is built.
 */
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
  /**
   * RONDE 105: the beat-by-beat truth from ./beatVisualStatus, which is the ONE definition of
   * "this beat has its own picture and the decider approved it". Optional so callers outside a
   * render (tests, tools) still work — without it the render is INSUFFICIENT_VERIFICATION, which
   * is the honest answer when nothing is known rather than a free pass.
   */
  beatVisuals?: BeatVisualTally;
}): QualityVerdict {
  const t = params.beatVisuals;
  const beats = t?.beats ?? 0;
  const verified = t?.verifiedOwnVisual ?? 0;
  const checked =
    (t?.byVerification.verified_fit ?? 0) +
    (t?.byVerification.verified_mismatch ?? 0) +
    (t?.byVerification.reprieved_after_refusal ?? 0);

  /** Share of filled beats that are genuinely finished: real footage, approved. */
  const verifiedRatio = beats > 0 ? verified / beats : 0;
  /** Share of filled beats the decider managed to look at at all. */
  const checkedRatio = beats > 0 ? checked / beats : 0;

  let status: QualityStatus;
  let reason: string;
  if (beats === 0) {
    status = "INSUFFICIENT_VERIFICATION";
    reason = "geen beats geregistreerd — er valt niets te verifiëren";
  } else if (verified === 0) {
    status = "INSUFFICIENT_VERIFICATION";
    reason = `0 van ${beats} beats heeft eigen beeld dat de beeldgate heeft goedgekeurd`;
  } else if (checkedRatio < 0.5 || verifiedRatio < 0.5) {
    status = "PARTIALLY_VERIFIED";
    reason =
      `${verified} van ${beats} beats geverifieerd (${checked} beoordeeld) — ` +
      `te weinig om de montage als geheel te beoordelen`;
  } else {
    status = "VERIFIED";
    reason = `${verified} van ${beats} beats hebben goedgekeurd eigen beeld`;
  }

  // 40..95 from the verified share. A render where every beat is finished starts at 95 and earns
  // the last points from its sourcing mix, exactly as it did before.
  let score = Math.round(40 + 55 * verifiedRatio);

  const archiveRatio = params.totalClips > 0 ? params.archiveCount / params.totalClips : 0;
  if (params.archiveOnly && archiveRatio >= 0.85) score += 4;
  if ((params.byMixKind.real_video ?? 0) >= params.totalClips * 0.55) score += 4;

  score -= params.fallbackBeats * 14;
  score -= Math.min(12, params.stockCount * 3);
  score -= Math.min(params.fastShort ? 8 : 16, params.offTopicCount * (params.fastShort ? 4 : 8));
  score -= Math.min(params.fastShort ? 10 : 20, params.geoViolationCount * (params.fastShort ? 6 : 12));
  if (params.postRenderOk === false) score -= 8;

  /**
   * RONDE 105 — beats that got a stand-in instead of footage cost points, all of them.
   *
   * The old score only decremented for `fallbackBeats`, which matches the adopt routes "fallback"
   * and "rescue_placeholder". A held frame, a graphic, a generated clip and a reused shot were
   * all free — which is how a montage with thirteen of them scored 100. Weighted below the
   * colour-card penalty because a held frame is a worse shot, not an absent one.
   */
  if (t) {
    const standIns =
      t.byCoverage.held_frame + t.byCoverage.graphic + t.byCoverage.generated + t.byCoverage.none;
    score -= Math.min(30, standIns * 5);
    /**
     * RONDE 112 — subject-fallback footage costs less than a stand-in, and more than nothing.
     *
     * Two facts have to both survive in the number. The beat did NOT get a picture verified
     * against its own claim, so it cannot be free. And the picture is real footage of the right
     * subject, which is a different and much better outcome than a held frame, a graphic or a
     * colour card — so it cannot cost the same 5.
     *
     * 3 is the largest weight strictly below the stand-in weight, and the cap is scaled the same
     * way (12 against 30). Neither number is tuned for a target score; they encode that ordering
     * and nothing else.
     */
    score -= Math.min(12, t.byCoverage.subject_only * 3);
    // A shot used over the decider's objection is a known risk, and says so in the number too.
    score -= Math.min(15, t.byVerification.reprieved_after_refusal * 5);
    score -= Math.min(10, t.byVerification.verified_mismatch * 5);
  }

  score = Math.max(0, Math.min(STATUS_CEILING[status], Math.round(score)));
  return { score, status, reason };
}

export function buildVideoQualityReport(
  clipPaths: string[],
  videoTitle: string,
  opts?: {
    pipelineSec?: number;
    stockBeatsUsed?: number;
    rejectAudit?: ClipRejectEntry[];
    /**
     * RENDER 569 — THE SAME AUDIT, UNCAPPED.
     *
     * `rejectAudit` above is the BOUNDED detail: named examples, capped at 400 entries and filled
     * chronologically. Passing it to `summarizeClipRejectAudit` takes that function's array
     * branch, which counts entries — so the render-wide breakdown was a count of the first 400
     * refusals, not of all of them.
     *
     * Render 569 recorded 515 and dropped 115, and its export-gate message read
     * "400 rejected. Top reject reasons: shortlist_full=179, FUNNEL_WITHOUT_EVIDENCE=162, …" —
     * numbers summing exactly to the cap, which is what a truncated tally looks like.
     *
     * RONDE 70 built the uncapped per-beat tally precisely because a chronological cap made late
     * beats report refusals they had earned as zero, and `summarizeClipRejectAudit`'s object
     * branch reads it. The per-beat counts were moved over; this report was not. Same seam,
     * one route short.
     */
    rejectTally?: ClipRejectAudit;
    adoptAudit?: ClipAdoptEntry[];
    archiveOnly?: boolean;
    fastShort?: boolean;
    sceneCriticalFailed?: number[];
    /**
     * RONDE 86/87: the render's own record of where each clip came from.
     *
     * `inferClipSourceFromPath` reads a provider out of a FILENAME, and by the time a clip reaches
     * this report it has been trimmed, padded and overlaid — render 536's own compose manifest
     * could not name the source of 27 of its 66 clips for exactly that reason.
     *
     * RONDE 87 makes this the ONLY input to the official attribution. It must return the proven
     * provider or null; a null becomes UNVERIFIED, never a filename guess. The filename reading is
     * still computed, but only into `diagnosticBySource` — see below.
     */
    resolveSource?: (clipPath: string) => string | null | undefined;
    /**
     * RONDE 105: the render's relevance ledger. Without it every beat reads as `never_asked`,
     * which is the honest answer for a caller that has no render — not a free pass.
     */
    relevanceLedger?: BeatRelevanceLedger;
  }
): VideoQualityReport {
  /** Official, lineage-only attribution. */
  const bySource: Record<string, number> = {};
  /**
   * RONDE 87: the old filename-derived counts, kept as pure diagnostics.
   *
   * Two reasons this is not simply deleted. It is the measurement that says how far the lineage
   * wiring still has to go — a clip counted under `wikimedia` here and `UNVERIFIED` above is an
   * unrecorded hop worth fixing. And the quality SCORE has always been computed from these
   * numbers; §L of this round forbids changing scoring behaviour, so the score keeps reading
   * exactly the counts it read before while the official report reads the ledger.
   */
  const diagnosticBySource: Record<string, number> = {};
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
    const nameHint = inferClipSourceFromPath(clipPath);
    diagnosticBySource[nameHint] = (diagnosticBySource[nameHint] ?? 0) + 1;
    if (opts?.resolveSource) {
      // Lineage only. A resolver that cannot prove the source says so, and the clip is counted as
      // UNVERIFIED — which is a finding, not a bucket to be quietly reassigned to `nameHint`.
      const recorded = opts.resolveSource(clipPath)?.trim().toLowerCase();
      const source = recorded && recorded !== "unknown" ? recorded : UNVERIFIED_SOURCE;
      bySource[source] = (bySource[source] ?? 0) + 1;
    } else {
      // No ledger supplied (tests, tools, callers outside a render). The filename reading is all
      // there is, and it is reported as-is rather than pretending to a certainty it does not have.
      bySource[nameHint] = (bySource[nameHint] ?? 0) + 1;
    }
    const mix = classifyClipMixKind(clipPath);
    byMixKind[mix]++;

    // RONDE 30: underscores and hyphens are normalised to spaces before matching.
    //
    // The haystack is a FILENAME plus the video title, and clip filenames separate words with
    // underscores ("scene_2_force_serp_columbus_city_council.mp4"). Nearly every pattern in
    // GEO_URBAN_OFFTOPIC_RE is multi-word with real spaces ("columbus city", "city council
    // meeting", "auto dealer", "talking head interview"), and `\b` does not treat "_" as a word
    // boundary — so those patterns could never match a filename. Only the handful of
    // single-word entries ("ford", "walgreens") ever fired, which is why the off-topic suspect
    // list came back empty even for a clip named after something on the list.
    const hay = `${path.basename(clipPath)} ${videoTitle}`
      .toLowerCase()
      .replace(/[_-]+/g, " ");
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

  // RONDE 87: these three feed computeQualityScore and the warnings below, and both have always
  // been computed from the filename reading. §L forbids changing scoring behaviour in this round,
  // so they keep reading exactly what they read before — now under the name that says what it is.
  const wikimediaCount = (diagnosticBySource.wikimedia ?? 0) + (diagnosticBySource.openverse ?? 0);
  const archiveCount = diagnosticBySource.archive ?? 0;
  const stockCount = (diagnosticBySource.pexels ?? 0) + (diagnosticBySource.pixabay ?? 0);

  if (!archiveOnly && wikimediaCount === 0 && unique.length >= 3) {
    warnings.push("Geen Wikimedia-stills — controleer zoekqueries of WIKIMEDIA_V1_THRESHOLD.");
  }
  if (stockCount > unique.length * 0.25) {
    warnings.push(`Veel stock (${stockCount}/${unique.length}) — vul archief aan met relevante clips (titel volstaat; AI tagt bij upload).`);
  }
  if (offTopicSuspects.length > 0) {
    warnings.push(`${offTopicSuspects.length} clip(s) met kwaliteitswaarschuwing.`);
  }
  // RONDE 87: an unproven source is its own warning, and it names the right problem — the render
  // could not establish where the clip came from, which is a lineage gap, not a mystery provider.
  const unverifiedClips = bySource[UNVERIFIED_SOURCE] ?? 0;
  if (unverifiedClips > 0) {
    warnings.push(`${unverifiedClips} clip(s) met niet-bewezen bron (UNVERIFIED).`);
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

  /** The complete tally when it was handed over; the bounded entries only as a fallback. */
  const rejectSummary = opts?.rejectTally
    ? summarizeClipRejectAudit(opts.rejectTally)
    : opts?.rejectAudit?.length
      ? summarizeClipRejectAudit(opts.rejectAudit)
      : undefined;
  const topRejects = opts?.rejectAudit?.slice(0, 12);

  /**
   * RONDE 105 — one definition of a finished beat, computed once and used by the score, the
   * warnings and the log. Three subsystems used to derive this separately and disagreed.
   */
  const beatStatuses = buildBeatVisualStatuses(opts?.adoptAudit, opts?.relevanceLedger);
  const beatVisuals = tallyBeatVisualStatuses(beatStatuses);
  const beatVisualProblems = beatStatuses.filter((b) => !b.verifiedOwnVisual);
  if (beatVisuals.beats > 0 && beatVisualProblems.length > 0) {
    const byReason = new Map<string, number>();
    for (const b of beatVisualProblems) byReason.set(b.reason, (byReason.get(b.reason) ?? 0) + 1);
    const detail = [...byReason.entries()].map(([r, n]) => `${r}=${n}`).sort().join(", ");
    warnings.push(
      `${beatVisualProblems.length} van ${beatVisuals.beats} beat(s) zonder goedgekeurd eigen ` +
        `beeld (${detail})`
    );
  }

  const verdict = computeMeritQualityScore({
    beatVisuals,
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
    diagnosticBySource,
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
    score: verdict.score,
    qualityStatus: verdict.status,
    qualityReason: verdict.reason,
    beatVisuals,
    beatVisualProblems: beatVisualProblems.length > 0 ? beatVisualProblems : undefined,
    beatVisualStatuses: beatStatuses.length > 0 ? beatStatuses : undefined,
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

/** One reason a render must not be delivered, whatever its score says. */
export type IndefensibleExportCondition = {
  /** Machine-readable, stable, and the same word in the log and the thrown error. */
  code: "NO_VERIFIED_OWN_VISUAL" | "MOSTLY_UNVERIFIED_CLIPS";
  detail: string;
};

/** More than half the delivered clips having no proven source is the second condition's bar. */
const UNVERIFIED_CLIP_SHARE_LIMIT = 0.5;

/**
 * RONDE 89 — THE TWO THINGS A SCORE MAY NOT OVERRULE.
 *
 * ── What render 568 delivered ───────────────────────────────────────────────────────────────
 *
 *     [Quality] Video 568: visual quality raw=24/100, availabilityAdjusted=82/100
 *               (export minimum 45) … The adjusted number is an availability decision, NOT a
 *               measurement of picture quality; raw is the measurement.
 *     [Quality] Video 568: export gate passed (score=82/100)
 *
 * The pipeline measured the picture at 24/100, an availability policy raised it to 82, and the
 * gate decided on the raised number. The log said out loud that the number it was deciding on was
 * not a measurement, and shipped anyway.
 *
 * What shipped, from the same render:
 *
 *     15 of 17 beats   visual_status=no_verified_visual verification=never_asked
 *                      reason=real_footage_never_judged
 *     17 of 20 clips   provider=UNVERIFIED
 *     240              beeldgate-momenten niet bevraagd — "die clips zijn ONGEZIEN aangenomen"
 *
 * ── Why this is a separate gate and not a threshold change ──────────────────────────────────
 *
 * Raising the minimum score would trade one arbitrary number for another, and the availability
 * policy would still be the thing being compared against it. These two conditions are not about
 * DEGREE. They are the cases where the render cannot answer "why is this picture on screen?" at
 * all, for the film as a whole:
 *
 *   NO_VERIFIED_OWN_VISUAL   not one beat got a picture of its own that the picture editor
 *                            looked at and approved. Whatever the montage contains, nothing in
 *                            it was verified to belong to the sentence it plays under.
 *   MOSTLY_UNVERIFIED_CLIPS  most of the delivered film has no proven provider — the lineage
 *                            cannot say where the pictures came from.
 *
 * A score can be argued with. Neither of these can.
 *
 * ── Deliberately unconditional ──────────────────────────────────────────────────────────────
 *
 * Every other check in `enforceQualityExportGate` fires only under `ENABLE_QUALITY_EXPORT_HARD_TIER`
 * (opt-in, default off) or `strictQualityExportEnabled()`. This one is checked before either,
 * because a flag that has to be remembered is exactly how render 568 shipped: the conditions
 * below were all true and every switch that could have stopped it was off.
 *
 * ── What it deliberately does NOT do ────────────────────────────────────────────────────────
 *
 * It does not judge picture quality, framing, relevance or pacing — those are the score's job and
 * it is left alone. It does not fire on missing data: a report built without a relevance ledger
 * or without clips (a tool, a test, a caller outside a render) yields no conditions, because
 * "nothing was measured" is not evidence of a bad render. And it never lowers a threshold or
 * relabels an outcome — it only refuses to call a render deliverable when the render itself has
 * already recorded that it could not verify what it shows.
 */
export function indefensibleExportConditions(
  report: VideoQualityReport
): IndefensibleExportCondition[] {
  const out: IndefensibleExportCondition[] = [];

  const beats = report.beatVisuals;
  if (beats && beats.beats > 0 && beats.verifiedOwnVisual === 0) {
    const neverAsked = beats.byVerification.never_asked;
    out.push({
      code: "NO_VERIFIED_OWN_VISUAL",
      detail:
        `0 of ${beats.beats} beat(s) got an approved picture of their own ` +
        `(never_asked=${neverAsked}, own_footage=${beats.ownFootage}) — ` +
        `nothing on screen was verified against the narration it plays under`,
    });
  }

  const unverified = report.bySource[UNVERIFIED_SOURCE] ?? 0;
  if (report.totalClips > 0 && unverified / report.totalClips > UNVERIFIED_CLIP_SHARE_LIMIT) {
    const pct = Math.round((unverified / report.totalClips) * 100);
    out.push({
      code: "MOSTLY_UNVERIFIED_CLIPS",
      detail:
        `${unverified} of ${report.totalClips} delivered clip(s) have no proven source ` +
        `(${pct}%, limit ${Math.round(UNVERIFIED_CLIP_SHARE_LIMIT * 100)}%) — ` +
        `the lineage cannot say where most of this film came from`,
    });
  }

  return out;
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

/**
 * Problem 10 (production render finding — "Why Hitler Killed Himself and His Wife"): unlike
 * assertQualityReportExportGate above (deliberately non-blocking, geo-only), this gate is
 * deliberately BLOCKING. A real render was found where actual sourced footage stopped after a
 * few seconds and a static color/text placeholder silently filled the rest of the video, while
 * the pipeline still reported the render as a normal success. This throws (PIPELINE_ERROR.
 * QUALITY_GATE — the existing quality-gate failure code, videos.errorMessage-storable) instead
 * of letting that ship, whenever:
 *   - any whole SCENE had to fall back to generateColorFallback as its entire composed output
 *     (sceneRescueColorFallbackCount > 0 — every real/rescue attempt for that scene failed, no
 *     ambiguity), or
 *   - a strict MAJORITY of filled beats were sourced via the per-beat color/text fallback
 *     (adoptAuditSummary.fallbackBeats), meaning most of what's on screen is placeholder, not
 *     real footage.
 * A handful of isolated fallback beats in an otherwise well-sourced video is not blocked — only
 * the two patterns above, which is what an actually-broken render looks like.
 */
export function assertVisualCoverageExportGate(
  report: VideoQualityReport,
  sceneRescueColorFallbackCount: number
): void {
  const summary = report.adoptAuditSummary;
  const beatsFilled = summary?.beatsFilled ?? 0;
  const fallbackBeats = summary?.fallbackBeats ?? 0;
  const majorityFallback = beatsFilled > 0 && fallbackBeats / beatsFilled > 0.5;
  if (sceneRescueColorFallbackCount === 0 && !majorityFallback) return;

  const rejectCounts = report.rejectSummary ?? {};
  const totalRejected = Object.values(rejectCounts).reduce((a, b) => a + b, 0);
  const topReasons = Object.entries(rejectCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([reason, count]) => `${reason}=${count}`)
    .join(", ") || "none recorded";
  const worstBeats = (report.topRejects ?? [])
    .slice(0, 5)
    .map((r) => `s${r.sceneIndex}b${r.beatIndex}:${r.reason}`)
    .join("; ") || "none recorded";

  throw pipelineError(
    PIPELINE_ERROR.QUALITY_GATE,
    `Render rejected — insufficient real visual coverage: ` +
      `${sceneRescueColorFallbackCount} scene(s) fell back entirely to a static placeholder, ` +
      /**
       * RENDER 569 — "used" was the wrong word, and it cost a film.
       *
       * `fallbackBeats` now counts beats whose ONLY adoption was a card; a beat holding real
       * footage plus a card is counted under its real source and reported as mixed. Before that
       * fix this line said "14/14 filled beat(s) used the color/text fallback" about a render
       * whose per-beat ledger named ten adopted archive, Wikimedia and SerpAPI files.
       */
      `${fallbackBeats}/${beatsFilled} filled beat(s) got ONLY the color/text fallback, ` +
      `${report.totalClips} accepted candidate(s), ${totalRejected} rejected. ` +
      `Top reject reasons: ${topReasons}. Worst beats: ${worstBeats}.`
  );
}

/**
 * RENDER 562 — A VIDEO NOBODY LOOKED AT DOES NOT SHIP.
 *
 * ── What happened ───────────────────────────────────────────────────────────────────────────
 *
 * The beat image gate is the only judge in this pipeline that has seen the frame AND read the
 * narration. On 2 September it lost every provider it has:
 *
 *     09:37:33  [LLM] OpenAI quota spent — standing down for 30min
 *     09:40:30  Gemini 403 PERMISSION_DENIED — "project has been denied access"
 *               Groq is excluded from image calls entirely (its vision models 404)
 *     09:42:22  [BeatImageGate] no verdict: 23x gate could not ask
 *
 * The gate fails OPEN by design — an outage must not be able to empty a montage — so 23 clips
 * were adopted with no judgement, and the render finished, uploaded, and was marked `completed`.
 * One of them was archive footage of a present-day "White Lives Matter" demonstration, sitting in
 * a documentary about the Second World War.
 *
 * ── Why there is no local substitute ────────────────────────────────────────────────────────
 *
 * The obvious repair — let CLIP decide when the model cannot — is the repair this file's sibling
 * already tried and measured as WRONG. On this exact material CLIP's ordering is inverted: render
 * 531 scored the offending sticker 0.2226 and a signed photograph of Hitler 0.2116 on the same
 * beat, so a CLIP veto deletes the right picture and keeps the wrong one. See RONDE 58's header in
 * beatImageRelevanceGate.ts. There is no cheaper judge to fall back to.
 *
 * So the only honest options are a working gate, or not shipping. This is the second.
 *
 * ── What it refuses, and what it deliberately does not ──────────────────────────────────────
 *
 * BOTH conditions must hold:
 *
 *   1. a vision provider was unreachable — `judgementsProviderUnavailable`, a counter incremented
 *      only on the two provider-outage declines. NOT the budget ceiling, NOT a missing frame, NOT
 *      the gate being switched off: those are the render working as configured, and a render that
 *      is thrifty is not a render that is blind.
 *   2. real footage reached a beat that received NO verdict at all. Unjudged footage on screen is
 *      the harm; an outage that costs nothing but a few skipped candidates is not.
 *
 * A render where every provider is down but the gate is switched off passes — the operator turned
 * the judge off on purpose. A render where the outage cost only candidates that were never used
 * passes. What cannot pass is delivering pictures nobody approved.
 *
 * The counts come from the beat audit rather than from prose in `noVerdictReasons`: this module's
 * own RONDE 115 note warns that matching on message substrings rots the moment a message is
 * reworded, and a gate that decides whether a video ships must not rest on that.
 */
export type VisionCoverageBeat = {
  sceneIndex: number;
  beatIndex: number;
  /** Verdicts the gate actually returned for this beat: accepted + rejected + unclear. */
  verdicts: number;
  /** Did real footage end up on screen for this beat? */
  hasRealFootage: boolean;
};

export function assertVisionCoverageExportGate(params: {
  /** Declines caused by an unreachable provider — never a budget or configuration decline. */
  providerUnavailable: number;
  beats: readonly VisionCoverageBeat[];
  /** The gate's own one-line summary of why it produced no verdicts, for the failure message. */
  noVerdictSummary?: string;
}): void {
  if (params.providerUnavailable <= 0) return;
  const unchecked = params.beats.filter((b) => b.hasRealFootage && b.verdicts === 0);
  if (unchecked.length === 0) return;

  const named = unchecked
    .slice(0, 6)
    .map((b) => `s${b.sceneIndex}b${b.beatIndex}`)
    .join(", ");
  const withFootage = params.beats.filter((b) => b.hasRealFootage).length;
  throw pipelineError(
    PIPELINE_ERROR.QUALITY_GATE,
    `Render rejected — the picture editor was unreachable and this video contains footage nobody ` +
      `judged: ${unchecked.length} of ${withFootage} beat(s) with real footage received no verdict ` +
      `(${named}${unchecked.length > 6 ? ", …" : ""}), after ${params.providerUnavailable} ` +
      `judgement(s) were declined for want of a vision provider. ` +
      `${params.noVerdictSummary || "No provider was reachable."} ` +
      `Restore a vision provider (OpenAI credit, or a Gemini key whose project is not denied) and ` +
      `re-render; set ENABLE_BEAT_IMAGE_RELEVANCE_GATE=false only if you accept unjudged footage.`
  );
}

/**
 * RONDE 132 §10 — the short-montage warning, with the numbers that make it actionable.
 *
 * It used to read:
 *
 *     short montage: scene(s) 1, 2 had less footage than voice
 *                    — the tail may be filled by holding the last frame
 *
 * No seconds, no clip counts, and a "may" that left the reader unable to tell whether anything
 * froze at all. A 0.3s shortfall is a rounding artefact and a 12s one is a visible defect; both
 * produced that same sentence.
 *
 * The worst scene is named because that is the one worth looking at, and the total says whether
 * the render has one bad scene or a systemic shortage.
 */
export function formatMontageShortfallWarning(
  shortfalls: ReadonlyArray<{
    sceneIndex: number;
    shortBySec: number;
    uniqueClips: number;
    neededClips: number;
  }>,
  padScenes: readonly number[]
): string {
  if (shortfalls.length === 0) {
    // The estimate flagged the scene but no shortfall was recorded — keep the old, weaker sentence
    // rather than inventing a number for it.
    return (
      `short montage: scene(s) ${padScenes.join(", ")} had less footage than voice — ` +
      `the tail may be filled by holding the last frame`
    );
  }
  const worst = [...shortfalls].sort((a, b) => b.shortBySec - a.shortBySec)[0]!;
  const total = shortfalls.reduce((sum, s) => sum + s.shortBySec, 0);
  return (
    `short montage: ${shortfalls.length} scene(s) had less footage than voice — ` +
    `${total.toFixed(1)}s short in total, worst scene ${worst.sceneIndex} at ` +
    `${worst.shortBySec.toFixed(1)}s (${worst.uniqueClips} unique clip(s), ` +
    `${worst.neededClips} needed) — that time is filled by holding the last frame`
  );
}
