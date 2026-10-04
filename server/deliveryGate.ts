/**
 * ONE ROUTE — THE DELIVERY GATE: DELIVER OR BLOCK, AND NOTHING ELSE.
 *
 * Every rule that may refuse to hand a film to the customer lives in this module. It decides; it
 * does not measure and it does not report. The measurements stay with the code that takes them
 * (the quality report, the screen-time count, the spot check, the ffprobe readers), and the lines a
 * person reads about a render stay with the RenderReport. Each rule is asked at the moment its
 * evidence is complete, which is why there are several call sites and still one owner:
 *
 *   after sourcing               `filmWithoutPictureRefusal`       no scene holds a single real picture
 *   before the timeline render   `assertVisualCoverageExportGate`  placeholder scenes / card-only beats
 *                                `visionCoverageRefusal`           footage nobody judged
 *                                `enforceQualityExportGate`        nothing verified / provenance lost
 *                                `finalTimelineFootageRefusal`     one piece of footage fills the film
 *   on the rendered file         `deliveryGate`                    render, timeline, every clip, the MP4,
 *                                                                  a blank picture, one footage fills it
 *   after the timeline render    `judgeYoutubeRequirement`         a deployment's YouTube minimum
 *   on the published file        `finalVideoRefusals`              size, streams, minimum duration
 *
 * ── The two things this ends ────────────────────────────────────────────────────────────────
 *
 * 1. A render whose authoritative timeline render failed, marked COMPLETE with something else in
 *    it. §10: a failed authoritative render is FAILED or BLOCKED. Since RONDE 661 there is no
 *    compose montage to hand over instead, so a recorded refusal can only ever block.
 *
 * 2. Completion decided from database metadata. A row saying `videoUrl` is not a video; §12 asks for
 *    the delivered MP4 itself to be read. This module does not re-implement that reading —
 *    `checkRenderedFile` and `postRenderSpotCheck` already do it — it REQUIRES it, and refuses a
 *    verdict built from anything less.
 */

import { PIPELINE_ERROR, pipelineError } from "@shared/appErrors";
import { normalizeVideoLength, targetVideoDurationMinutes } from "@shared/videoLengths";
import { computeScreenTimeShare } from "./deliveredScreenTime";
import type { PostRenderSpotCheckResult } from "./postRenderSpotCheck";
import type { VideoQualityReport } from "./videoQualityReport";
import { UNVERIFIED_PROVIDER as UNVERIFIED_SOURCE } from "./visualSourceLineage";
import type { YoutubeFootage } from "./youtubeFootageInFilm";

/* ═══════════════════════ what the gate is asked about ═══════════════════════ */

/** One production media clip, as the gate needs to see it. */
export type DeliveryClipFact = {
  clipId: string;
  /** The internal archive handle. Absent is the condition §9 exists to remove. */
  archiveAssetId?: number | null;
  provider: string;
  providerAssetId?: string | null;
  /** Did rehydration produce a readable local file for this clip? */
  resolved: boolean;
  /** Was it resolved from FastVid's own storage rather than a provider? */
  fromArchive: boolean;
  /** Placeholder, colour card, text overlay — anything that depicts nothing. */
  isPlaceholder: boolean;
};

/** What the delivered file itself was measured to be. Never taken from a database row. */
export type DeliveredFileFacts = {
  exists: boolean;
  readable: boolean;
  durationSec: number | null;
  hasVideoStream: boolean;
  hasAudioStream: boolean;
  sizeBytes: number;
};

export type DeliveryGateInput = {
  videoId: number;
  /** The authoritative timeline's own render — since RONDE 661 the only route there is. */
  route: "cinematic_timeline";
  /** Set when the timeline render did not deliver. Any refusal blocks the delivery. */
  cinematicRefusal?: string | null;
  /** Whether an authoritative timeline exists for this video at all. */
  timelineExists: boolean;
  clips: DeliveryClipFact[];
  delivered: DeliveredFileFacts | null;
  /**
   * Run ONLY the asset checks, and say so on the line.
   *
   * The pipeline's final gate sits after the export gate, the stillness audit and the post-render
   * spot check have all already read the delivered file. It has no fresh measurements of its own
   * and passing invented ones — `exists: true, hasVideoStream: true` — would be this gate claiming
   * a check it never made, which is the habit the whole programme exists to remove.
   *
   * So it declares what it is: the asset invariant, on a file whose bytes are somebody else's
   * verdict. `delivered` is then ignored, and the log says `checks=assets` so nobody reads a pass
   * here as a statement about the picture.
   */
  assetsOnly?: boolean;
  /** The voiceover's measured length, for the alignment check. Null when there is no voiceover. */
  voiceoverSec?: number | null;
  /** How far the delivered duration may sit from the voiceover before it is a fault. */
  durationToleranceSec?: number;
  /** `finalTimelineFootageRefusal` on the rendered timeline — set when one footage fills the film. */
  footageRefusal?: string | null;
  /** RONDE 662 — `blankPictureFinding` on the delivered file's spot check; null when not blank or not sampled. */
  blankPicture?: string | null;
};

export type DeliveryGateFailureCode =
  | "AUTHORITATIVE_RENDER_FAILED"
  | "TIMELINE_MISSING"
  | "CLIP_WITHOUT_ARCHIVE_ASSET"
  | "CLIP_UNRESOLVED"
  | "PLACEHOLDER_IN_DELIVERY"
  | "DELIVERED_FILE_MISSING"
  | "DELIVERED_FILE_UNREADABLE"
  | "DELIVERED_FILE_NO_VIDEO"
  | "DELIVERED_FILE_NO_AUDIO"
  | "DELIVERED_DURATION_WRONG"
  | "ONE_FOOTAGE_FILLS_FILM"
  | "FINAL_PICTURE_IS_BLACK";

export type DeliveryGateVerdict =
  | { allow: true; checked: number; lines: string[] }
  | { allow: false; failures: Array<{ code: DeliveryGateFailureCode; detail: string }>; lines: string[] };

/* ═══════════════════════ the gate ═══════════════════════ */

export const DELIVERY_GATE_PASS = "DELIVERY_GATE_PASS";
/** §22 — one line per clip, naming the archive asset the render actually used. */
export const TIMELINE_ARCHIVE_REFERENCE = "TIMELINE_ARCHIVE_REFERENCE";
export const DELIVERY_GATE_FAIL = "DELIVERY_GATE_FAIL";

/**
 * May this render be marked COMPLETE?
 *
 * Pure: every fact is passed in, measured by the caller from the file and the timeline. That is
 * deliberate — a gate that fetches its own evidence is a gate whose evidence cannot be shown in a
 * test, and this one's whole job is to be shown.
 */
export function deliveryGate(input: DeliveryGateInput): DeliveryGateVerdict {
  const failures: Array<{ code: DeliveryGateFailureCode; detail: string }> = [];
  const lines: string[] = [];
  const at = `video=${input.videoId}`;

  /* RONDE 662 — the delivered file has no picture at any point that was looked at. First: it is the
   * finding a viewer notices before any other, so it is the reason named when several apply. */
  if (input.blankPicture?.trim()) {
    failures.push({ code: "FINAL_PICTURE_IS_BLACK", detail: input.blankPicture });
  }

  /* §10 — the authoritative render failed; there is nothing else to hand over. */
  if (input.cinematicRefusal?.trim()) {
    failures.push({
      code: "AUTHORITATIVE_RENDER_FAILED",
      detail: `the cinematic timeline render did not deliver (${input.cinematicRefusal})`,
    });
  }

  /* §11 — an authoritative timeline must exist for a timeline render. */
  if (!input.timelineExists) {
    failures.push({
      code: "TIMELINE_MISSING",
      detail: "the route claims the authoritative timeline and no timeline was recorded",
    });
  }

  /* Video 612 — one piece of footage held under the whole narration is not a film. Video 627 — nor
   * is a film made mostly of shots borrowed from other sentences (same field, see `borrowedShotsRefusal`). */
  if (input.footageRefusal?.trim()) {
    failures.push({ code: "ONE_FOOTAGE_FILLS_FILM", detail: input.footageRefusal });
  }

  /* §11 — every production media clip, one by one. */
  for (const clip of input.clips) {
    if (clip.isPlaceholder) {
      failures.push({
        code: "PLACEHOLDER_IN_DELIVERY",
        detail: `clip=${clip.clipId} is a placeholder or colour fallback`,
      });
      continue;
    }
    if (clip.archiveAssetId == null) {
      failures.push({
        code: "CLIP_WITHOUT_ARCHIVE_ASSET",
        detail:
          `clip=${clip.clipId} provider=${clip.provider} ` +
          `providerAssetId=${clip.providerAssetId ?? "none"} has no archive asset, so the renderer ` +
          `depends on the provider still being reachable`,
      });
    }
    if (!clip.resolved) {
      failures.push({
        code: "CLIP_UNRESOLVED",
        detail: `clip=${clip.clipId} provider=${clip.provider} produced no readable file`,
      });
    }
  }

  /* §12 — the delivered MP4 itself, unless this caller has no measurement of its own. */
  const d = input.assetsOnly ? null : input.delivered;
  if (input.assetsOnly) {
    /* the file is the export gate's and the spot check's verdict on this route — see `assetsOnly` */
  } else if (!d || !d.exists) {
    failures.push({ code: "DELIVERED_FILE_MISSING", detail: "no delivered file was measured" });
  } else {
    if (!d.readable || d.sizeBytes <= 0) {
      failures.push({
        code: "DELIVERED_FILE_UNREADABLE",
        detail: `the delivered file could not be read (bytes=${d.sizeBytes})`,
      });
    }
    if (!d.hasVideoStream) {
      failures.push({ code: "DELIVERED_FILE_NO_VIDEO", detail: "the delivered file has no video stream" });
    }
    if (input.voiceoverSec != null && !d.hasAudioStream) {
      failures.push({
        code: "DELIVERED_FILE_NO_AUDIO",
        detail: "a voiceover was produced and the delivered file has no audio stream",
      });
    }
    if (input.voiceoverSec != null && d.durationSec != null) {
      const tolerance = input.durationToleranceSec ?? 2;
      const drift = Math.abs(d.durationSec - input.voiceoverSec);
      if (drift > tolerance) {
        failures.push({
          code: "DELIVERED_DURATION_WRONG",
          detail:
            `the delivered file is ${d.durationSec.toFixed(2)}s and the voiceover is ` +
            `${input.voiceoverSec.toFixed(2)}s (drift ${drift.toFixed(2)}s, tolerance ${tolerance}s)`,
        });
      }
    }
  }

  const fromArchive = input.clips.filter((c) => c.fromArchive).length;
  const summary =
    `clips=${input.clips.length} fromArchive=${fromArchive} route=${input.route} ` +
    `timeline=${input.timelineExists ? "present" : "absent"} ` +
    `checks=${input.assetsOnly ? "assets" : "assets+file"}`;

  if (failures.length === 0) {
    lines.push(`[DeliveryGate] ${DELIVERY_GATE_PASS} ${at} ${summary}`);
    return { allow: true, checked: input.clips.length, lines };
  }
  lines.push(`[DeliveryGate] ${DELIVERY_GATE_FAIL} ${at} ${summary} failures=${failures.length}`);
  for (const f of failures) lines.push(`[DeliveryGate]   ${f.code} — ${f.detail}`);
  return { allow: false, failures, lines };
}


/** The one sentence a blocked delivery reports to the operator and to the job row. */
export function formatDeliveryBlock(verdict: DeliveryGateVerdict, videoId: number): string {
  if (verdict.allow) return "";
  const first = verdict.failures[0];
  return (
    `Delivery blocked for video ${videoId}: ${verdict.failures.length} requirement(s) failed — ` +
    `${first?.code} (${first?.detail})`
  );
}

/* ═══════════════════════ every rule that may refuse a delivery ═══════════════════════ */

/** One reason a render must not be delivered, whatever its score says. */
export type IndefensibleExportCondition = {
  /** Machine-readable, stable, and the same word in the log and the thrown error. */
  code: "NO_VERIFIED_OWN_VISUAL" | "MOSTLY_UNVERIFIED_CLIPS" | "FINAL_PICTURE_IS_BLACK";
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
 * No flag switches this off, because a flag that has to be remembered is exactly how render 568
 * shipped: the conditions below were all true and every switch that could have stopped it was off.
 * It is the whole of `enforceQualityExportGate` now; the flag-gated checks beside it are gone.
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

  /**
   * "NO PROVIDER TO PROVE" AND "A PROVIDER WE COULD NOT PROVE" ARE OPPOSITE FINDINGS.
   *
   * This gate's own sentence is "the lineage cannot say where most of this film came from". That
   * is a true and serious statement about a clip fetched from somewhere whose record broke. It is
   * false about a colour card the render drew itself: nothing was lost, because there was never a
   * provider to lose. Both answered null from `providerFor`, so both landed in one bucket, and a
   * film was refused for losing provenance it never had.
   *
   * The ledger has always kept the two apart — `summary()` counts `route === "fallback"` in its
   * own column — so this reads that distinction rather than inventing one.
   *
   * NOT a relaxation, for a reason worth stating: a film that really is mostly drawn cards is
   * refused by `assertVisualCoverageExportGate`, whose fallbackBeats/beatsFilled majority test is
   * about exactly that and is untouched. This gate goes back to guarding the one thing its message
   * describes. Both counts are printed either way, so a render can never again hide one behind the
   * other.
   */
  const unverified = report.bySource[UNVERIFIED_SOURCE] ?? 0;
  const drawn = report.generatedClips ?? 0;
  const unprovable = Math.max(0, unverified - drawn);
  const measured = Math.max(0, report.totalClips - drawn);
  if (measured > 0 && unprovable / measured > UNVERIFIED_CLIP_SHARE_LIMIT) {
    const pct = Math.round((unprovable / measured) * 100);
    out.push({
      code: "MOSTLY_UNVERIFIED_CLIPS",
      detail:
        `${unprovable} of ${measured} fetched clip(s) have no proven source ` +
        `(${pct}%, limit ${Math.round(UNVERIFIED_CLIP_SHARE_LIMIT * 100)}%) — ` +
        `the lineage cannot say where most of this film came from` +
        (drawn > 0 ? ` (${drawn} drawn card(s) excluded — they have no provider to lose)` : ""),
    });
  }

  /**
   * AND THE ONE A VIEWER NOTICES BEFORE ANY OF THE OTHERS: THERE IS NO PICTURE.
   *
   * ── What was already true before this ───────────────────────────────────────────────────────
   *
   * `spotCheckFinalVideo` samples the DELIVERED file at four points and already draws the
   * conclusion in as many words:
   *
   *     warnings.push(`Final video appears fully black (worst luma ...)`)
   *
   * and `isInformationalSpotWarning` singles that sentence out — with "Final video missing or too
   * small" — as the one kind of warning that is NOT informational, which is what makes
   * `ok: blockingWarnings.length === 0` false. So the render measured the blankness, classified it
   * as blocking, and wrote it into `qualityReport.postRenderSpotCheck.ok`.
   *
   * Nothing then read that boolean. The two call sites log `console.warn` and feed `postRenderOk`
   * into the merit score, which the availability heal can raise again; neither refuses anything.
   * A blank film was uploaded, scored and delivered. Same shape as `formatAssetTrace` exported to
   * no caller and `metadata.publishedAt` written as null while the ranking engine read it: a value
   * computed, carried, and dropped by the only reader that needed it.
   *
   * ── Why the condition is stricter than the warning that prompted it ─────────────────────────
   *
   * The warning fires on `worstMeanLuma < 1` — ONE black sample out of four — while its sentence
   * says "fully black". That gap is why it could not be promoted as written: a film that opens on
   * a held black frame would be refused publication over a legitimate edit. So this reads the
   * count, not the worst: every sample dark, and at least two samples actually taken. The warning
   * is left exactly as it is; it is a warning, and it says "appears".
   *
   * ── What it deliberately does not do ────────────────────────────────────────────────────────
   *
   * It does not fire when the spot check did not run, or could not extract frames. Following this
   * function's own rule: "nothing was measured" is not evidence of a bad render, and a render whose
   * picture was never sampled is reported as unsampled rather than convicted.
   */
  const blank = blankPictureFinding(report.postRenderSpotCheck);
  if (blank) out.push({ code: "FINAL_PICTURE_IS_BLACK", detail: blank });

  return out;
}

/**
 * The coverage rule itself: a scene that fell back entirely to a placeholder, or more than half the
 * filled beats holding ONLY a colour/text card. The export readiness report asks this same function,
 * so the line it prints and the refusal can never disagree.
 */
export function visualCoverageFallsShort(
  report: Pick<VideoQualityReport, "adoptAuditSummary">,
  sceneRescueColorFallbackCount: number
): boolean {
  const beatsFilled = report.adoptAuditSummary?.beatsFilled ?? 0;
  const fallbackBeats = report.adoptAuditSummary?.fallbackBeats ?? 0;
  const majorityFallback = beatsFilled > 0 && fallbackBeats / beatsFilled > 0.5;
  return sceneRescueColorFallbackCount > 0 || majorityFallback;
}

/**
 * Problem 10 (production render finding — "Why Hitler Killed Himself and His Wife"): this gate is
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
  if (!visualCoverageFallsShort(report, sceneRescueColorFallbackCount)) return;
  const summary = report.adoptAuditSummary;
  const beatsFilled = summary?.beatsFilled ?? 0;
  const fallbackBeats = summary?.fallbackBeats ?? 0;

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

export type VisionCoverageGateParams = {
  /** Declines caused by an unreachable provider — never a budget or configuration decline. */
  providerUnavailable: number;
  beats: readonly VisionCoverageBeat[];
  /** The gate's own one-line summary of why it produced no verdicts, for the failure message. */
  noVerdictSummary?: string;
};

/**
 * THE REFUSAL AS A VALUE, SO IT CAN BE DECIDED EARLY AND THROWN LATE.
 *
 * The pipeline asks here when the beat audit is complete and logs the verdict at once; it throws at
 * the export gates, before any render job is queued. A refused film is never uploaded or published —
 * the same rule the DeliveryGate applies to the rendered file.
 */
export function visionCoverageRefusal(params: VisionCoverageGateParams): string | null {
  if (params.providerUnavailable <= 0) return null;
  const unchecked = params.beats.filter((b) => b.hasRealFootage && b.verdicts === 0);
  if (unchecked.length === 0) return null;

  const named = unchecked
    .slice(0, 6)
    .map((b) => `s${b.sceneIndex}b${b.beatIndex}`)
    .join(", ");
  const withFootage = params.beats.filter((b) => b.hasRealFootage).length;
  return (
    `Render rejected — the picture editor was unreachable and this video contains footage nobody ` +
    `judged: ${unchecked.length} of ${withFootage} beat(s) with real footage received no verdict ` +
    `(${named}${unchecked.length > 6 ? ", …" : ""}), after ${params.providerUnavailable} ` +
    `judgement(s) were declined for want of a vision provider. ` +
    `${params.noVerdictSummary || "No provider was reachable."} ` +
    `Restore a vision provider (OpenAI credit, or a Gemini key whose project is not denied) and ` +
    `re-render. The picture editor cannot be switched off.`
  );
}

/** The same gate, thrown where a caller wants it thrown. */
export function assertVisionCoverageExportGate(params: VisionCoverageGateParams): void {
  const refusal = visionCoverageRefusal(params);
  if (refusal) throw pipelineError(PIPELINE_ERROR.QUALITY_GATE, refusal);
}

/** Refuses a render whose pictures cannot be traced or were never approved — see `indefensibleExportConditions`. */
export function enforceQualityExportGate(videoId: number, report: VideoQualityReport): void {
  const indefensible = indefensibleExportConditions(report);
  if (indefensible.length === 0) return;
  for (const c of indefensible) {
    console.error(`[Quality] Video ${videoId}: EXPORT BLOCKED ${c.code} — ${c.detail}`);
  }
  throw pipelineError(
    PIPELINE_ERROR.QUALITY_GATE,
    `Export blocked — this render cannot say what it is showing: ` +
      indefensible.map((c) => `${c.code}: ${c.detail}`).join(" | ")
  );
}

/**
 * Above this share one piece of footage is not a film but a held picture, and it is NOT delivered.
 *
 * Video 612 shipped 3.83 s of one YouTube clip held under 71 s of narration, cut into fifteen
 * 4.74 s pieces from two windows of the same source. Every clip-level check passed: no piece was
 * over the shot limit, and the screen-time line above was measured on the clips before the hold.
 */
export const MAX_DELIVERABLE_FOOTAGE_SHARE = 0.5;

/** A video clip of the FINAL timeline — after the holds and the YouTube pieces. Structural. */
export type FinalTimelineClip = {
  id: string;
  disabled?: boolean;
  timelineStart: number;
  timelineEnd: number;
  source: { provider?: string | null; providerAssetId?: string | null; archiveAssetId?: number | null };
  /** GRAPHICS FIX — a clip at opacity 0 shows no picture (a graphic's dark ground). */
  transform?: { opacity?: number } | null;
};

/**
 * The same screen-time measurement, on the timeline that will actually be rendered.
 *
 * Pieces cut from one source count as one piece of footage: the key is the source asset, never the
 * clip id. Returns the refusal reason, or null when no single piece of footage fills more than
 * `maxShare` of the film and the borrowed shots stay within `MAX_BORROWED_SHOT_SHARE` (video 627).
 *
 * `youtubeVideoByArchiveAsset` — the original YouTube video behind an archive asset, when the
 * caller could read it (the archive stores several segments of one video as separate assets). Those
 * segments are one source for the viewer, so they share the key `youtube:<videoId>`. Without an
 * entry the archive/provider key below is used, exactly as before.
 */
export function finalTimelineFootageRefusal(
  clips: readonly FinalTimelineClip[],
  maxShare = MAX_DELIVERABLE_FOOTAGE_SHARE,
  youtubeVideoByArchiveAsset: ReadonlyMap<number, string> = new Map()
): string | null {
  const share = computeScreenTimeShare(
    clips
      /** GRAPHICS FIX — a clip that shows nothing (opacity 0, a graphic's dark ground) is no footage on screen. */
      .filter((c) => !c.disabled && c.transform?.opacity !== 0)
      .map((c) => {
        const sourceFootage =
          c.source.archiveAssetId != null ? youtubeVideoByArchiveAsset.get(c.source.archiveAssetId) : undefined;
        return {
          path: c.id,
          source: c.source.provider ?? null,
          /** A full footage key ("youtube:…", "archive:<parent>") is used as is; a bare id is a YouTube video. */
          contentKey: sourceFootage
            ? sourceFootage.includes(":") ? sourceFootage : `youtube:${sourceFootage}`
            : c.source.archiveAssetId != null
              ? `archive:${c.source.archiveAssetId}`
              : c.source.providerAssetId
                ? `${c.source.provider ?? "?"}:${c.source.providerAssetId}`
                : null,
          durationSec: c.timelineEnd - c.timelineStart,
        };
      })
  );
  const top = share.byFootage[0];
  if (top && top.share > maxShare) {
    return (
      `one piece of footage (${top.key}, source=${top.source}) fills ${pct(top.share)} of the final timeline ` +
      `(${top.sec.toFixed(1)}s of ${share.totalSec.toFixed(1)}s in ${top.appearances} piece(s), limit ${pct(maxShare)})`
    );
  }
  return borrowedShotsRefusal(clips);
}

/**
 * VIDEO 627 — above this share the film is mostly shots borrowed from other sentences, and it is
 * NOT delivered.
 *
 * A hole in the edit is filled with the film's other approved shots (`coverHoles`, ids `…_fillN`).
 * Video 627 had 49.7 s of its 90.6 s filled that way — one scene of 46 s had a single shot of its
 * own — and passed every check, because no ONE piece of footage passed `maxShare`: the film's nine
 * sources took turns. Measured on the same final timeline as the rule above.
 */
export const MAX_BORROWED_SHOT_SHARE = 0.4;

export function borrowedShotsRefusal(
  clips: readonly FinalTimelineClip[],
  maxShare = MAX_BORROWED_SHOT_SHARE
): string | null {
  const live = clips.filter((c) => !c.disabled);
  const total = live.reduce((sum, c) => sum + Math.max(0, c.timelineEnd - c.timelineStart), 0);
  if (total <= 0) return null;
  const borrowed = live
    .filter((c) => /_fill\d+(?:_p\d+)?$/.test(c.id))
    .reduce((sum, c) => sum + Math.max(0, c.timelineEnd - c.timelineStart), 0);
  if (borrowed / total <= maxShare) return null;
  return (
    `shots borrowed from other sentences fill ${pct(borrowed / total)} of the final timeline ` +
    `(${borrowed.toFixed(1)}s of ${total.toFixed(1)}s, limit ${pct(maxShare)}) — the sentences have too few pictures of their own`
  );
}

export type YoutubeRequirementVerdict =
  | { ok: true }
  | { ok: false; code: "YOUTUBE_FOOTAGE_BELOW_REQUIREMENT" | "YOUTUBE_FOOTAGE_UNMEASURED"; detail: string };

export function judgeYoutubeRequirement(f: YoutubeFootage, requiredSec: number | null): YoutubeRequirementVerdict {
  if (requiredSec == null) return { ok: true };
  if (f.basis === "unmeasured") {
    return {
      ok: false,
      code: "YOUTUBE_FOOTAGE_UNMEASURED",
      detail: `this deployment requires ${requiredSec}s of YouTube footage and this film has no timeline to measure it on`,
    };
  }
  if (f.youtubeSec + 1e-6 < requiredSec) {
    return {
      ok: false,
      code: "YOUTUBE_FOOTAGE_BELOW_REQUIREMENT",
      detail: `${f.youtubeSec.toFixed(1)}s of YouTube footage in the film, ${requiredSec}s required`,
    };
  }
  return { ok: true };
}

/**
 * How many of the spot check's four samples must be dark before the film is called blank.
 *
 * `spotCheckFinalVideo` samples the delivered file at 12%, 38%, 62% and 88% — never at the very
 * start or the very end, so an opening or closing fade cannot produce a dark sample. ALL of them
 * is the bar: a documentary may legitimately hold on black once, and two of four dark is a night
 * sequence, not an empty render. Four of four is a film with no picture anywhere it was looked.
 */
const BLANK_PICTURE_MIN_SAMPLES = 2;

/**
 * A BLANK FILM, AS ONE RULE — the export gate and the render job ask the same question here.
 *
 * Null when the picture is not blank, and also when nothing was measured: "nothing was sampled"
 * is not evidence of a bad render, so an unsampled film is reported as unsampled, not convicted.
 */
export function blankPictureFinding(
  spot: Pick<PostRenderSpotCheckResult, "framesChecked" | "blackFrameCount" | "worstMeanLuma"> | null | undefined
): string | null {
  if (!spot || spot.framesChecked < BLANK_PICTURE_MIN_SAMPLES || spot.blackFrameCount !== spot.framesChecked) {
    return null;
  }
  return (
    `all ${spot.framesChecked} sampled frame(s) of the delivered file are black ` +
    `(worst mean luma ${spot.worstMeanLuma?.toFixed(0) ?? "?"}) — ` +
    `the film has no picture at any point that was looked at`
  );
}

/** Absolute minimum playable file size — below this we heal/reassemble. */
export function absoluteMinFinalVideoBytes(videoLength?: string | null): number {
  const mins = targetVideoDurationMinutes(videoLength);
  if (mins <= 1) return 80_000;
  return Math.max(400_000, Math.round(mins * 60 * 8_000));
}

/** Minimum duration (seconds) for a finished video to be considered playable. */
export function absoluteMinDurationSec(videoLength?: string | null): number {
  switch (normalizeVideoLength(videoLength)) {
    case "1":
      return 28;
    case "3":
      return 90;
    case "5":
      return 150;
    case "30":
      return 900;
    case "60":
      return 1800;
    case "8-10":
      return 240;
    case "10-15":
      return 360;
    case "15-20":
      return 540;
    default:
      return 240;
  }
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
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

/**
 * The published file, judged on what `validateFinalVideoPlayable` measured: big enough for its
 * length, a picture stream, a sound stream, and at least the shortest duration its length allows.
 * Every reason is a refusal; none of them is a warning.
 */
export function finalVideoRefusals(
  facts: { sizeBytes: number; hasVideo: boolean; hasAudio: boolean; durationSec: number | null },
  videoLength?: string | null
): string[] {
  const reasons: string[] = [];
  const minBytes = absoluteMinFinalVideoBytes(videoLength);
  if (facts.sizeBytes < minBytes) {
    reasons.push(
      `Final video too small (${Math.round(facts.sizeBytes / 1024)}KB, need ≥${Math.round(minBytes / 1024)}KB)`
    );
  }
  if (!facts.hasVideo) reasons.push("Final video has no video stream");
  if (!facts.hasAudio) reasons.push("Final video has no audio stream");
  if (facts.durationSec == null) {
    reasons.push("Could not read final video duration");
  } else if (facts.durationSec < absoluteMinDurationSec(videoLength)) {
    reasons.push(
      `Final video too short (${facts.durationSec.toFixed(1)}s, need ≥${absoluteMinDurationSec(videoLength)}s)`
    );
  }
  return reasons;
}

/**
 * A film in which no scene holds a single real picture. A scene without one is a gap the timeline
 * holds over; a film with no picture anywhere has nothing to hold, so it is not delivered. Returns
 * the first empty scene's position (to name it in the refusal), or null when any scene has a
 * picture — or when there are no scenes at all.
 */
export function filmWithoutPictureRefusal(
  sceneClips: ReadonlyArray<ReadonlyArray<string | null | undefined>>,
  isPlaceholder: (clip: string) => boolean
): number | null {
  const hasPicture = (clips: ReadonlyArray<string | null | undefined>) =>
    clips.some((c) => Boolean(c) && !isPlaceholder(c as string));
  if (sceneClips.length === 0 || sceneClips.some(hasPicture)) return null;
  return 0;
}
