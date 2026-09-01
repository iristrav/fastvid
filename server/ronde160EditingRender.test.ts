/**
 * RONDE 160 §8 — the editing operations, executed by real ffmpeg and measured in real pixels.
 *
 * ── What this file refuses to accept as evidence ─────────────────────────────────────────────
 *
 * Every editing feature in this codebase is currently proven by a test that reads the ffmpeg
 * FILTER STRING: "the chain contains `crop=`", "the chain contains `colorbalance`". That is a test
 * of the string builder, and it is worth having, but it cannot tell the difference between a filter
 * that runs and a filter that is silently dropped, applied to the wrong input, overwritten by a
 * later stage of the chain, or negated by the scale that follows it.
 *
 * So nothing here looks at a filter string. Each test renders a real MP4 with real ffmpeg from a
 * synthetic source whose colours make the answer unambiguous, then reads PIXELS out of the finished
 * file and asserts what a viewer would actually see.
 *
 * ── Why synthetic sources rather than real footage ───────────────────────────────────────────
 *
 * A flat red frame answers "did the crop take the left half or the right half" with certainty; a
 * documentary clip answers it with a judgement call. These are measurements, so the inputs are
 * built to be measurable.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { emptyTimeline, type ProjectTimeline, type TimelineVideoClip } from "./projectTimeline";
import { renderTimeline } from "./timelineRenderer";
import { resolveFFmpegBin } from "./ffmpegBinary";

const execFileAsync = promisify(execFile);
const FFMPEG = resolveFFmpegBin();

/* ═══════════════════════ measuring a rendered frame ═══════════════════════ */

type RGB = { r: number; g: number; b: number };

/** One frame of the finished video, as raw RGB at its own resolution. */
async function frameAt(video: string, atSec: number, out: string): Promise<{ buf: Buffer; w: number; h: number }> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", video,
  ]);
  const [w, h] = stdout.trim().split("x").map(Number) as [number, number];
  await execFileAsync(FFMPEG, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-ss", atSec.toFixed(3), "-i", video,
    "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", out,
  ]);
  return { buf: fs.readFileSync(out), w, h };
}

/** The pixel at a NORMALISED position, so a test reads the same place at any resolution. */
function pixelAt(frame: { buf: Buffer; w: number; h: number }, nx: number, ny: number): RGB {
  const x = Math.min(frame.w - 1, Math.max(0, Math.round(nx * (frame.w - 1))));
  const y = Math.min(frame.h - 1, Math.max(0, Math.round(ny * (frame.h - 1))));
  const i = (y * frame.w + x) * 3;
  return { r: frame.buf[i]!, g: frame.buf[i + 1]!, b: frame.buf[i + 2]! };
}

/**
 * The mean colour of the whole frame.
 *
 * Used where a single pixel would be a lottery — a grade shifts every pixel a little, and encoding
 * noise moves any one of them by a few counts. The mean of 100k pixels does not wobble.
 */
function meanColour(frame: { buf: Buffer; w: number; h: number }): RGB {
  let r = 0, g = 0, b = 0;
  const n = frame.w * frame.h;
  for (let i = 0; i < n; i++) {
    r += frame.buf[i * 3]!;
    g += frame.buf[i * 3 + 1]!;
    b += frame.buf[i * 3 + 2]!;
  }
  return { r: r / n, g: g / n, b: b / n };
}

/** How many pixels are near a target colour. The measure for "did the picture get bigger". */
function countNear(frame: { buf: Buffer; w: number; h: number }, target: RGB, tolerance = 40): number {
  let n = 0;
  for (let i = 0; i < frame.w * frame.h; i++) {
    if (
      Math.abs(frame.buf[i * 3]! - target.r) <= tolerance &&
      Math.abs(frame.buf[i * 3 + 1]! - target.g) <= tolerance &&
      Math.abs(frame.buf[i * 3 + 2]! - target.b) <= tolerance
    ) n++;
  }
  return n;
}

const isBlack = (p: RGB) => p.r < 34 && p.g < 34 && p.b < 34;
const isRed = (p: RGB) => p.r > 150 && p.g < 80 && p.b < 80;
const isBlue = (p: RGB) => p.b > 150 && p.r < 80 && p.g < 80;

/* ═══════════════════════ sources built to be measurable ═══════════════════════ */

async function lavfi(out: string, filter: string, seconds = 3): Promise<string> {
  await execFileAsync(FFMPEG, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `${filter}:d=${seconds}:r=24`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "12", out,
  ]);
  return out;
}

/** A frame that is red on the LEFT half and blue on the RIGHT half. Crops become unambiguous. */
async function splitSource(out: string, seconds = 3): Promise<string> {
  await execFileAsync(FFMPEG, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `color=c=red:s=320x360:d=${seconds}:r=24`,
    "-f", "lavfi", "-i", `color=c=blue:s=320x360:d=${seconds}:r=24`,
    "-filter_complex", "[0:v][1:v]hstack=inputs=2[v]",
    "-map", "[v]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "12", out,
  ]);
  return out;
}

/* ═══════════════════════ timelines ═══════════════════════ */

function clip(over: Partial<TimelineVideoClip> & { id: string }): TimelineVideoClip {
  return {
    kind: "video",
    source: { provider: "pexels", providerAssetId: over.id },
    sourceIn: 0,
    sourceOut: 2,
    timelineStart: 0,
    timelineEnd: 2,
    motion: "none",
    transitionIn: "hard_cut",
    transitionOut: "hard_cut",
    ...over,
  } as TimelineVideoClip;
}

function timelineOf(
  clips: TimelineVideoClip[],
  fmt: { widthPx: number; heightPx: number; fps?: number },
  look?: ProjectTimeline["look"]
): ProjectTimeline {
  const t = emptyTimeline(1, { widthPx: fmt.widthPx, heightPx: fmt.heightPx, fps: fmt.fps ?? 24 });
  t.durationSec = Math.max(...clips.map((c) => c.timelineEnd));
  if (look) t.look = look;
  const track = t.tracks.find((x) => x.kind === "VIDEO");
  if (track?.kind !== "VIDEO") throw new Error("no VIDEO track");
  track.clips.push(...clips);
  return t;
}

describe("R160 §8 — real edits, measured in real pixels", () => {
  let dir: string;
  let red: string;
  let blue: string;
  let grey: string;
  let split: string;
  let n = 0;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "r160-edit-"));
    red = await lavfi(path.join(dir, "red.mp4"), "color=c=red:s=640x360");
    blue = await lavfi(path.join(dir, "blue.mp4"), "color=c=blue:s=640x360");
    /** Mid grey: a grade that warms or cools it moves R and B in opposite directions, visibly. */
    grey = await lavfi(path.join(dir, "grey.mp4"), "color=c=0x808080:s=640x360");
    split = await splitSource(path.join(dir, "split.mp4"));
  }, 300_000);

  afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Render a timeline, mapping every clip to the same file unless the test says otherwise. */
  async function render(
    timeline: ProjectTimeline,
    media: string | ((c: TimelineVideoClip) => string)
  ): Promise<string> {
    const id = `out${n++}`;
    const outputPath = path.join(dir, `${id}.mp4`);
    const result = await renderTimeline({
      timeline,
      workDir: path.join(dir, id),
      outputPath,
      resolveMedia: async (c) => (typeof media === "string" ? media : media(c)),
    });
    expect(result.outputPath, "the render produced no file").toBe(outputPath);
    expect(fs.existsSync(outputPath)).toBe(true);
    return outputPath;
  }

  const frame = async (video: string, atSec: number) =>
    frameAt(video, atSec, path.join(dir, `f${n++}.raw`));

  /* ── aspect ratio ─────────────────────────────────────────────────────────────────────── */

  it("renders each format at exactly the resolution the timeline asks for", async () => {
    for (const fmt of [
      { widthPx: 640, heightPx: 360 },
      { widthPx: 360, heightPx: 640 },
      { widthPx: 480, heightPx: 480 },
    ]) {
      const out = await render(timelineOf([clip({ id: "c1" })], fmt), red);
      const { stdout } = await execFileAsync("ffprobe", [
        "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", out,
      ]);
      expect(stdout.trim(), `${fmt.widthPx}x${fmt.heightPx}`).toBe(`${fmt.widthPx}x${fmt.heightPx}`);
    }
  }, 300_000);

  /* ── fit ──────────────────────────────────────────────────────────────────────────────── */

  /**
   * `contain` is the default and the promise the pipeline makes about photos: nothing is cropped.
   * A 16:9 source in a 1:1 frame must therefore be letterboxed — black at the top, red across the
   * middle. If the renderer silently switched to cover, the top would be red too.
   */
  it("contain pads rather than crops — the bars are really black", async () => {
    const out = await render(
      timelineOf([clip({ id: "c1", transform: { fit: "contain" } })], { widthPx: 480, heightPx: 480 }),
      red
    );
    const f = await frame(out, 1);
    expect(isBlack(pixelAt(f, 0.5, 0.03)), "the top bar is not black").toBe(true);
    expect(isBlack(pixelAt(f, 0.5, 0.97)), "the bottom bar is not black").toBe(true);
    expect(isRed(pixelAt(f, 0.5, 0.5)), "the picture is missing from the middle").toBe(true);
  }, 300_000);

  /** `cover` is the opposite promise: the frame is filled and the overflow is lost. No bars. */
  it("cover fills the frame — there are no bars at all", async () => {
    const out = await render(
      timelineOf([clip({ id: "c1", transform: { fit: "cover" } })], { widthPx: 480, heightPx: 480 }),
      red
    );
    const f = await frame(out, 1);
    for (const [nx, ny] of [[0.5, 0.03], [0.5, 0.97], [0.03, 0.5], [0.97, 0.5], [0.5, 0.5]] as const) {
      expect(isRed(pixelAt(f, nx, ny)), `not filled at ${nx},${ny}`).toBe(true);
    }
  }, 300_000);

  /**
   * A crop of the LEFT half of a red|blue source must be entirely red. This is the test that
   * distinguishes a crop that ran from one that was dropped: without it the frame would still
   * contain blue on the right, and every filter-string assertion would still pass.
   */
  it("crop takes the rectangle it was given, and only that rectangle", async () => {
    const out = await render(
      timelineOf(
        [clip({ id: "c1", transform: { fit: "crop", crop: { x: 0, y: 0, width: 0.5, height: 1 } } })],
        { widthPx: 320, heightPx: 360 }
      ),
      split
    );
    const f = await frame(out, 1);
    for (const nx of [0.05, 0.5, 0.95]) {
      expect(isRed(pixelAt(f, nx, 0.5)), `blue survived the crop at x=${nx}`).toBe(true);
    }
  }, 300_000);

  it("cropping the OTHER half gives the other colour — the rectangle is really read", async () => {
    const out = await render(
      timelineOf(
        [clip({ id: "c1", transform: { fit: "crop", crop: { x: 0.5, y: 0, width: 0.5, height: 1 } } })],
        { widthPx: 320, heightPx: 360 }
      ),
      split
    );
    const f = await frame(out, 1);
    for (const nx of [0.05, 0.5, 0.95]) {
      expect(isBlue(pixelAt(f, nx, 0.5)), `red survived the crop at x=${nx}`).toBe(true);
    }
  }, 300_000);

  /* ── scale and position ───────────────────────────────────────────────────────────────── */

  /**
   * A half-scale picture pushed into the top-left corner. The measurement is the CONTRAST between
   * two corners: ink where the picture was sent, black where it was not. A scale that ran but a
   * position that did not would put the picture in the middle and fail the second half.
   *
   * ── The bug this found ─────────────────────────────────────────────────────────────────────
   *
   * Scaling DOWN did not produce a small picture — it produced no render at all. The chain scaled
   * the frame to half size and then asked ffmpeg to `crop` the full frame size out of it, which
   * ffmpeg refuses ("Invalid too big or non positive size"). The clip failed to encode and a
   * one-clip timeline threw MISSING_MEDIA. `positionX`/`positionY` were separately ignored: only
   * the cover chain read them, so a scaled clip was always centred whatever the editor asked.
   */
  it("scale and position put the picture where the editor asked", async () => {
    const out = await render(
      timelineOf(
        [clip({ id: "c1", transform: { fit: "contain", scale: 0.5, positionX: 0.25, positionY: 0.25 } })],
        { widthPx: 480, heightPx: 480 }
      ),
      red
    );
    const f = await frame(out, 1);
    expect(isRed(pixelAt(f, 0.25, 0.25)), "nothing was drawn at the requested position").toBe(true);
    expect(isBlack(pixelAt(f, 0.9, 0.9)), "the picture was not moved — the far corner still has it").toBe(true);
  }, 300_000);

  /** Scaling UP fills the frame — the other direction of the same control, and the one that always worked. */
  it("scaling up fills the frame rather than leaving bars", async () => {
    const out = await render(
      timelineOf(
        [clip({ id: "c1", transform: { fit: "contain", scale: 1.8 } })],
        { widthPx: 480, heightPx: 480 }
      ),
      red
    );
    const f = await frame(out, 1);
    for (const ny of [0.1, 0.5, 0.9]) {
      expect(isRed(pixelAt(f, 0.5, ny)), `bars survived a 1.8x scale at y=${ny}`).toBe(true);
    }
  }, 300_000);

  /** Every scale in the editor's range must at least RENDER. The 0.5 case used to throw. */
  it("every scale the editor can set produces a video", async () => {
    for (const scale of [0.25, 0.5, 0.75, 1.5, 3]) {
      const out = await render(
        timelineOf([clip({ id: "c1", transform: { fit: "contain", scale } })], { widthPx: 320, heightPx: 180 }),
        red
      );
      expect(fs.statSync(out).size, `scale=${scale} produced nothing`).toBeGreaterThan(1024);
    }
  }, 600_000);

  /**
   * Opacity is composited over black, so half-opacity red must read as roughly half-brightness red.
   * Measured as a mean so encoding noise cannot decide the result.
   *
   * This is the assertion that found the bug: the old chain set an alpha channel and then converted
   * to a format without one, which discards the alpha instead of compositing with it. A clip at
   * opacity 0.5 rendered at full brightness — measured 250 where 127 was correct — and the filter
   * string contained `colorchannelmixer=aa=0.5000` throughout, so every existing test passed.
   */
  it("opacity really dims the picture, by about the amount asked for", async () => {
    const full = await render(timelineOf([clip({ id: "c1" })], { widthPx: 320, heightPx: 180 }), red);
    const half = await render(
      timelineOf([clip({ id: "c1", transform: { opacity: 0.5 } })], { widthPx: 320, heightPx: 180 }),
      red
    );
    const a = meanColour(await frame(full, 1));
    const b = meanColour(await frame(half, 1));
    expect(b.r).toBeLessThan(a.r * 0.75);
    expect(b.r).toBeGreaterThan(a.r * 0.25);
  }, 300_000);

  /* ── camera ───────────────────────────────────────────────────────────────────────────── */

  /**
   * A Ken Burns zoom-in, measured as "the picture got bigger".
   *
   * The source is red inside a 1:1 frame with `contain`, so it is letterboxed and only part of the
   * frame is red at the start. A zoom that runs enlarges the picture and turns more of the frame
   * red; a zoom that is planned and not executed leaves the count identical. A frame count is the
   * one measurement that cannot be satisfied by a filter that merely appears in the chain.
   */
  it("a camera zoom actually changes the frame over time", async () => {
    const out = await render(
      timelineOf(
        [
          clip({
            id: "c1",
            timelineEnd: 3,
            sourceOut: 3,
            transform: { fit: "contain" },
            motion: "zoom_in",
            camera: { type: "push_in", startScale: 1, endScale: 1.6, intensity: 1 },
          }),
        ],
        { widthPx: 360, heightPx: 360 }
      ),
      red
    );
    const start = countNear(await frame(out, 0.15), { r: 237, g: 28, b: 36 }, 70);
    const end = countNear(await frame(out, 2.6), { r: 237, g: 28, b: 36 }, 70);
    expect(start, "the source is not visible at all at the start").toBeGreaterThan(0);
    expect(end, "the picture did not grow — the camera move did not run").toBeGreaterThan(start * 1.1);
  }, 300_000);

  /* ── the look ─────────────────────────────────────────────────────────────────────────── */

  /**
   * Warm and cold, on the same grey source, in the same renderer.
   *
   * This is the measurement the R160 §1 audit was missing: `translateEdl` was not setting
   * `timeline.look` at all, so every cinematically planned video came out ungraded — and every
   * existing test passed, because they all checked the filter string produced from a look that was
   * passed in directly rather than the look the timeline actually carried.
   */
  it("warm and cold move the picture in OPPOSITE directions from the same source", async () => {
    const fmt = { widthPx: 320, heightPx: 180 };
    const graded = async (look?: ProjectTimeline["look"]) =>
      meanColour(await frame(await render(timelineOf([clip({ id: "c1" })], fmt, look), grey), 1));

    /**
     * ── What the baseline has to be, and why it is not untouched grey ──────────────────────────
     *
     * `LOOK_MODIFIERS` are applied ON TOP of the documentary calibration, and that calibration is
     * not colour-neutral: measured on mid-grey it lands at r=94.6 b=100.0, so its own warm/cool
     * balance is -5.4. Comparing `warm` against untouched grey would therefore be measuring the
     * calibration and the modifier together and calling the total "the warm look".
     *
     * So the baseline is `documentary` — the calibration alone — and the question each look is
     * asked is the right one: which way did YOUR modifier move the picture from there.
     */
    const base = await graded({ grade: "documentary" });
    const warm = await graded({ grade: "warm" });
    const cold = await graded({ grade: "cold" });

    const balance = (c: { r: number; b: number }) => c.r - c.b;
    expect(balance(warm) - balance(base), "the warm look did not warm the picture").toBeGreaterThan(5);
    expect(balance(base) - balance(cold), "the cold look did not cool the picture").toBeGreaterThan(5);
    /** And they are on opposite sides of it, which a single-sided threshold would not prove. */
    expect(balance(warm)).toBeGreaterThan(balance(cold));
  }, 600_000);

  /**
   * The renderer adds no tint of its own. Measured exactly: mid-grey in, mid-grey out, to the
   * value. This is what makes the grade measurements above mean something.
   */
  it("a timeline with no look leaves mid-grey exactly neutral", async () => {
    const m = meanColour(
      await frame(await render(timelineOf([clip({ id: "c1" })], { widthPx: 320, heightPx: 180 }), grey), 1)
    );
    expect(Math.abs(m.r - m.b)).toBeLessThan(1);
    expect(Math.abs(m.g - 128)).toBeLessThan(2);
  }, 300_000);

  /** `grade: "none"` must leave the pixels alone — a look nobody asked for is a bug, not a default. */
  it("grade none leaves the picture untouched", async () => {
    const fmt = { widthPx: 320, heightPx: 180 };
    const a = meanColour(await frame(await render(timelineOf([clip({ id: "c1" })], fmt), grey), 1));
    const b = meanColour(
      await frame(await render(timelineOf([clip({ id: "c1" })], fmt, { grade: "none" }), grey), 1)
    );
    expect(Math.abs(a.r - b.r)).toBeLessThan(3);
    expect(Math.abs(a.b - b.b)).toBeLessThan(3);
  }, 300_000);

  /* ── effects ──────────────────────────────────────────────────────────────────────────── */

  /**
   * A vignette darkens the corners and leaves the middle alone. On a flat grey source that is the
   * whole definition, and it is measurable to the count.
   */
  it("a vignette really darkens the corners relative to the centre", async () => {
    const out = await render(
      timelineOf(
        [clip({ id: "c1", effects: [{ effectType: "vignette", intensity: 0.9 }] })],
        { widthPx: 320, heightPx: 180 }
      ),
      grey
    );
    const f = await frame(out, 1);
    const centre = pixelAt(f, 0.5, 0.5);
    const corner = pixelAt(f, 0.02, 0.02);
    expect(corner.r, "the corner is not darker than the centre").toBeLessThan(centre.r - 20);
  }, 300_000);

  /** Letterbox draws real black bars over the picture, top and bottom. */
  it("letterbox puts black bars over the picture", async () => {
    const out = await render(
      timelineOf(
        [clip({ id: "c1", transform: { fit: "cover" }, effects: [{ effectType: "letterbox", intensity: 0.8 }] })],
        { widthPx: 320, heightPx: 180 }
      ),
      red
    );
    const f = await frame(out, 1);
    expect(isBlack(pixelAt(f, 0.5, 0.01)), "no bar at the top").toBe(true);
    expect(isBlack(pixelAt(f, 0.5, 0.99)), "no bar at the bottom").toBe(true);
    expect(isRed(pixelAt(f, 0.5, 0.5)), "the bars covered the whole picture").toBe(true);
  }, 300_000);

  /* ── transitions ──────────────────────────────────────────────────────────────────────── */

  /**
   * The difference between a dissolve and a cut, stated as the thing a viewer sees: during a
   * dissolve there is a moment when BOTH pictures are on screen at once. A cut has no such moment.
   *
   * Both timelines are otherwise identical, so the only thing that can produce the mixed frame is
   * the transition itself.
   *
   * ── Where the transition actually sits ─────────────────────────────────────────────────────
   *
   * `xfade` OVERLAPS the two clips rather than inserting time between them, so a one-second
   * transition on a clip starting at 2s runs from 1.0s to 2.0s and the finished video is one
   * second SHORTER than the sum of its clips. Measured on a real render: red is untouched to 1.0,
   * the blend runs 1.0→2.0, and blue is pure from 2.0 on, with a 3-second output for 4 seconds of
   * clips. So the mixed frame is at 1.5, not at 2.0.
   */
  it("a dissolve produces a frame that is genuinely both clips at once", async () => {
    const twoClips = (transitionIn: string) => [
      clip({ id: "a", timelineStart: 0, timelineEnd: 2, sourceIn: 0, sourceOut: 2 }),
      clip({
        id: "b",
        timelineStart: 2,
        timelineEnd: 4,
        sourceIn: 0,
        sourceOut: 2,
        transitionIn: transitionIn as never,
        transitionInSec: 1,
      }),
    ];
    const media = (c: TimelineVideoClip) => (c.id === "a" ? red : blue);

    const dissolve = await render(
      timelineOf(twoClips("crossfade"), { widthPx: 320, heightPx: 180 }),
      media
    );
    const cut = await render(timelineOf(twoClips("hard_cut"), { widthPx: 320, heightPx: 180 }), media);

    /** Mid-transition: red is fading out while blue fades in, so neither is pure. */
    const blended = meanColour(await frame(dissolve, 1.5));
    expect(blended.r, "no red left mid-dissolve").toBeGreaterThan(25);
    expect(blended.b, "no blue yet mid-dissolve").toBeGreaterThan(25);

    /**
     * The control, taken at the instant the SAME cut timeline is at its own join. A hard cut is one
     * picture or the other and never a mixture — if this frame were blended too, the test above
     * would be measuring the encoder rather than the transition.
     */
    const hard = meanColour(await frame(cut, 2.0));
    expect(Math.min(hard.r, hard.b), "a hard cut blended the two clips").toBeLessThan(25);

    /**
     * ── RONDE 184 changed what this pair of lines asserts, and why ────────────────────────────
     *
     * They used to read: the cut is 4s and the dissolve is 3s, "the overlap is real time". That was
     * a true measurement of a DEFECT. Nothing rendered the handle a crossfade needs, so the fade
     * consumed a second of the programme — and R182 measured the same fault at scale: a 12.00s plan
     * rendering as a 10.70s file, with the picture ending before the narration.
     *
     * A transition is an overlap of MATERIAL, not a deletion of screen time. The incoming clip now
     * carries a pre-roll handle for the fade to consume, so both timelines are 4 seconds long — and
     * that equality is the stronger claim, because a dissolve that silently fell back to a cut
     * would now be caught by the blended-frame assertions above rather than by a duration that
     * happened to differ.
     */
    const durationOf = async (v: string) => {
      const { stdout } = await execFileAsync("ffprobe", [
        "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", v,
      ]);
      return Number(stdout.trim());
    };
    expect(await durationOf(cut)).toBeCloseTo(4, 1);
    expect(
      await durationOf(dissolve),
      "the dissolve ate screen time instead of overlapping material"
    ).toBeCloseTo(4, 1);
  }, 600_000);

  /** Both clips must still be intact away from the transition — a dissolve is not a global fade. */
  it("a dissolve leaves the clips themselves alone outside its window", async () => {
    const out = await render(
      timelineOf(
        [
          clip({ id: "a", timelineStart: 0, timelineEnd: 2, sourceIn: 0, sourceOut: 2 }),
          clip({
            id: "b",
            timelineStart: 2,
            timelineEnd: 4,
            sourceIn: 0,
            sourceOut: 2,
            transitionIn: "crossfade",
            transitionInSec: 0.5,
          }),
        ],
        { widthPx: 320, heightPx: 180 }
      ),
      (c) => (c.id === "a" ? red : blue)
    );
    expect(isRed(pixelAt(await frame(out, 0.5), 0.5, 0.5)), "the first clip is not itself").toBe(true);
    expect(isBlue(pixelAt(await frame(out, 3.4), 0.5, 0.5)), "the second clip is not itself").toBe(true);
  }, 300_000);

  /* ── trim ─────────────────────────────────────────────────────────────────────────────── */

  /**
   * §7's rule made visible: `sourceIn`/`sourceOut` must select a WINDOW OF THE SOURCE, not just
   * shorten the output. The source is red for its first second and blue after, so a clip trimmed
   * to start at 1.5s must be blue from its very first frame.
   */
  it("sourceIn seeks into the source rather than only shortening the clip", async () => {
    const twoTone = path.join(dir, "twotone.mp4");
    await execFileAsync(FFMPEG, [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=red:s=320x180:d=1:r=24",
      "-f", "lavfi", "-i", "color=c=blue:s=320x180:d=2:r=24",
      "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]",
      "-map", "[v]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "6", twoTone,
    ]);

    const out = await render(
      timelineOf(
        [clip({ id: "c1", sourceIn: 1.5, sourceOut: 2.5, timelineStart: 0, timelineEnd: 1 })],
        { widthPx: 320, heightPx: 180 }
      ),
      twoTone
    );
    expect(isBlue(pixelAt(await frame(out, 0.2), 0.5, 0.5)), "the trim did not seek into the source").toBe(true);
  }, 300_000);
});
