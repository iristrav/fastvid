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

import type { RejectionRegistry, RejectionEntry } from "./rejectionRegistry";
import { summarizeRejections } from "./rejectionRegistry";
import type { ClipAdoptEntry, AdoptAuditSummary } from "./clipAdoptAudit";
import { summarizeAdoptAudit } from "./clipAdoptAudit";
import { judgeArchiveAssetCountry, resolveRequiredGeoTagsForBeat } from "./visualJudge";
import type { BeatGeoRegion } from "./vidrushQuality";
import type { VoiceVisualMatchSummary } from "./voiceVisualMatch";
import { buildVoiceVisualMatchSummary } from "./voiceVisualMatch";
import { UNVERIFIED_PROVIDER as UNVERIFIED_SOURCE } from "./visualSourceLineage";
import {
  buildBeatVisualStatuses,
  tallyBeatVisualStatuses,
  type BeatVisualStatus,
  type BeatVisualTally,
} from "./beatVisualStatus";
import type { BeatRelevanceLedger } from "./beatVisualRelevance";
import type { ScreenTimeFinding } from "./deliveredScreenTime";
import { indefensibleExportConditions, visualCoverageFallsShort } from "./deliveryGate";

export type { VoiceVisualMatchSummary };

/**
 * THE ONE DEFINITION OF "THIS DELIVERED CLIP IS WORTH A SECOND LOOK".
 *
 * Only reasons the pipeline can actually establish. A doubt it cannot prove is not a doubt, it is
 * a guess, and a report full of guesses trains a reader to ignore it.
 *
 *   unproven_source        the lineage ledger could not name where the bytes came from. This is the
 *                          same fact `bySource[UNVERIFIED]` counts and the export gate refuses a
 *                          majority of; here it is attached to the clip rather than to a total.
 *   drawn_not_fetched      the render drew this frame itself — a colour or text card. Real, and not
 *                          footage, which is a different claim from "we lost its provenance".
 *   no_content_identity    nothing about the file resolves to a content key, so it cannot be
 *                          matched against anything the render recorded.
 */
export type SuspiciousClipReason =
  | "unproven_source"
  | "drawn_not_fetched"
  | "no_content_identity";

/**
 * Why this clip is worth a second look, or null when there is nothing to say about it.
 *
 * Pure, and it EXCLUDES NOTHING. Callers count and list what it returns; no caller may use it to
 * drop a clip from a measurement — see `clipAccounting` for why that would be the wrong repair.
 */
export function suspiciousDeliveredClip(
  clipPath: string,
  opts?: {
    resolveSource?: (clipPath: string) => string | null | undefined;
    isGeneratedClip?: (clipPath: string) => boolean;
    contentKeyOf?: (clipPath: string) => string | undefined;
  }
): SuspiciousClipReason | null {
  if (opts?.isGeneratedClip?.(clipPath)) return "drawn_not_fetched";
  if (opts?.resolveSource) {
    const recorded = opts.resolveSource(clipPath)?.trim().toLowerCase();
    if (!recorded || recorded === "unknown") return "unproven_source";
  }
  if (opts?.contentKeyOf && !opts.contentKeyOf(clipPath)) return "no_content_identity";
  return null;
}

/**
 * The three numbers and the named doubts, built where the clip list is known.
 *
 * `measured` equals `delivered` and `excluded` is 0 — by construction, not by coincidence. If a
 * future round ever wants to exclude a clip from the score, it will have to change this function,
 * and this comment is where it will find out why that is the wrong instinct.
 */
function clipAccountingFor(
  unique: readonly string[],
  opts?: {
    resolveSource?: (clipPath: string) => string | null | undefined;
    isGeneratedClip?: (clipPath: string) => boolean;
  }
): NonNullable<VideoQualityReport["clipAccounting"]> {
  const suspicious: Array<{ basename: string; reason: SuspiciousClipReason }> = [];
  for (const clipPath of unique) {
    const reason = suspiciousDeliveredClip(clipPath, opts);
    if (reason) suspicious.push({ basename: path.basename(clipPath), reason });
  }
  return { delivered: unique.length, measured: unique.length, excluded: 0, suspicious };
}

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
   * Delivered clips the render DREW rather than fetched — colour and text cards.
   *
   * Kept beside `bySource` rather than folded into it: they are counted as UNVERIFIED there, which
   * is right (they have no provider), and misleading as a provenance FAILURE, which is what
   * MOSTLY_UNVERIFIED_CLIPS reads. Absent when no ledger could answer.
   */
  generatedClips?: number;
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
  /**
   * WHICH FILE THE CLIP FIGURES ABOVE DESCRIBE — and the score, which is computed from four of them.
   *
   * `selected_clips` is where every report starts: at stage 6 no film exists yet, so the figures
   * count the scenes' selected clips. `delivered_render` means they were re-counted against the
   * delivered file's own clip list — see `recountQualityReportForDeliveredClips`.
   * `compose_montage` appears only on records written before RONDE 661 removed the compose route.
   *
   * Absent on a record written before this field existed. Absent is not `selected_clips`: an old
   * report cannot say which it was, and guessing on its behalf is how a report starts lying.
   */
  clipsMeasuredOn?: "selected_clips" | "compose_montage" | "delivered_render";
  /**
   * DELIVERED, MEASURED, EXCLUDED — so an invisible exclusion cannot exist.
   *
   * A report that silently measured sixteen of twenty delivered clips would read as a twenty-clip
   * film that happened to score well. These three numbers make that impossible to hide, and today
   * they make something else plain: `excluded` is ZERO, always, because nothing is dropped from
   * the measurement. `suspicious` counts clips the pipeline can name a doubt about (see
   * `suspiciousDeliveredClip`) and they are counted, listed and still measured.
   *
   * The doubt is worth reporting; acting on it by removing the clip from the score would improve
   * the number by deleting the evidence, which is the one thing a quality report must never do.
   */
  clipAccounting?: {
    delivered: number;
    measured: number;
    excluded: number;
    suspicious: Array<{ basename: string; reason: SuspiciousClipReason }>;
  };
  warnings: string[];
  offTopicSuspects: Array<{ basename: string; reason: string }>;
  rejectSummary?: Record<string, number>;
  topRejects?: RejectionEntry[];
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
   * R195 — DOES THE PICTURE COVER THE NARRATION, IN THE FILE THE VIEWER RECEIVED?
   *
   * ── The one defect a viewer notices first, and the only check that sees it ──────────────────
   *
   * `checkFileAvSync` measures both stream lengths and the sound envelope of a finished MP4 and
   * names `audio_past_picture` — narration still running after the picture has ended. Video 574's
   * delivered file measured 68.04s of video against 69.88s of audio and shipped without a word,
   * because:
   *
   *   · on the render-job route the check RAN, was returned in the outcome with a doc comment
   *     saying "Returned rather than only logged so the caller can put it in the quality report",
   *     and the caller read `outputUrl`, `durationSec`, `spotCheck`, `renderedClipIds`, `code` and
   *     `message` — never `avSync`;
   *   · on the compose route it was never computed at all.
   *
   * Both halves are the same gap: the measurement existed, and the route that delivers never took
   * it. It reports and does not gate, the same policy `postRenderSpotCheck` has always had.
   *
   * `measuredOn` follows the rule the spot check and the stillness audit already use: a number
   * about a file the viewer did not receive is worse than no number, because it reads as
   * reassurance. Absent means the probe could not run — never a pass.
   */
  avSync?: {
    measuredOn: "delivered_render" | "compose_montage";
    ok: boolean;
    videoSec: number | null;
    audioSec: number | null;
    /** Findings as `code(+deltaSec)`, so the report says what was wrong and by how much. */
    findings: string[];
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
    /**
     * WHICH FILE THIS BLOCK DESCRIBES.
     *
     * The stillness and repetition audits run at stage 6, on the compose montage, because that is
     * the first point a finished MP4 exists. After the delivery cutover the viewer may instead
     * receive the cinematic timeline render, produced eight hundred lines later by a different
     * renderer from its own clip list — and neither audit is re-run on it.
     *
     * `postRenderSpotCheck` solved the same problem by overwriting itself with the render job's own
     * check on the delivered file. These two cannot: each is a multi-minute ffmpeg pass, and paying
     * for it twice per render to re-measure something that decides nothing is the wrong trade.
     *
     * So the claim is withdrawn rather than restated. `compose_montage` means: these numbers are
     * real, they were measured, and they are about a file this viewer did not receive. That is the
     * honest reading, and it is the one the render log already applies to the spot check — a report
     * about a different video is worse than no report, because it reads as reassurance.
     */
    measuredOn: "delivered_file" | "compose_montage";
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
    /** Which file this block describes — see the note on `stillness.measuredOn`. */
    measuredOn: "delivered_file" | "compose_montage";
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
   * WHAT THE DELIVERED MIX COST THE SCORE — see `./deliveredScreenTime`.
   *
   * Measured in seconds on the composed clip list, stored here so every later reader of this
   * report scores it the same way. `recountQualityReportForDeliveredClips` and the two post-render
   * re-scores all re-run `computeMeritQualityScore`; without the findings ON the report, the
   * penalty below would exist at build time and quietly vanish at the first re-score.
   */
  screenTime?: ScreenTimeFinding[];
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
  byMixKind: Record<VisualMixKind, number>;
  postRenderOk?: boolean;
  /**
   * RONDE 105: the beat-by-beat truth from ./beatVisualStatus, which is the ONE definition of
   * "this beat has its own picture and the decider approved it". Optional so callers outside a
   * render (tests, tools) still work — without it the render is INSUFFICIENT_VERIFICATION, which
   * is the honest answer when nothing is known rather than a free pass.
   */
  beatVisuals?: BeatVisualTally;
  /**
   * What the delivered mix measured, from `./deliveredScreenTime`. Optional: a caller with no
   * render measured nothing, and "nothing was measured" costs nothing — see the penalty below.
   */
  screenTime?: readonly ScreenTimeFinding[];
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
  score -= Math.min(16, params.offTopicCount * (8));
  score -= Math.min(20, params.geoViolationCount * (12));
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

  /**
   * WHAT THE VIEWER SPENT THE FILM LOOKING AT — the one input measured on the cut itself.
   *
   * Every term above counts beats and clips. None of them can see that a 76-second film gave 36.3
   * of those seconds to one piece of footage and held a single shot for 17.4 of them: thirteen
   * clips, thirteen filled beats, and a number that read 43 for reasons that had nothing to do
   * with the two things a viewer would name first.
   *
   * Only two of the three findings are scored, and the line between them is a real one.
   * `ONE_SOURCE_DOMINATES` describes a SOURCING POLICY — an operator who runs an archive-led
   * documentary chooses it, and the `archiveOnly` bonus twenty lines up rewards exactly that, so
   * charging for it here would have the score paying and fining for one decision. A single shot's
   * share of the film and a single shot's length are not policy in any mode; they are what a
   * scene short of footage looks like. Those two cost points.
   *
   * Weighted against the stand-in penalty above it: one shot filling the film is worse than one
   * beat getting a held frame (5) and better than a montage of them (30); a held shot is the
   * lighter of the pair because the footage is at least real. Neither number is tuned to a target
   * — they encode that ordering.
   */
  for (const finding of params.screenTime ?? []) {
    if (finding.code === "ONE_CLIP_DOMINATES") score -= 12;
    else if (finding.code === "SHOT_HELD_TOO_LONG") score -= 8;
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
    rejectAudit?: RejectionEntry[];
    /** Did the render DRAW this clip? See `generatedClips` — absent means "no ledger to ask". */
    isGeneratedClip?: (clipPath: string) => boolean;
    /**
     * RENDER 569 — THE SAME AUDIT, UNCAPPED.
     *
     * `rejectAudit` above is the BOUNDED detail: named examples, capped at 400 entries and filled
     * chronologically. Passing it to `summarizeRejections` takes that function's array
     * branch, which counts entries — so the render-wide breakdown was a count of the first 400
     * refusals, not of all of them.
     *
     * Render 569 recorded 515 and dropped 115, and its export-gate message read
     * "400 rejected. Top reject reasons: shortlist_full=179, FUNNEL_WITHOUT_EVIDENCE=162, …" —
     * numbers summing exactly to the cap, which is what a truncated tally looks like.
     *
     * RONDE 70 built the uncapped per-beat tally precisely because a chronological cap made late
     * beats report refusals they had earned as zero, and `summarizeRejections`'s object
     * branch reads it. The per-beat counts were moved over; this report was not. Same seam,
     * one route short.
     */
    rejectTally?: RejectionRegistry;
    adoptAudit?: ClipAdoptEntry[];
    archiveOnly?: boolean;
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
    /**
     * The delivered mix, measured in seconds by `./deliveredScreenTime` just before this runs.
     * Stored on the report AND fed to the score, so a later re-score reads the same facts.
     */
    screenTime?: readonly ScreenTimeFinding[];
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
  let generatedClips = 0;
  const byMixKind = emptyMixCounts();
  const warnings: string[] = [];
  const offTopicSuspects: Array<{ basename: string; reason: string }> = [];
  const primaryGeo = inferPrimaryGeoFromTitle(videoTitle);
  const visualTopic = inferVideoVisualTopic(videoTitle, videoTitle);
  const archiveOnly = opts?.archiveOnly === true;
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
      /** Counted here too, and kept apart — a drawn card has no provider to have lost. */
      if (source === UNVERIFIED_SOURCE && opts.isGeneratedClip?.(clipPath)) generatedClips += 1;
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
    if (judgeArchiveAssetCountry(assetLike, adopt.beatText, videoTitle, adopt.segmentGeoLock as BeatGeoRegion | null).decision === "REJECT") {
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
    ? summarizeRejections(opts.rejectTally)
    : opts?.rejectAudit?.length
      ? summarizeRejections(opts.rejectAudit)
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
    byMixKind,
    screenTime: opts?.screenTime,
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
    /** Stage 6 has no finished film yet: these are the scenes' selected clips. See the field's own note. */
    clipsMeasuredOn: "selected_clips",
    clipAccounting: clipAccountingFor(unique, opts),
    warnings,
    offTopicSuspects,
    criticalGeoViolations: criticalGeoViolations.length > 0 ? criticalGeoViolations : undefined,
    generatedClips,
    rejectSummary,
    topRejects,
    pipelineSec: opts?.pipelineSec,
    stockBeatsUsed: opts?.stockBeatsUsed,
    adoptAuditSummary,
    voiceVisualMatch,
    score: verdict.score,
    qualityStatus: verdict.status,
    qualityReason: verdict.reason,
    /** Kept on the report so every later re-score charges for the same delivered mix. */
    screenTime: opts?.screenTime ? [...opts.screenTime] : undefined,
    beatVisuals,
    beatVisualProblems: beatVisualProblems.length > 0 ? beatVisualProblems : undefined,
    beatVisualStatuses: beatStatuses.length > 0 ? beatStatuses : undefined,
  };
}

/**
 * RE-COUNT THE CLIP FIGURES AGAINST THE FILE THE VIEWER ACTUALLY RECEIVES.
 *
 * ── The number that described the wrong video ────────────────────────────────────────────────
 *
 * `buildVideoQualityReport` runs at stage 6, on `composedUsedClips` — the compose montage's own
 * clip list, which is the only finished film that exists at that point. Since the delivery cutover
 * the viewer may instead receive the cinematic timeline render, produced eight hundred lines later
 * by a different renderer from its own list. `bySource`, `byMixKind` and `totalClips` then answer
 * "where did the footage come from" about a file nobody got.
 *
 * The report already handles this honestly for two of its blocks: `postRenderSpotCheck` is
 * overwritten from the render job's own check, and `stillness`/`repeats` say `measuredOn:
 * "compose_montage"` because they cannot be re-run cheaply. The clip figures could always have
 * been corrected — `deliveredPaths` is built a few lines away, handed to `replaceFinalVideo`, and
 * then dropped. This is the reader it never had.
 *
 * ── What is recomputed, and what deliberately is not ─────────────────────────────────────────
 *
 * Everything derived from the clip list: the official attribution, the diagnostic filename
 * reading, the mix, the three source tallies, and the score — which reads four of those. The
 * score is recomputed rather than left alone, because a score built on the montage's counts
 * beside tables built on the delivered file's is exactly the pair of contradictory numbers this
 * report keeps having to apologise for.
 *
 * The named suspects are FILTERED rather than re-derived: a clip that is not in the delivered file
 * cannot be an off-topic shot in it, and re-running the geo rules here would be a second copy of a
 * decision the builder already made. Everything else on the report — the reject audit, the beat
 * coverage, the voice/visual match — describes the RENDER rather than a file, and is untouched.
 *
 * Nothing is loosened: the same functions, the same weights, a different clip list. A render that
 * delivers its compose montage never calls this.
 */
export function recountQualityReportForDeliveredClips(
  report: VideoQualityReport,
  clipPaths: readonly string[],
  opts?: {
    resolveSource?: (clipPath: string) => string | null;
    isGeneratedClip?: (clipPath: string) => boolean;
    adoptAudit?: ClipAdoptEntry[];
    archiveOnly?: boolean;
  }
): { clipsBefore: number; clipsAfter: number; scoreBefore: number; scoreAfter: number } {
  const clipsBefore = report.totalClips;
  const scoreBefore = report.score;

  const bySource: Record<string, number> = {};
  const diagnosticBySource: Record<string, number> = {};
  const byMixKind = emptyMixCounts();
  let generatedClips = 0;
  const unique = [...new Set(clipPaths.filter(Boolean))];

  for (const clipPath of unique) {
    const nameHint = inferClipSourceFromPath(clipPath);
    diagnosticBySource[nameHint] = (diagnosticBySource[nameHint] ?? 0) + 1;
    if (opts?.resolveSource) {
      const recorded = opts.resolveSource(clipPath)?.trim().toLowerCase();
      const source = recorded && recorded !== "unknown" ? recorded : UNVERIFIED_SOURCE;
      bySource[source] = (bySource[source] ?? 0) + 1;
      if (source === UNVERIFIED_SOURCE && opts.isGeneratedClip?.(clipPath)) generatedClips += 1;
    } else {
      bySource[nameHint] = (bySource[nameHint] ?? 0) + 1;
    }
    byMixKind[classifyClipMixKind(clipPath)]++;
  }

  const delivered = new Set(unique.map((p) => path.basename(p)));
  const offTopicSuspects = report.offTopicSuspects.filter((s) => delivered.has(s.basename));
  const criticalGeoViolations = (report.criticalGeoViolations ?? []).filter((v) =>
    delivered.has(v.basename)
  );

  const wikimediaCount = (diagnosticBySource.wikimedia ?? 0) + (diagnosticBySource.openverse ?? 0);
  const archiveCount = diagnosticBySource.archive ?? 0;
  const stockCount = (diagnosticBySource.pexels ?? 0) + (diagnosticBySource.pixabay ?? 0);

  const verdict = computeMeritQualityScore({
    beatVisuals: report.beatVisuals,
    totalClips: unique.length,
    archiveCount,
    stockCount,
    fallbackBeats: report.adoptAuditSummary?.fallbackBeats ?? 0,
    offTopicCount: offTopicSuspects.length,
    geoViolationCount: criticalGeoViolations.length,
    adoptAudit: opts?.adoptAudit,
    archiveOnly: opts?.archiveOnly === true,
    byMixKind,
    postRenderOk: report.postRenderSpotCheck?.ok,
    /**
     * Read from the report, not re-measured. The recount changes WHICH clips are counted; it has
     * no clip durations to work from, and carrying the measurement forward keeps a shot the cut
     * held for seventeen seconds visible to the number instead of silently discounting it.
     */
    screenTime: report.screenTime,
  });

  report.totalClips = unique.length;
  report.bySource = bySource;
  report.diagnosticBySource = diagnosticBySource;
  report.byMixKind = byMixKind;
  report.generatedClips = opts?.resolveSource ? generatedClips : report.generatedClips;
  report.wikimediaCount = wikimediaCount;
  report.archiveCount = archiveCount;
  report.stockCount = stockCount;
  report.offTopicSuspects = offTopicSuspects;
  report.criticalGeoViolations =
    criticalGeoViolations.length > 0 ? criticalGeoViolations : undefined;
  report.score = verdict.score;
  report.qualityStatus = verdict.status;
  report.qualityReason = verdict.reason;
  report.clipsMeasuredOn = "delivered_render";
  /** The accounting follows the list it accounts for. Still nothing excluded. */
  report.clipAccounting = clipAccountingFor(unique, opts);

  return { clipsBefore, clipsAfter: unique.length, scoreBefore, scoreAfter: verdict.score };
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

/**
 * EVERY EXPORT GATE, ANSWERED AT ONCE, BEFORE ANY OF THEM THROWS.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────────────────────
 *
 * Five independent gates can refuse an export, each throwing at its own point in the sequence, so
 * a render reports the FIRST one and stops. Three consecutive production renders were refused by
 * three different gates:
 *
 *     14/14 filled beat(s) got ONLY the color/text fallback     (coverage)
 *     NO_VERIFIED_OWN_VISUAL: 0 of 16 beat(s) approved          (indefensible)
 *     MOSTLY_UNVERIFIED_CLIPS: 12 of 14 clip(s)                 (indefensible)
 *
 * Each of those was a real finding and each cleared the one before it. But the operator learned
 * about them one render at a time, and a render is an hour. Nothing in the pipeline was hiding the
 * other answers — they were simply never asked for.
 *
 * So they are all asked here, and the whole list is logged. The gates themselves are untouched:
 * this decides nothing, blocks nothing and permits nothing. It reports.
 *
 * ── The list is derived, never restated ─────────────────────────────────────────────────────
 *
 * Each entry calls the same predicate the real gate calls, on the same report. A second copy of a
 * threshold here would drift from the gate it claims to describe, and a readiness report that
 * disagrees with the gate is worse than none — see this file's own history with `bySource`.
 */
export type ExportGateStatus = {
  /** The gate's own name, as it appears when it throws. */
  gate: string;
  blocking: boolean;
  detail: string;
};

export function exportGateReadiness(
  report: VideoQualityReport,
  sceneRescueColorFallbackCount: number
): ExportGateStatus[] {
  const out: ExportGateStatus[] = [];

  /** 1. Coverage — the same arithmetic assertVisualCoverageExportGate performs. */
  const beatsFilled = report.adoptAuditSummary?.beatsFilled ?? 0;
  const fallbackBeats = report.adoptAuditSummary?.fallbackBeats ?? 0;
  out.push({
    gate: "visual_coverage",
    blocking: visualCoverageFallsShort(report, sceneRescueColorFallbackCount),
    detail:
      `${fallbackBeats}/${beatsFilled} beat(s) got ONLY a card, ` +
      `${sceneRescueColorFallbackCount} scene(s) fell back entirely` +
      (report.adoptAuditSummary?.mixedBeats
        ? `, ${report.adoptAuditSummary.mixedBeats} beat(s) had footage AND a card`
        : ""),
  });

  /** 2, 3 and 4. The indefensible conditions, from the one function that decides them. */
  const indefensible = indefensibleExportConditions(report);
  /**
   * The blank-picture condition reads a measurement of the DELIVERED file, which the spot check
   * takes at upload time — after most callers of this readiness list. Its "not blocking" line must
   * therefore never read as a pass: an unsampled film is reported as unsampled, by the same rule
   * the stillness and repeat figures already follow when they cannot speak about the delivered file.
   */
  const spot = report.postRenderSpotCheck;
  const notBlocking: Record<string, string> = {
    NO_VERIFIED_OWN_VISUAL: `${report.beatVisuals?.verifiedOwnVisual ?? 0} of ${report.beatVisuals?.beats ?? 0} beat(s) hold an approved own picture`,
    MOSTLY_UNVERIFIED_CLIPS: `${report.generatedClips ?? 0} drawn card(s) of ${report.totalClips} clip(s), the rest traced`,
    FINAL_PICTURE_IS_BLACK: spot
      ? `${spot.blackFrameCount}/${spot.framesChecked} sampled frame(s) dark, worst mean luma ${spot.worstMeanLuma?.toFixed(0) ?? "?"}`
      : "the delivered file has not been sampled yet — this is not a pass",
  };
  for (const code of ["NO_VERIFIED_OWN_VISUAL", "MOSTLY_UNVERIFIED_CLIPS", "FINAL_PICTURE_IS_BLACK"]) {
    const hit = indefensible.find((c) => c.code === code);
    out.push({
      gate: code.toLowerCase(),
      blocking: Boolean(hit),
      detail: hit?.detail ?? notBlocking[code]!,
    });
  }

  return out;
}

/** The readiness list as log lines — every gate, blocking or not, in one block. */
export function formatExportGateReadiness(
  videoId: number | string,
  statuses: readonly ExportGateStatus[]
): string[] {
  const blocking = statuses.filter((s) => s.blocking).length;
  return [
    `[ExportReadiness] video=${videoId} ${blocking} of ${statuses.length} gate(s) would block`,
    ...statuses.map(
      (s) => `[ExportReadiness]   ${(s.blocking ? "BLOCKS" : "ok").padEnd(6)} ${s.gate.padEnd(24)} ${s.detail}`
    ),
  ];
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
