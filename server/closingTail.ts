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

/**
 * RONDE 132 — where to start looking for the last picture.
 *
 * ── The bug, measured rather than guessed ────────────────────────────────────────────────────
 *
 * Production: `[ClosingTail] could not be built`, on a file the log described as ~21.4 seconds,
 * from a frame grab at 21.297s. Reproduced exactly, with a scene-shaped MP4 whose audio runs a
 * fraction past its picture — which is every composed scene, because the voiceover and its fade
 * end after the last video frame:
 *
 *     format=duration          21.400      ← what probeVideoDurationSec reads
 *     stream=duration (v:0)    21.200
 *     last video frame pts     21.160
 *
 *     ffmpeg -ss 21.300 -i scene.mp4 -frames:v 1 out.jpg
 *     → "Output file is empty, nothing was encoded"
 *
 * The container's duration is the MAXIMUM over its streams. `probeVideoDurationSec` reads
 * `format=duration`, so on any scene with audio it returns the audio's length, and RONDE 121's
 * `duration - 0.1` was subtracting a tenth of a second from the wrong number. Here that leaves the
 * seek 0.14s past the final picture; the grab produces no file, `fileExists` is false, and the
 * tail is silently dropped.
 *
 * No constant can fix that. The gap between the container and the picture is however long the
 * audio outlives the video, and 0.1 was a guess at a quantity that is not fixed.
 *
 * ── The rule instead ─────────────────────────────────────────────────────────────────────────
 *
 * Two changes, and the second is the one that makes it safe.
 *
 *  1. Measure against the VIDEO stream. `stream=duration` on v:0 is a statement about the
 *     picture; `format=duration` is a statement about the file.
 *  2. Stop naming a target frame at all. The command opens a short WINDOW at the end and writes
 *     every frame in it over the same file (`-update 1`), so what survives is the last frame that
 *     actually decoded. A window start can be early and still be right; a target timestamp is
 *     either exactly inside the file or it yields nothing, and variable frame rate, edit lists and
 *     B-frame reordering all make "exactly" a promise no arithmetic here can keep.
 *
 * Verified on the reproduction above: the window grab is byte-identical to an explicit grab of the
 * frame at 21.160, and so is the full-decode fallback.
 */

/**
 * How much of the end to decode when hunting for the last frame.
 *
 * Long enough to contain several frames at any sane rate, short enough that this stays a
 * fraction of a second of decoding on a scene that may be a minute long.
 */
export const CLOSING_TAIL_FRAME_WINDOW_SEC = 0.5;

export type ClosingTailSeek = {
  /** Where to start decoding. Provably at or before the last frame — see closingTailSeekIsSafe. */
  seekSec: number;
  /** Which duration the answer was derived from, so a log can say why it chose what it chose. */
  basis: "video_stream" | "container";
  /** The duration that was actually used. */
  effectiveDurationSec: number;
};

/**
 * Where to open the window.
 *
 * The video stream's duration is preferred and the container's is the fallback, because a probe
 * can legitimately return nothing for a stream duration (some containers do not store one). When
 * the container is the only number available the window still protects the grab: it is half a
 * second wide, which absorbs a divergence the old fixed 0.1 could not.
 *
 * A video stream duration LONGER than the container is not believed — that combination means one
 * of the two probes is wrong, and the smaller number is the safe one to seek against.
 */
export function closingTailFrameSeek(params: {
  containerDurationSec: number;
  videoStreamDurationSec?: number | null;
  fps?: number;
}): ClosingTailSeek {
  const container = params.containerDurationSec > 0 ? params.containerDurationSec : 0;
  const stream = params.videoStreamDurationSec ?? 0;
  const fps = params.fps && params.fps > 0 ? params.fps : 25;

  const useStream = stream > 0 && stream <= container + 0.05;
  const effectiveDurationSec = useStream ? stream : container;

  // At least two frames of margin on top of the window, so the window always contains a frame
  // even when the stream duration is reported one frame long.
  const backOff = Math.max(CLOSING_TAIL_FRAME_WINDOW_SEC, 2 / fps);
  return {
    seekSec: Math.max(0, effectiveDurationSec - backOff),
    basis: useStream ? "video_stream" : "container",
    effectiveDurationSec,
  };
}

/**
 * Is this seek inside the picture?
 *
 * The acceptance criterion RONDE 132 states — "de gekozen timestamp moet binnen het geldige
 * framebereik liggen" — as a function, so a test can assert it against a real file's real last
 * frame rather than against the arithmetic that produced it.
 */
export function closingTailSeekIsSafe(seekSec: number, lastFramePtsSec: number): boolean {
  return Number.isFinite(seekSec) && seekSec >= 0 && seekSec <= lastFramePtsSec;
}

/** One line naming the numbers the seek was derived from. */
export function formatClosingTailSeek(seek: ClosingTailSeek, containerDurationSec: number): string {
  return (
    `[ClosingTail] last-frame window from ${seek.seekSec.toFixed(3)}s ` +
    `(basis=${seek.basis} effective=${seek.effectiveDurationSec.toFixed(3)}s ` +
    `container=${containerDurationSec.toFixed(3)}s) — taking the last frame that decodes`
  );
}

/**
 * RONDE 122 — may the trailing-black trimmer cut here?
 *
 * The final stage looks for a dark run reaching the end of the film and cuts back to where the
 * picture stopped. That was safe while everything at the end of the file was accidental. The
 * closing hold is not: it is the film's own last image, and documentaries end on dark images all
 * the time — a bunker interior, a night shot, a fade already present in the source.
 *
 * `blackdetect` cannot tell those apart. On any dark ending it reports a black run that reaches
 * the end of the file, and the trimmer would cut off exactly the three seconds RONDE 121 added.
 *
 * The rule is narrow: a black run counts as leftover only while it ENDS before the closing hold
 * begins. Reach into the hold and the trim is refused entirely — never shortened to the hold's
 * start, because a run that spans both is one dark image continuing into its own freeze-frame, and
 * cutting at its start would take the hold with it.
 *
 * Split out as a predicate rather than left inline so this can be tested against real blackdetect
 * output instead of by reading the pipeline.
 */
export function trailingBlackTrimReachesClosingTail(params: {
  lastBlackEndSec: number;
  videoDurationSec: number;
  closingTailSec: number;
}): boolean {
  const { lastBlackEndSec, videoDurationSec, closingTailSec } = params;
  if (!(closingTailSec > 0) || !(videoDurationSec > 0)) return false;
  const tailStartsAt = videoDurationSec - closingTailSec;
  // A frame's worth of slack: blackdetect reports to the millisecond and the concat join is not
  // sample-exact, so a run ending a hair after the boundary is still a run that ended before it.
  return lastBlackEndSec > tailStartsAt + 0.05;
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
  /** The CONTAINER duration, as probeVideoDurationSec returns it. */
  lastSceneDurationSec: number;
  /**
   * RONDE 132 — the VIDEO stream's own duration, when the caller has it.
   *
   * This is the number the frame grab has to respect; the container's is the maximum over all
   * streams and on a scene with a voiceover it is the audio's. Optional so a caller without it
   * still works — the window then opens against the container, which is wider than the old
   * behaviour and no longer betting a fixed 0.1s against an unbounded divergence.
   */
  lastSceneVideoDurationSec?: number | null;
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
   * RONDE 132 — open a window at the end and keep whatever frame closes it.
   *
   * `-update 1` makes the image muxer rewrite the SAME file for every frame it receives, so after
   * decoding from `seekSec` to EOF the file holds the last frame that existed. There is no target
   * timestamp to be past, which is the entire failure this replaces: RONDE 121 asked for the frame
   * at `containerDuration - 0.1`, which on a scene whose audio outlives its picture is past the
   * final frame, and ffmpeg answers that with an empty output and a zero exit code.
   *
   * Two attempts. The window is the cheap one; a full decode from zero is the one that cannot
   * fail, and is reached only when the probe's numbers were wrong enough that even a half-second
   * window missed. A scene is seconds long, so the fallback is affordable exactly because it is
   * rare.
   */
  const seek = closingTailFrameSeek({
    containerDurationSec: params.lastSceneDurationSec,
    videoStreamDurationSec: params.lastSceneVideoDurationSec,
    fps,
  });

  try {
    await params.run(
      `${params.ffmpegBin} -y -ss ${seek.seekSec.toFixed(3)} -i "${params.lastScenePath}" ` +
        `-q:v 2 -update 1 "${params.framePath}"`,
      30_000,
      "ClosingTail: last frame"
    );
    if (!params.fileExists(params.framePath)) {
      console.warn(
        `[ClosingTail] no frame in the last ${(seek.effectiveDurationSec - seek.seekSec).toFixed(2)}s ` +
          `(basis=${seek.basis}) — decoding the whole scene for its final frame`
      );
      await params.run(
        `${params.ffmpegBin} -y -i "${params.lastScenePath}" -q:v 2 -update 1 "${params.framePath}"`,
        60_000,
        "ClosingTail: last frame (full decode)"
      );
    }
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
