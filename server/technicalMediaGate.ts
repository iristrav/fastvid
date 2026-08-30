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
  | "duration_too_short"
  | "encode_failed"
  | "still_conversion_failed";

export type TechnicalVerdict =
  | { ok: true }
  | { ok: false; reason: TechnicalRejectReason; detail: string };

const OK: TechnicalVerdict = { ok: true };

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
  return {
    ok: false,
    reason: "still_too_low_res",
    detail: `${widthPx}px < ${minWidthPx}px`,
  };
}

/** Is the downloaded file big enough to be a real asset rather than an error page or a stub? */
export function fileSizeVerdict(sizeBytes: number, minBytes: number): TechnicalVerdict {
  if (sizeBytes >= minBytes) return OK;
  return {
    ok: false,
    reason: "file_too_small",
    detail: `${sizeBytes}B < ${minBytes}B`,
  };
}

/** Is there enough footage to cut a shot out of? */
export function sourceDurationVerdict(durationSec: number, minSec: number): TechnicalVerdict {
  if (!(durationSec < minSec)) return OK;
  return {
    ok: false,
    reason: "duration_too_short",
    detail: `${durationSec.toFixed(2)}s < ${minSec.toFixed(2)}s`,
  };
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
  verdict: Extract<TechnicalVerdict, { ok: false }>;
}): string {
  const asset = params.assetId.length > 60 ? `${params.assetId.slice(0, 57)}...` : params.assetId;
  return (
    `[TechnicalGate] REJECT ${params.beatLabel} source=${params.source} asset=${asset} ` +
    `reason=${params.verdict.reason} detail=${params.verdict.detail}`
  );
}
