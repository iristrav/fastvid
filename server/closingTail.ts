/**
 * RONDE 121 — let the last picture breathe.
 *
 * The video ends on the last syllable. The voiceover stops, the final scene stops with it, and
 * the file is over — which is the one place in a documentary where an editor would hold. There is
 * nowhere for the viewer to land, and on YouTube the end screen lands on a cut rather than on a
 * picture.
 *
 * So: three seconds of picture after the narration ends. No voice, no text, no new footage —
 * the film's own last image, carried past the last word.
 *
 * ── Why this is not a freeze ──────────────────────────────────────────────────────────────────
 *
 * A held frame is banned in this pipeline, and rightly: RONDE 111 measured what one looks like
 * (0.59s per picture under 10x slow motion, invisible to `freezedetect`) and RONDE 112 removed the
 * last route to one. A three-second still would be exactly the thing the whole coverage chain was
 * built to stop.
 *
 * The tail therefore MOVES. It is a slow push on the last frame — the same Ken Burns treatment
 * every still in the film already gets — and the motion is LINEAR, so its velocity at the final
 * frame equals its velocity at the first. RONDE 111 found the trap here: an eased zoom
 * (`sin(PI/2 * t)`) has derivative zero at t=1, so the picture creeps to a halt in the last
 * moments and reads as a freeze even though the filter is technically still running. The last
 * three seconds of a film are precisely where that must not happen.
 *
 * ── What this module is ───────────────────────────────────────────────────────────────────────
 *
 * The plan and the one ffmpeg command that builds the segment. It imports nothing from the
 * pipeline: the binary and the command runner are passed in, the same way archivePreviewCheck
 * takes its frame extractor, so this stays testable without dragging a render in behind it.
 */

/** Seconds of picture after the narration ends. */
export const CLOSING_TAIL_SEC = 3;

/** Upper bound on the override, so a typo cannot append a minute of still image to every video. */
const MAX_CLOSING_TAIL_SEC = 10;

/**
 * How long the tail runs.
 *
 * `CLOSING_TAIL_SEC=0` turns it off completely — the escape hatch that keeps this reversible in
 * production without a redeploy, and the switch a test uses to prove the rest of the pipeline is
 * unchanged when it is off.
 */
export function closingTailSeconds(): number {
  const raw = process.env.CLOSING_TAIL_SEC?.trim();
  if (raw === undefined || raw === "") return CLOSING_TAIL_SEC;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n < 0) return CLOSING_TAIL_SEC;
  return Math.min(n, MAX_CLOSING_TAIL_SEC);
}

/** How far the picture travels across the tail. Small enough to read as a hold, big enough to see. */
const TAIL_ZOOM_TRAVEL = 0.06;

/**
 * The zoom expression for the tail.
 *
 * `on` is the output frame index and `total - 1` the last one, so the ratio runs 0 → 1 across the
 * segment and the zoom runs 1 → 1 + travel. Deliberately a straight line: see the note above on
 * why an eased curve is the wrong shape for the final seconds of a film.
 *
 * Exported because "does this expression still move at the end" is a property worth asserting
 * directly rather than inferring from a rendered file.
 */
export function closingTailZoomExpr(totalFrames: number): string {
  const last = Math.max(1, totalFrames - 1);
  return `1+${TAIL_ZOOM_TRAVEL}*on/${last}`;
}

/**
 * Pixels of travel between the first and last frame pair — the number that says whether a viewer
 * would see movement at all. Used by the test that guards against the tail becoming a still.
 */
export function closingTailEndVelocityPx(totalFrames: number, frameHeightPx: number): number {
  const last = Math.max(1, totalFrames - 1);
  // Linear zoom: every frame advances the same fraction of the travel, so one frame's worth of
  // movement is the whole travel divided by the frame count.
  return (TAIL_ZOOM_TRAVEL / last) * frameHeightPx;
}

export type ClosingTailPlan = {
  tailSec: number;
  totalFrames: number;
  /** ffmpeg -vf for the still → moving segment. */
  videoFilter: string;
};

/**
 * Work out the segment before building it.
 *
 * Split from the ffmpeg call so the arithmetic can be checked without a render — the same split
 * that made RONDE 111's coverage plan testable.
 */
export function planClosingTail(params: {
  tailSec: number;
  widthPx: number;
  heightPx: number;
  fps: number;
}): ClosingTailPlan | null {
  const { widthPx, heightPx } = params;
  const fps = params.fps > 0 ? params.fps : 25;
  const tailSec = params.tailSec;
  if (!(tailSec > 0) || !(widthPx > 0) || !(heightPx > 0)) return null;

  const totalFrames = Math.max(2, Math.round(tailSec * fps));
  /**
   * The source is upscaled before zoompan and back down after.
   *
   * zoompan works on the INPUT resolution, so zooming a 1920-wide frame directly produces visible
   * stepping as the crop window moves by whole source pixels. Scaling up first makes each step a
   * fraction of an output pixel, which is the difference between a smooth push and a judder.
   */
  const superWidth = widthPx * 2;
  const videoFilter =
    `scale=${superWidth}:-2,` +
    `zoompan=z='${closingTailZoomExpr(totalFrames)}':d=${totalFrames}` +
    `:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${widthPx}x${heightPx}:fps=${fps},` +
    `format=yuv420p,setsar=1`;

  return { tailSec, totalFrames, videoFilter };
}

/** One line in the pipeline's own log voice. */
export function formatClosingTailPlan(plan: ClosingTailPlan, widthPx: number, heightPx: number): string {
  const px = closingTailEndVelocityPx(plan.totalFrames, heightPx);
  return (
    `[ClosingTail] ${plan.tailSec.toFixed(1)}s after the narration — ${plan.totalFrames} frames at ` +
    `${widthPx}x${heightPx}, linear push (${px.toFixed(2)}px/frame, same at the last frame as the first)`
  );
}

/**
 * Build the tail segment.
 *
 * Two commands, both deliberate:
 *
 *  1. the last frame is extracted from the finished scene, so the tail continues the film's own
 *     picture rather than introducing anything new;
 *  2. the segment is encoded with a SILENT audio track. The concat demuxer needs every input to
 *     carry the same streams, and a video-only tail would either be refused or would truncate the
 *     audio of the whole film. The silence is also correct on its own terms: the narration has
 *     ended, and the background music is mixed over the finished concat, so it plays on across
 *     the tail exactly as it should.
 *
 * Returns null on any failure. A tail is a finishing touch — it must never be able to cost a
 * render that is otherwise complete.
 */
export async function buildClosingTail(params: {
  lastScenePath: string;
  outputPath: string;
  framePath: string;
  ffmpegBin: string;
  run: (cmd: string, timeoutMs: number, label: string) => Promise<unknown>;
  lastSceneDurationSec: number;
  tailSec?: number;
  widthPx?: number;
  heightPx?: number;
  fps?: number;
  /** Encoder settings, passed in so the tail matches whatever the concat expects. */
  encodeArgs?: string;
  fileExists: (p: string) => boolean;
}): Promise<{ path: string; plan: ClosingTailPlan } | null> {
  const tailSec = params.tailSec ?? closingTailSeconds();
  const widthPx = params.widthPx ?? 1920;
  const heightPx = params.heightPx ?? 1080;
  const fps = params.fps ?? 25;
  const plan = planClosingTail({ tailSec, widthPx, heightPx, fps });
  if (!plan) return null;

  /**
   * Grab the frame just BEFORE the end rather than at it.
   *
   * The last scene fades its audio out and can carry a video fade too; seeking to the exact
   * duration also lands past the final frame on some containers and yields nothing at all. A
   * tenth of a second back is still the closing image and is reliably there.
   */
  const seekSec = Math.max(0, params.lastSceneDurationSec - 0.1);

  try {
    await params.run(
      `${params.ffmpegBin} -y -ss ${seekSec.toFixed(3)} -i "${params.lastScenePath}" ` +
        `-frames:v 1 -q:v 2 "${params.framePath}"`,
      30_000,
      "ClosingTail: last frame"
    );
    if (!params.fileExists(params.framePath)) return null;

    await params.run(
      `${params.ffmpegBin} -y -loop 1 -t ${plan.tailSec.toFixed(3)} -i "${params.framePath}" ` +
        `-f lavfi -t ${plan.tailSec.toFixed(3)} -i anullsrc=channel_layout=stereo:sample_rate=48000 ` +
        `-vf "${plan.videoFilter}" ${params.encodeArgs ?? "-c:v libx264 -preset veryfast -crf 18"} ` +
        `-c:a aac -b:a 320k -shortest -movflags +faststart "${params.outputPath}"`,
      60_000,
      "ClosingTail: build segment"
    );
    if (!params.fileExists(params.outputPath)) return null;
    return { path: params.outputPath, plan };
  } catch {
    return null;
  }
}
