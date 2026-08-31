/**
 * RONDE 133 — the technical gate: "can this FILE be used at all?"
 *
 * ── The two questions, and why they must stay apart ───────────────────────────────────────────
 *
 *   TECHNICAL GATE   Can this file technically be used?     ← this module
 *   VISION GATE      Does this picture belong under this beat?
 *
 * A technical gate may never answer the second question. Nothing here reads narration, subject,
 * period or place, and nothing here produces a fits/does_not_fit verdict — the callers turn a
 * refusal into `return null` BEFORE any gate is consulted, so a technically refused candidate
 * never becomes a content judgement about the beat. That separation is the whole point of the
 * round: a file that cannot be decoded is not a picture the editor disliked.
 *
 * ── What this module exists to fix ────────────────────────────────────────────────────────────
 *
 * The rule below already existed — it just only ran on ONE of the routes.
 *
 *   · prepareCuratedArchiveClip (the ARCHIVE route) rejected a still narrower than
 *     VIDRUSH_MIN_STILL_WIDTH, using a private ffprobe helper.
 *   · downloadAndTrimPoolCandidate (EVERY external provider — wikimedia, internet_archive, loc,
 *     nara, nasa, openverse, europeana, pexels, pixabay) had no pixel check of any kind.
 *   · fetchWikimediaImages had none either.
 *
 * So the same photograph was held to two different standards depending on which route happened to
 * fetch it. A 320-pixel Commons thumbnail passed every check the external route had, was judged by
 * Vision, and was upscaled into a 1080p montage — the blurred, soft picture with no technical
 * explanation anywhere in the log.
 *
 * ── Why BYTES are not a substitute for PIXELS ─────────────────────────────────────────────────
 *
 * The external routes did have byte floors (10 000 on the Wikimedia route, 50 000 on the pool
 * route), and a byte floor measures compression, not resolution:
 *
 *     640×480 JPEG at quality 85      ~90 KB   → passes a 50 KB floor, is unusable
 *     3000×2000 scan at quality 40    ~40 KB   → fails a 50 KB floor, is excellent
 *
 * Both directions are wrong, and no threshold on file size fixes either. The pixel count is the
 * thing being asked about, so it is the thing that gets measured.
 *
 * ── Absence is neutral ────────────────────────────────────────────────────────────────────────
 *
 * A width of 0 means ffprobe could not tell us — it does NOT mean the file is small. ffprobe times
 * out under memory pressure, and this pipeline runs many of them at once. Rejecting on "we could
 * not measure" would throw away good material precisely when the machine is busiest, so an
 * unmeasurable file passes exactly as it did before this module existed. That is the same rule
 * prepareCuratedArchiveClip has always used (`width > 0 && width < MIN`), preserved verbatim.
 */
import { VIDRUSH_MIN_STILL_WIDTH } from "./vidrushQuality";

/**
 * ── This module spawns nothing ────────────────────────────────────────────────────────────────
 *
 * It owns the RULE, not the measuring. Each route measures with the ffprobe wrapper it already
 * has, and those wrappers are not interchangeable: curatedMediaSourcing's `exec` is gated by
 * ffmpegSemaphore and calls throwIfActiveRenderCancelled first, videoPipeline's probe is memoised
 * on the file's inode+ctime. Pulling a bare child_process in here would have quietly taken the
 * archive route's probe out of the semaphore and off the cancellation check — a real regression
 * bought for a cosmetic tidy. So the width arrives as a number and the verdict is the shared part.
 */

/** Why a file was technically refused. Never a statement about what the picture shows. */
export type TechnicalRejectReason =
  | "http_error"
  | "file_too_small"
  | "still_too_low_res"
  | "video_too_low_res"
  | "duration_too_short"
  | "encode_failed"
  | "still_conversion_failed";

export type TechnicalVerdict =
  | { ok: true }
  | {
      ok: false;
      reason: TechnicalRejectReason;
      /** What was measured, e.g. "320x240" or "1.20s". */
      actual: string;
      /** What was required, e.g. "144 lines" or "1.50s". */
      required: string;
      /** `actual < required` — the human form the log prints. */
      detail: string;
    };

const OK: TechnicalVerdict = { ok: true };

function reject(
  reason: TechnicalRejectReason,
  actual: string,
  required: string
): Extract<TechnicalVerdict, { ok: false }> {
  return { ok: false, reason, actual, required, detail: `${actual} < ${required}` };
}

/* ═══════════════════════ RONDE 134 — video ═══════════════════════ */

/**
 * ── The floor, and why it is THIS number ─────────────────────────────────────────────────────
 *
 * Until now the only thing standing between a video file and the montage was
 * montageStreamMetaUsable's `width < 2 || height < 2`. That is a check for a file that is not a
 * picture at all; it is not a quality bar. A 128×96 clip cleared it, was judged by Vision, and was
 * blown up fifteen times into a 1920×1080 frame.
 *
 * The number below is not invented for this round. sourcingPolicy's youtubeMinFormatHeight() has
 * carried this exact judgement since RONDE 27 — for the identical situation, a source scaled into
 * a 1920×1080 frame as B-roll behind narration — and its own validator states the two bounds this
 * codebase has already committed to:
 *
 *     n >= 144 && n <= 1080     the admissible range; nothing below 144 has ever been allowed
 *     return 480                the preferred bar, "below this the source starts to look soft"
 *
 * Both are used here, for different jobs:
 *
 *   144  REJECTS.   No configuration in this pipeline has ever been permitted to go below it, so
 *                   refusing it takes nothing away that any existing rule would have kept.
 *   480  OBSERVES.  Logged, never refused.
 *
 * ── Why 480 does not reject ──────────────────────────────────────────────────────────────────
 *
 * Because the material this pipeline exists to find would be the first casualty. A genuine 1945
 * newsreel digitised at 352×240 is not a technically bad file — it is the only copy there is, and
 * it beats a pristine modern stock shot on the one thing that matters. Internet Archive, the
 * Library of Congress and NARA are full of exactly that, while Pexels and Pixabay hand back 1080p
 * by construction. A 480-line rejection would therefore fall almost entirely on the archives and
 * almost not at all on stock — the precise inversion of what this pipeline is for.
 *
 * So the bar is measured and printed instead. After one production render the log says how much
 * material actually sits between 144 and 480, and THAT is the evidence for raising the floor —
 * rather than a number chosen here because it sounded safe.
 *
 * ── The shorter dimension, not the height ────────────────────────────────────────────────────
 *
 * candidateRanking already scores resolution as `Math.min(width, height) / 1080`. Using the same
 * dimension keeps one definition of "how big is this picture" in the codebase, and it is the
 * correct one: a 1920×120 letterbox strip is not a usable shot because it is 1920 wide.
 */
/**
 * RONDE 136 — the 480-line bar starts REFUSING, but only for stock.
 *
 * ── What video 558 measured, and how it corrected RONDE 134 ──────────────────────────────────
 *
 * RONDE 134 set 480 as an observe-only bar and argued that making it refuse "would fall almost
 * entirely on the archives and almost not at all on stock, because Pexels and Pixabay hand back
 * 1080p by construction". The first production measurement says the opposite:
 *
 *     Pexels             426x226   (three times)
 *     YouTube CC         640x360   (twice)
 *     Internet Archive   532x300   (once)
 *
 * Four of the six clips under the bar were STOCK, and 426x226 is the worst of them — blown up
 * almost five times to fill a 1920x1080 frame. The argument for holding back was about archive
 * material; the material actually under the bar was not archive material.
 *
 * ── Which is why the floor is per SOURCE KIND, not global ────────────────────────────────────
 *
 * The reasoning that protected the archive is still correct and still applies: a 1945 newsreel
 * digitised at 352x240 is the only copy there is, and refusing it would remove precisely what
 * this pipeline exists to find. Nothing about the archive changes here.
 *
 * What changes is stock. A stock library that cannot supply 480 lines for a query has not given
 * us the only copy of anything — it has given us a small file, and there is another one.
 *
 *   STOCK    480 lines, refused. pexels, pixabay, youtube_cc and the other modern libraries.
 *   ARCHIVE  144 lines, unchanged, with 480 still only a NOTE.
 *
 * Both numbers remain the ones sourcingPolicy's youtubeMinFormatHeight() has carried since
 * RONDE 27 for exactly this question. No new threshold is invented here; the 480 that was already
 * written down is simply allowed to act, on the half of the material the evidence points at.
 */
export const VIDEO_MIN_SHORT_SIDE_PX = 144;
export const VIDEO_QUALITY_BAR_SHORT_SIDE_PX = 480;

/**
 * Is this video big enough to scale into the 1920×1080 frame at all?
 *
 * `belowQualityBar` is an observation, never a refusal — see above. Absence is neutral: a file
 * ffprobe could not measure passes, exactly as an unmeasurable still does.
 */
/**
 * Stock LIBRARIES — providers that hold many interchangeable copies of a subject.
 *
 * Deliberately an explicit list: a source that is not named here is treated as ARCHIVE and keeps
 * the permissive 144-line floor. Getting that default wrong in the other direction would silently
 * start refusing archive footage, which is the outcome this whole design exists to avoid.
 *
 * ── Why YouTube CC is NOT on this list ───────────────────────────────────────────────────────
 *
 * It looks like stock and video 558 measured it at 640x360, under the bar. But sourcingPolicy has
 * already decided this exact question for YouTube, and decided it the other way:
 *
 *     const adequate = mp4.filter((f) => (f.height ?? 720) >= youtubeMinFormatHeight());
 *     if (adequate.length) return adequate.sort(...)[0];
 *     return mp4.sort((a, b) => (b.height ?? 0) - (a.height ?? 0))[0];   ← take the tallest anyway
 *
 * That is "prefer 480, but a lower format beats no shot at all", written down and deliberate. A
 * hard 480 reject here would silently overrule it, and the round that authorised this floor asked
 * for it only where it "safely connects to the existing sourcingPolicy". For YouTube it does not.
 *
 * The justification for refusing Pexels at 426x226 does not transfer either: a stock library that
 * cannot supply 480 lines has another clip, whereas a specific YouTube video has one upload.
 */
const STOCK_SOURCES = new Set(["pexels", "pixabay", "coverr", "videvo"]);

export function isStockSource(source: string | null | undefined): boolean {
  const s = (source ?? "").trim().toLowerCase();
  if (!s) return false;
  return STOCK_SOURCES.has(s) || [...STOCK_SOURCES].some((k) => s.includes(k));
}

/** The floor this source is held to. Stock gets the quality bar; everything else the absolute one. */
export function minShortSideForSource(source: string | null | undefined): number {
  return isStockSource(source) ? VIDEO_QUALITY_BAR_SHORT_SIDE_PX : VIDEO_MIN_SHORT_SIDE_PX;
}

export function videoResolutionVerdict(
  width: number | null | undefined,
  height: number | null | undefined,
  minShortSidePx: number = VIDEO_MIN_SHORT_SIDE_PX
): TechnicalVerdict & { belowQualityBar?: boolean } {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  if (!(w > 0) || !(h > 0)) return OK;
  const shortSide = Math.min(w, h);
  if (shortSide < minShortSidePx) {
    return reject("video_too_low_res", `${w}x${h}`, `${minShortSidePx} lines`);
  }
  return { ok: true, belowQualityBar: shortSide < VIDEO_QUALITY_BAR_SHORT_SIDE_PX };
}

/**
 * `[TechnicalGate] NOTE s2b0 source=loc type=video below_quality_bar actual=352x240 bar=480 lines`
 *
 * The evidence a future round needs to decide whether 480 should start refusing. Deliberately a
 * different verb from REJECT: nothing was thrown away.
 */
export function formatBelowQualityBar(params: {
  beatLabel: string;
  source: string;
  contentKey: string;
  width: number;
  height: number;
}): string {
  return (
    `[TechnicalGate] NOTE ${params.beatLabel} source=${params.source} ` +
    `contentKey=${params.contentKey} type=video below_quality_bar ` +
    `actual=${params.width}x${params.height} bar=${VIDEO_QUALITY_BAR_SHORT_SIDE_PX} lines`
  );
}

/**
 * Is this still big enough to be worth showing?
 *
 * `widthPx` is what probeImageWidthPx returned for the file that was actually downloaded — not a
 * width the provider claimed in its search response. Providers report the ORIGINAL's dimensions
 * while serving a resized file, so a metadata check would approve a thumbnail on the strength of
 * the full-resolution photo it was made from.
 */
export function stillResolutionVerdict(
  widthPx: number,
  minWidthPx: number = VIDRUSH_MIN_STILL_WIDTH
): TechnicalVerdict {
  // Absence is neutral — see the module comment.
  if (!(widthPx > 0)) return OK;
  if (widthPx >= minWidthPx) return OK;
  return reject("still_too_low_res", `${widthPx}px`, `${minWidthPx}px`);
}

/** Is the downloaded file big enough to be a real asset rather than an error page or a stub? */
export function fileSizeVerdict(sizeBytes: number, minBytes: number): TechnicalVerdict {
  if (sizeBytes >= minBytes) return OK;
  return reject("file_too_small", `${sizeBytes}B`, `${minBytes}B`);
}

/**
 * Is there enough footage to cut a shot out of?
 *
 * ── RONDE 134: the duration has to come off the FILE ─────────────────────────────────────────
 *
 * The pool route used to do this:
 *
 *     let sourceDur = candidate.durationSec ?? 0;         // what the provider CLAIMED
 *     try { sourceDur = <ffprobe format=duration> } catch { }
 *     if (sourceDur < 1.5) return null;
 *
 * so a file ffprobe could not read at all still cleared the duration check — on the strength of a
 * number from a search response, which says nothing whatsoever about whether the bytes on disk are
 * readable. Worse, it made the SAME unreadable file pass or fail depending on metadata: a provider
 * that reported 12s got through and spent a full libx264 encode before failing; a provider that
 * reported nothing was refused. Two answers to one question about one file.
 *
 * Three states, and the middle one is the point:
 *
 *   measured, below the floor   → refuse. The file is genuinely too short.
 *   measured, at or above       → accept.
 *   NOT MEASURED (pass null)    → unknown, and unknown is neutral. Accept, and say so.
 *
 * Unknown may not refuse, because ffprobe times out under exactly the memory pressure this
 * pipeline creates for itself — turning "the machine was busy" into "throw the shot away" would
 * lose good footage at the worst possible moment. And unknown may not be ANSWERED by the
 * provider either. It stays unknown.
 */
export function sourceDurationVerdict(
  measuredDurationSec: number | null,
  minSec: number
): TechnicalVerdict {
  if (measuredDurationSec == null || !Number.isFinite(measuredDurationSec)) return OK;
  if (!(measuredDurationSec > 0)) return OK;
  if (!(measuredDurationSec < minSec)) return OK;
  return reject(
    "duration_too_short",
    `${measuredDurationSec.toFixed(2)}s`,
    `${minSec.toFixed(2)}s`
  );
}

/**
 * One line, one shape, for every technical refusal.
 *
 * Before this round exactly one of the pool route's five refusal paths said anything at all: the
 * HTTP status. The byte floor, the duration floor, the trim failure and the still conversion all
 * returned null in silence, so a beat that ended with no picture left no trace of WHY its
 * candidates were dropped — the question was simply unanswerable after the fact.
 *
 *     [TechnicalGate] REJECT s2b0 source=wikimedia asset=Bundesarchiv_Bild_183.jpg
 *                     reason=still_too_low_res detail=320px < 960px
 */
export function formatTechnicalReject(params: {
  beatLabel: string;
  source: string;
  assetId: string;
  /** RONDE 134: the asset's identity across routes, so a refusal can be traced to one file. */
  contentKey?: string;
  /** RONDE 134: a still and a video are refused for different reasons and read differently. */
  mediaType?: "video" | "image";
  verdict: Extract<TechnicalVerdict, { ok: false }>;
}): string {
  const trim = (s: string) => (s.length > 60 ? `${s.slice(0, 57)}...` : s);
  return (
    `[TechnicalGate] REJECT ${params.beatLabel} source=${params.source} ` +
    `asset=${trim(params.assetId)} ` +
    (params.contentKey ? `contentKey=${trim(params.contentKey)} ` : "") +
    (params.mediaType ? `type=${params.mediaType} ` : "") +
    `reason=${params.verdict.reason} ` +
    `actual=${params.verdict.actual} required=${params.verdict.required} ` +
    `detail=${params.verdict.detail}`
  );
}
