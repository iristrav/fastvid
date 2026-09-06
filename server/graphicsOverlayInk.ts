/**
 * DOES THE GRAPHICS OVERLAY ACTUALLY CONTAIN INK?
 *
 * ── The gap this closes ─────────────────────────────────────────────────────────────────────
 *
 * `timelineRenderer` composites the Remotion overlay when `fs.existsSync(overlay.overlayPath)`
 * answers yes. That is an EXISTENCE check. An overlay that was written and is entirely
 * transparent passes it, gets composited, contributes nothing, and no line anywhere says so.
 *
 * Every graphics count upstream is a PREDICATE: `rendered` asks `graphicIsRenderable`,
 * `graphicsDrawn` asks the same question of the same list, and RONDE 110's explicit/generic split
 * refines that same yes. Not one of them observes an outcome. RONDE 111 traced the chain and found
 * REMOTION → FINAL MP4 to be the only transition with no measurement at all.
 *
 * This is that measurement, and nothing more.
 *
 * ── What it proves, and what it does not ────────────────────────────────────────────────────
 *
 * PROVES     the overlay heading into compositing carries visible alpha somewhere.
 * DOES NOT   prove any particular graphic is in it, or that the composite kept it. The overlay is
 *            one .mov with no per-graphic markers, so "graphic X is visible in the final MP4"
 *            stays out of reach — see RONDE 111's finding 5, which is inherent, not a defect.
 *
 * ── Why frames and max alpha, not a pixel count ─────────────────────────────────────────────
 *
 * The brief asked for `overlayInkPixels`. `signalstats` reports YMAX — the highest alpha in a
 * frame — not how many pixels carry it, and there is no cheap ffmpeg primitive that counts them.
 * Reporting YMAX under a name ending in "Pixels" would be a unit the number does not have, which
 * is the kind of thing this project spends whole rounds undoing. So the fields say what they
 * measure: how many sampled frames carried ink, and how strong the strongest was.
 *
 * ── The sampling trade-off, stated ──────────────────────────────────────────────────────────
 *
 * A full-resolution decode of every frame of a ProRes 4444 alpha channel is the honest maximum
 * and is far too expensive for every render. The probe samples at `SAMPLE_FPS`, so a graphic
 * shorter than one sample interval can be missed and the answer is then a false `transparent`.
 * `framesSampled` is reported so a reader can see how coarse the look was.
 */
import * as path from "path";

/** Frames per second sampled from the overlay. Four is one look every 250ms. */
export const SAMPLE_FPS = 4;

/**
 * Alpha above this counts as ink — the same floor RONDE 160 §7's pixel test uses.
 *
 * On the 8-bit scale the probe normalises to; see `format=gray` in `overlayInkProbeArgs`.
 */
export const INK_ALPHA_FLOOR = 8;

export type OverlayInkStatus = "ink" | "transparent" | "unknown";

export type OverlayInkResult = {
  /**
   * The overlay's file NAME, never its path.
   *
   * Carried on the result so a caller that only has the measurement can name the file it describes
   * without having to guess the name — a hardcoded "graphics_overlay.mov" in a log line would be a
   * label nobody measured, and this whole round exists to stop reporting things nobody measured.
   */
  overlay: string;
  status: OverlayInkStatus;
  /** Sampled frames whose strongest alpha cleared the floor. */
  inkFrames: number;
  /** Frames the probe actually looked at. */
  framesSampled: number;
  /** The strongest alpha seen anywhere, 0–255. */
  maxAlpha: number;
  durationMs: number;
  /** Present only when the status is `unknown`. */
  reason?: string;
};

/**
 * Every `lavfi.signalstats.YMAX` value ffmpeg printed, in order.
 *
 * Pure, so the measurement can be tested without a render. ffmpeg prints these on stderr as
 * `lavfi.signalstats.YMAX=207`, one per sampled frame, and anything unparseable is skipped rather
 * than coerced — a malformed line is not a black frame.
 */
export function parseSignalstatsYMax(output: string): number[] {
  const out: number[] = [];
  for (const m of output.matchAll(/lavfi\.signalstats\.YMAX=(\d+(?:\.\d+)?)/g)) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/**
 * The verdict for a set of per-frame maxima.
 *
 * NO SAMPLES IS `unknown`, NEVER `transparent`. An overlay the probe could not read is a thing
 * nobody looked at, and reporting that as "contains no ink" would invent a measurement — the
 * exact failure this whole line of rounds keeps correcting.
 */
export function summariseInk(
  overlay: string,
  yMaxes: readonly number[],
  durationMs: number
): OverlayInkResult {
  if (yMaxes.length === 0) {
    return {
      overlay,
      status: "unknown",
      inkFrames: 0,
      framesSampled: 0,
      maxAlpha: 0,
      durationMs,
      reason: "probe read no frames",
    };
  }
  const inkFrames = yMaxes.filter((y) => y > INK_ALPHA_FLOOR).length;
  const maxAlpha = Math.round(Math.max(...yMaxes));
  return {
    overlay,
    status: inkFrames > 0 ? "ink" : "transparent",
    inkFrames,
    framesSampled: yMaxes.length,
    maxAlpha,
    durationMs,
  };
}

/** The ffmpeg arguments, separated so a test can assert them without running ffmpeg. */
export function overlayInkProbeArgs(overlayPath: string): string[] {
  return [
    "-hide_banner",
    "-nostats",
    "-i", overlayPath,
    /**
     * `alphaextract` turns the alpha channel into a greyscale picture, `fps` bounds the cost, and
     * `signalstats` reports each frame's maximum — printed by `metadata` on stderr. `-f null`
     * decodes without encoding anything.
     *
     * `format=gray` IS LOAD-BEARING, not tidiness. signalstats reports YMAX in the SOURCE's bit
     * depth, and the overlay is ProRes 4444 with a 10-bit alpha channel: without this the same
     * fully-opaque pixel reads 4095 here and 255 in RONDE 160 §7's 8-bit pixel test, and
     * `INK_ALPHA_FLOOR` would silently mean a different thing on each. Normalising to 8-bit gray
     * first makes `maxAlpha` a number in one fixed range whatever the overlay was encoded as.
     */
    "-vf",
    `alphaextract,fps=${SAMPLE_FPS},format=gray,signalstats,metadata=print:key=lavfi.signalstats.YMAX`,
    "-an",
    "-f", "null",
    "-",
  ];
}

export type ProbeExec = (
  bin: string,
  args: readonly string[]
) => Promise<{ stdout: string; stderr: string }>;

/**
 * Measure one overlay. Never throws: a probe that cannot run reports `unknown` with its reason,
 * because a failed measurement must not be able to fail a render that is otherwise fine.
 */
export async function probeOverlayInk(
  overlayPath: string,
  ffmpegBin: string,
  exec: ProbeExec
): Promise<OverlayInkResult> {
  const started = Date.now();
  const overlay = path.basename(overlayPath);
  try {
    const { stdout, stderr } = await exec(ffmpegBin, overlayInkProbeArgs(overlayPath));
    return summariseInk(overlay, parseSignalstatsYMax(`${stderr}\n${stdout}`), Date.now() - started);
  } catch (err) {
    return {
      overlay,
      status: "unknown",
      inkFrames: 0,
      framesSampled: 0,
      maxAlpha: 0,
      durationMs: Date.now() - started,
      reason: `probe failed: ${(err as Error).message.slice(0, 160)}`,
    };
  }
}

/** One line, in the existing `[Graphics]` style. Never a path — the file name is enough. */
export function formatOverlayInk(r: OverlayInkResult): string {
  const parts = [
    `overlay=${r.overlay}`,
    `ink=${r.status}`,
    `inkFrames=${r.inkFrames}/${r.framesSampled}`,
    `maxAlpha=${r.maxAlpha}`,
    `probeMs=${r.durationMs}`,
  ];
  if (r.reason) parts.push(`reason=${r.reason}`);
  return `[Graphics] ${parts.join(" ")}`;
}
