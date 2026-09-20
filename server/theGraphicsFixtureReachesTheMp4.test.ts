/**
 * GRAPHICS §17 — A DETERMINISTIC FIXTURE, CARRIED ALL THE WAY TO THE DELIVERED MP4.
 *
 * ── What was already proven, and what was not ───────────────────────────────────────────────
 *
 * `graphicsPlannerToPixels` renders the planner's own payloads and reads the ALPHA PLANE of the
 * overlay back: it proves the components draw. `ronde150HybridRender` composites one lower third
 * onto an ffmpeg picture and reads one corner pixel: it proves the alpha channel survives the
 * composite. Both stop one step short of the question this round asks.
 *
 * Neither reads the FINISHED FILE and asks WHEN and WHERE. An overlay whose graphics were all
 * drawn at t=0, or all drawn on top of each other, or drawn a frame long and gone, passes every
 * existing check: the alpha plane has ink, the corner is still red, the counts are right.
 *
 * It is not a hypothetical. Writing this file found three defects in one beat, and all three were
 * invisible to every existing assertion — see `ANCHOR_GEOMETRY` in `captionLayout.ts`, the
 * `lower_third` branch of `graphicBoxSize`, and the cap in `maxCharsPerLine`. What they had in
 * common is the shape this file is built to catch: the layout engine's MODEL of the frame and the
 * pixels the browser actually drew had drifted apart, and nothing compared the two.
 *
 * ── Why a flat red picture ──────────────────────────────────────────────────────────────────
 *
 * Every pixel of the source is (255,0,0), so in the finished frame "not red" means exactly one
 * thing: the graphics layer put something there. No decoding of glyph shapes, no template
 * matching, no tolerance for what a card looks like — the measurement is where the film stopped
 * showing through, which is the only question compositing actually answers.
 *
 * ── Why three renders ───────────────────────────────────────────────────────────────────────
 *
 * Graphics alone, caption alone, and both. Two elements drawn in one frame cannot be told apart by
 * colour, but each one's AREA can be measured on its own — and area does not change when the
 * collision engine moves something. So §10's "no overlap" becomes arithmetic that holds wherever
 * the engine put them: two things that cover 100px each and 200px together are disjoint, and any
 * shortfall is exactly the number of pixels where one is drawn over the other.
 *
 * ── 1920×1080, because §7 says so and because it is the size that ships ─────────────────────
 *
 * The anchors are fractions of the frame, so a preview-sized frame is a different layout problem,
 * not a cheaper version of the same one: a 46px caption is 4% of a 1080p frame and 13% of a 360p
 * one, and the second genuinely has nowhere to put a caption that clears a lower third. That case
 * has its own test at the bottom, which asserts the engine REPORTS it rather than drawing one over
 * the other in silence.
 *
 * ── Deliberately topic-agnostic ─────────────────────────────────────────────────────────────
 *
 * The fixture names a mathematician, a year, a city and a count. Nothing in the graphics chain
 * reads any of them — they are here because a card with no words has nothing to draw, and using
 * four unrelated subjects is the cheapest way to keep a subject-specific shortcut from hiding in
 * a green test.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_CAPTION_STYLE, emptyTimeline, type ProjectTimeline } from "./projectTimeline";
import { productionGraphicsOverlay } from "./graphicsOverlayDeps";
import { renderTimeline, type RenderedTimeline } from "./timelineRenderer";
import { resolveRemotionBrowser } from "./remotionRenderer";
import { timelineToRemotionProps } from "./remotionProps";
import { resolveFFmpegBin } from "./ffmpegBinary";

const execFileAsync = promisify(execFile);

const WIDTH = 1920;
const HEIGHT = 1080;
/** Low, because the question is WHICH FRAME shows what — not how smooth the motion is. */
const FPS = 12;
const SLOT_SEC = 1;

/**
 * Four graphics, then a fifth slot with nothing in it.
 *
 * The empty slot is not padding. It is the only place a "duration is ignored" defect can show
 * itself: a renderer that draws every graphic for the whole timeline satisfies all four ink
 * assertions and fails only here.
 */
const SLOTS: ReadonlyArray<{
  label: string;
  graphic: Record<string, unknown> | null;
}> = [
  {
    label: "lower_third",
    graphic: {
      id: "gfx-lower-third",
      graphicType: "lower_third",
      label: "Ada Lovelace",
      data: { role: "Mathematician" },
      start: 0,
      end: SLOT_SEC,
    },
  },
  {
    label: "date_card",
    graphic: {
      id: "gfx-date-card",
      graphicType: "date_card",
      label: "1843",
      data: { date: "1843" },
      start: SLOT_SEC,
      end: 2 * SLOT_SEC,
    },
  },
  {
    label: "location_card",
    graphic: {
      id: "gfx-location-card",
      graphicType: "location_card",
      label: "London",
      data: { place: "London" },
      start: 2 * SLOT_SEC,
      end: 3 * SLOT_SEC,
    },
  },
  {
    label: "counter",
    graphic: {
      id: "gfx-counter",
      graphicType: "counter",
      label: "Engines built",
      data: { value: 2, label: "Engines built" },
      start: 3 * SLOT_SEC,
      end: 4 * SLOT_SEC,
    },
  },
  { label: "nothing at all", graphic: null },
];

const GRAPHIC_SLOTS = SLOTS.map((s, i) => ({ ...s, index: i })).filter((s) => s.graphic);
const EMPTY_SLOT = SLOTS.findIndex((s) => !s.graphic);
const DURATION_SEC = SLOTS.length * SLOT_SEC;
const midOf = (slot: number) => slot * SLOT_SEC + SLOT_SEC / 2;

/** Runs over the graphics slots and stops with them, so the empty slot really is empty. */
const CAPTION = {
  id: "cap-1",
  text: "She wrote the first algorithm.",
  start: 0.1,
  end: GRAPHIC_SLOTS.length * SLOT_SEC,
  style: DEFAULT_CAPTION_STYLE,
};

function fixtureTimeline(parts: { graphics: boolean; caption: boolean }): ProjectTimeline {
  const t = emptyTimeline(1, { widthPx: WIDTH, heightPx: HEIGHT, fps: FPS });
  t.durationSec = DURATION_SEC;
  for (const track of t.tracks) {
    if (track.kind === "GRAPHICS" && parts.graphics) {
      for (const slot of SLOTS) if (slot.graphic) track.graphics.push(slot.graphic as never);
    }
    if (track.kind === "CAPTIONS" && parts.caption) track.captions.push(CAPTION as never);
    if (track.kind === "VIDEO") {
      track.clips.push({
        id: "clip-1",
        kind: "video",
        source: { provider: "pexels", providerAssetId: "fixture" },
        sourceIn: 0,
        sourceOut: DURATION_SEC,
        timelineStart: 0,
        timelineEnd: DURATION_SEC,
        motion: "none",
        transitionIn: "hard_cut",
        transitionOut: "hard_cut",
      } as never);
    }
  }
  return t;
}

/* ═══════════════════════ reading the delivered file ═══════════════════════ */

/**
 * Where the film stopped showing through.
 *
 * The source is (255,0,0) everywhere, so a generous definition of "still red" keeps x264's chroma
 * ringing on the red side of the line while anything a card draws — white text, a dark plate, a
 * rule — lands well outside it.
 */
function isRed(r: number, g: number, b: number): boolean {
  return r > 170 && g < 80 && b < 80;
}

type Mask = {
  count: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  /** Whether the very first pixel of the frame — the top-left corner — is still the film. */
  cornerIsFilm: boolean;
};

/** One frame of the FINISHED video, decoded from the start so the seek lands on a real picture. */
async function maskAt(videoPath: string, atSec: number, scratch: string): Promise<Mask> {
  await execFileAsync(resolveFFmpegBin(), [
    "-y", "-hide_banner", "-loglevel", "error",
    "-i", videoPath,
    /** Output seek: decodes from the start, so the frame is the frame at this timestamp. */
    "-ss", atSec.toFixed(3),
    "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", scratch,
  ]);
  const rgb = fs.readFileSync(scratch);
  const mask: Mask = {
    count: 0,
    minX: WIDTH,
    maxX: -1,
    minY: HEIGHT,
    maxY: -1,
    cornerIsFilm: isRed(rgb[0]!, rgb[1]!, rgb[2]!),
  };
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const i = (y * WIDTH + x) * 3;
      if (isRed(rgb[i]!, rgb[i + 1]!, rgb[i + 2]!)) continue;
      mask.count++;
      if (x < mask.minX) mask.minX = x;
      if (x > mask.maxX) mask.maxX = x;
      if (y < mask.minY) mask.minY = y;
      if (y > mask.maxY) mask.maxY = y;
    }
  }
  return mask;
}

const TOTAL_PIXELS = WIDTH * HEIGHT;

/**
 * How much stray ink a frame is allowed before it counts as "something was drawn here".
 *
 * Encoding a flat colour twice does not produce stray pixels in any meaningful number; this is a
 * floor against ringing at the frame border, not a tolerance for a faint graphic.
 */
const STRAY_PIXELS = Math.round(TOTAL_PIXELS * 0.0005);

const browser = resolveRemotionBrowser();
const describeRender = browser ? describe : describe.skip;

describeRender("GRAPHICS §17 — the fixture is visible in the delivered MP4, at the right time", () => {
  let workDir = "";
  let outputPath = "";
  let result: RenderedTimeline;
  let withCaptionResult: RenderedTimeline;
  /** The graphic alone, per slot. Every pixel here was put there by a graphic. */
  const graphicMask: Mask[] = [];
  /** The caption alone, at the same instants. */
  const captionMask: Mask[] = [];
  /** Both together — the film as it would be delivered. */
  const combinedMask: Mask[] = [];

  beforeAll(async () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "gfx-fixture-"));
    const sourceClip = path.join(workDir, "source.mp4");
    await execFileAsync(resolveFFmpegBin(), [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", `color=c=red:s=${WIDTH}x${HEIGHT}:d=${DURATION_SEC}:r=${FPS}`,
      "-c:v", "libx264", "-pix_fmt", "yuv420p", sourceClip,
    ]);
    /** Bundled once; the three renders share it, as a worker's three renders do. */
    const bundleCache = path.join(workDir, "bundle");

    /**
     * THE PRODUCTION WIRE, not a test double. `productionGraphicsOverlay` is the same function
     * `worker.ts` hands to `renderTimeline`; building the overlay some other way here would prove
     * a route no delivered video takes.
     */
    async function render(name: string, parts: { graphics: boolean; caption: boolean }) {
      const renderDir = path.join(workDir, name);
      fs.mkdirSync(renderDir, { recursive: true });
      const out = path.join(workDir, `${name}.mp4`);
      const r = await renderTimeline({
        timeline: fixtureTimeline(parts),
        workDir: renderDir,
        outputPath: out,
        resolveMedia: async () => sourceClip,
        graphicsOverlay: productionGraphicsOverlay({ workDir: renderDir, cacheDir: bundleCache }),
      });
      return { result: r, out };
    }

    const graphicsOnly = await render("graphics-only", { graphics: true, caption: false });
    result = graphicsOnly.result;
    outputPath = graphicsOnly.out;
    const captionOnly = await render("caption-only", { graphics: false, caption: true });
    const combined = await render("combined", { graphics: true, caption: true });
    withCaptionResult = combined.result;

    for (let i = 0; i < SLOTS.length; i++) {
      graphicMask.push(await maskAt(outputPath, midOf(i), path.join(workDir, `g${i}.raw`)));
      captionMask.push(await maskAt(captionOnly.out, midOf(i), path.join(workDir, `c${i}.raw`)));
      combinedMask.push(await maskAt(combined.out, midOf(i), path.join(workDir, `b${i}.raw`)));
    }
  }, 1_800_000);

  afterAll(() => {
    if (workDir) {
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch {
        /* a leftover temp dir is not a test failure */
      }
    }
  });

  /* ── the render itself ── */

  it("delivered one file, through the Remotion overlay route, refusing nothing", () => {
    expect(fs.existsSync(outputPath)).toBe(true);
    expect(result.graphicsRenderer).toBe("remotion");
    /**
     * Not "no errors": `skipped` is where this renderer files a graphic it could not draw, and an
     * empty list is the claim that all four were drawable. §20 — a skipped graphic is a failure
     * to report, never a line to filter out.
     */
    expect(result.skipped, `skipped: ${result.skipped.join(" | ")}`).toEqual([]);
  });

  it("names the four graphics it was given and the four it drew — by id, not by count", () => {
    const planned = GRAPHIC_SLOTS.map((s) => (s.graphic as { id: string }).id);
    expect(result.graphicRenderIds).not.toBeNull();
    expect([...result.graphicRenderIds!.input].sort()).toEqual([...planned].sort());
    expect([...result.graphicRenderIds!.drawn].sort()).toEqual([...planned].sort());
  });

  it("measured real ink in the overlay rather than assuming it", () => {
    expect(result.graphicsOverlayInk).not.toBeNull();
    expect(result.graphicsOverlayInk!.status).toBe("ink");
  });

  it("is as long as the timeline asked for", async () => {
    /**
     * Counted by DECODING, not read out of the container header.
     *
     * A header can say five seconds while the file holds four; decoding every frame and counting
     * them is the measurement that cannot be wrong about it. It also needs only the binary the
     * renderer itself resolves — `ffprobe` is a second dependency this assertion does not need.
     */
    const { stderr } = await execFileAsync(resolveFFmpegBin(), [
      "-hide_banner", "-i", outputPath, "-f", "null", "-",
    ]);
    const frames = [...stderr.matchAll(/frame=\s*(\d+)/g)].map((m) => Number(m[1]));
    expect(frames.length, `ffmpeg reported no frame count:\n${stderr.slice(-400)}`)
      .toBeGreaterThan(0);
    expect(frames[frames.length - 1]).toBe(DURATION_SEC * FPS);
  });

  /* ── §17 timing: the right graphic, in its own slot ── */

  it("EVERY GRAPHIC SLOT HAS INK IN THE DELIVERED FILE", () => {
    const report: string[] = [];
    const blank: string[] = [];
    for (const slot of GRAPHIC_SLOTS) {
      const mask = graphicMask[slot.index]!;
      report.push(`${slot.label}: ${mask.count}px`);
      if (mask.count < STRAY_PIXELS) blank.push(slot.label);
    }
    expect(blank, `no ink in the finished frame — ${report.join(" | ")}`).toEqual([]);
  });

  it("THE EMPTY SLOT IS CLEAN — no graphic outlives its own end time", () => {
    expect(
      graphicMask[EMPTY_SLOT]!.count,
      `ink at ${midOf(EMPTY_SLOT)}s, where every graphic has ended`
    ).toBeLessThan(STRAY_PIXELS);
  });

  it("the slots differ from one another — four graphics, not one drawn four times", () => {
    /**
     * A renderer that ignored `start`/`end` and drew the first graphic throughout would satisfy
     * every ink assertion above. Four cards with different words cover different areas, so the
     * counts must not all coincide.
     */
    const counts = GRAPHIC_SLOTS.map((s) => graphicMask[s.index]!.count);
    expect(new Set(counts).size, `identical ink in every slot: ${counts.join(", ")}`).toBe(
      counts.length
    );
  });

  /* ── §6 z-order and alpha ── */

  it("THE GRAPHICS ARE IN FRONT OF THE PICTURE, AND THE PICTURE IS STILL THERE", () => {
    for (const slot of GRAPHIC_SLOTS) {
      const mask = graphicMask[slot.index]!;
      /**
       * Two failures at once, and they are opposite. Ink at all means the overlay was composited
       * OVER the picture — under it, the frame would be uniformly red. Ink well short of the whole
       * frame means the alpha channel survived — without it, the overlay is an opaque rectangle
       * and the frame is uniformly black.
       */
      expect(mask.count, `${slot.label}: the overlay left no mark`).toBeGreaterThan(STRAY_PIXELS);
      expect(
        mask.count / TOTAL_PIXELS,
        `${slot.label}: the overlay covered the whole frame — alpha lost`
      ).toBeLessThan(0.5);
    }
  });

  it("the top-left corner is still the film, in every slot", () => {
    /** The one region no card in this fixture occupies. Unmarked there means the film shows. */
    for (let i = 0; i < SLOTS.length; i++) {
      expect(combinedMask[i]!.cornerIsFilm, `slot ${i}: the corner is not the film any more`)
        .toBe(true);
    }
  });

  /* ── §7 position and safe areas ── */

  it("NOTHING IS DRAWN OFF THE EDGE OF THE FRAME", () => {
    const offEdge: string[] = [];
    for (const slot of GRAPHIC_SLOTS) {
      const m = graphicMask[slot.index]!;
      /**
       * Ink touching the outermost row or column means the graphic was clipped by the frame — the
       * part of it beyond that edge is in no delivered video. A card laid out inside a safe margin
       * never reaches it.
       */
      if (m.minX <= 0 || m.maxX >= WIDTH - 1 || m.minY <= 0 || m.maxY >= HEIGHT - 1) {
        offEdge.push(`${slot.label}: x ${m.minX}..${m.maxX} y ${m.minY}..${m.maxY}`);
      }
    }
    expect(offEdge, `clipped by the frame — ${offEdge.join(" | ")}`).toEqual([]);
  });

  it("THE LOWER THIRD IS DRAWN WHERE THE LAYOUT ENGINE SAYS IT IS", () => {
    /**
     * The defect this round found, stated as the measurement that found it.
     *
     * `boxForPosition` puts a lower third's bottom edge at 78% of the frame height and the
     * collision engine places every caption against that number. The component used to draw it at
     * 22% of the frame WIDTH above the bottom — CSS resolves percentage padding against width —
     * which on this frame is 422px rather than 238px. Comparing the drawn bottom edge to the
     * anchor is the one assertion that can tell the two apart.
     */
    const lowerThird = graphicMask[0]!;
    const anchorBottom = HEIGHT * 0.78;
    expect(
      Math.abs(lowerThird.maxY - anchorBottom),
      `the lower third's bottom edge is at ${lowerThird.maxY}, the anchor is ${anchorBottom}`
    ).toBeLessThan(HEIGHT * 0.02);
    /** And its left edge is the anchor's 8% of the WIDTH, which was right all along. */
    expect(Math.abs(lowerThird.minX - WIDTH * 0.08)).toBeLessThan(WIDTH * 0.02);
  });

  /* ── §10 graphics and captions ── */

  it("THE CAPTION AND THE GRAPHIC SHARE NO PIXEL IN THE DELIVERED FRAME", () => {
    /**
     * ── Measured by AREA, because the caption is allowed to move ─────────────────────────────
     *
     * The first version of this compared the graphic's mask to the caption's mask from a render
     * with no graphics, and every bottom-anchored card failed it — correctly, in a sense: that IS
     * where the caption sits when nothing is in the way. But it is not where the caption sits in
     * the delivered film, because the collision engine moves it, and a test that insists the
     * caption never move would be forbidding the very mechanism §10 relies on.
     *
     * Moving a box does not change how many pixels it covers. So the two areas measured alone and
     * the area they cover together answer the question exactly, wherever the engine put them:
     *
     *     together == alone + alone   ⟹  disjoint
     *     together <  alone + alone   ⟹  they overlap, by the difference
     *
     * The few tenths of a percent allowed are antialiasing: the same glyphs land on a different
     * pixel grid after a move.
     */
    const overlaps: string[] = [];
    for (const slot of GRAPHIC_SLOTS) {
      const alone = graphicMask[slot.index]!.count + captionMask[slot.index]!.count;
      const together = combinedMask[slot.index]!.count;
      const shared = alone - together;
      if (shared > STRAY_PIXELS) {
        overlaps.push(
          `${slot.label}: ${shared}px struck through (graphic ${graphicMask[slot.index]!.count}` +
            ` + caption ${captionMask[slot.index]!.count} drew only ${together})`
        );
      }
    }
    expect(overlaps, `graphic and caption strike through each other — ${overlaps.join(" | ")}`)
      .toEqual([]);
  });

  it("and loses neither: both are still fully on screen once they share a frame", () => {
    /**
     * The other direction. A caption moved somewhere it does not fit, or clipped by the frame
     * edge after moving, would lose pixels — and the assertion above cannot see that, because
     * fewer caption pixels look exactly like less overlap.
     */
    for (const slot of GRAPHIC_SLOTS) {
      const alone = graphicMask[slot.index]!.count + captionMask[slot.index]!.count;
      const together = combinedMask[slot.index]!.count;
      expect(
        together / Math.max(1, alone),
        `${slot.label}: ${alone}px drawn separately, only ${together}px together`
      ).toBeGreaterThan(0.99);
      const m = combinedMask[slot.index]!;
      expect(m.minY, `${slot.label}: something is clipped by the top edge`).toBeGreaterThan(0);
      expect(m.maxY, `${slot.label}: something is clipped by the bottom edge`).toBeLessThan(
        HEIGHT - 1
      );
    }
  });

  it("nothing was refused or fell back when both tracks were drawn at once", () => {
    const report = withCaptionResult.skipped.join(" | ");
    expect(report, `skipped: ${report}`).not.toContain("unresolved");
    expect(report, `skipped: ${report}`).not.toContain("fell back to the libass route");
    expect(report, `skipped: ${report}`).not.toContain("unsupported_graphic");
  });

  it("the caption is drawn once, not by both routes", () => {
    /**
     * `graphicsRenderer` is the renderer's own statement of which route ran, and the two routes
     * draw the same captions. "remotion" here means libass did not also burn them in half a pixel
     * away — the failure that reads as a blurry double-strike rather than as an obvious bug.
     */
    expect(withCaptionResult.graphicsRenderer).toBe("remotion");
    expect(withCaptionResult.skipped.join(" ")).not.toContain("fell back to the libass route");
  });
}, 1_800_000);

/* ═══════════════════════ the frame with genuinely nowhere to put it ═══════════════════════ */

describe("GRAPHICS §20 — a caption that cannot be placed is REPORTED, not drawn in silence", () => {
  /**
   * A 46px caption is 4% of a 1080p frame and 13% of a 360p one, so on a small preview format a
   * two-line caption and a lower third really cannot both fit inside the safe area. That is a
   * legitimate "no", and the only wrong answer is the silent one.
   *
   * This is the state the three fixes left behind, and it is the state §20 asks for: the crowding
   * is still visible in a small preview, and the render now says so by name.
   */
  function propsFor(widthPx: number, heightPx: number) {
    const t = emptyTimeline(1, { widthPx, heightPx, fps: 12 });
    t.durationSec = 2;
    for (const track of t.tracks) {
      if (track.kind === "GRAPHICS") track.graphics.push(SLOTS[0]!.graphic as never);
      if (track.kind === "CAPTIONS") {
        track.captions.push({ ...CAPTION, start: 0, end: 2 } as never);
      }
    }
    return timelineToRemotionProps({ timeline: t });
  }

  it("names the caption and the graphic it could not clear", () => {
    const reported = propsFor(640, 360).unresolvedCollisions.join(" | ");
    expect(reported).toContain("caption_collision_unresolved");
    expect(reported, "the report does not say WHICH caption").toContain(CAPTION.id);
    expect(reported, "the report does not say what it overlaps").toContain("gfx-lower-third");
  });

  it("and says nothing at the size that ships, because there is nothing to say", () => {
    expect(propsFor(WIDTH, HEIGHT).unresolvedCollisions).toEqual([]);
  });
});

/* ═══════════════════════ §9 — the animation reaches the pixels ═══════════════════════ */

/**
 * GRAPHICS §9 — TWO CARDS, ONE DIFFERENCE, AND IT HAS TO BE VISIBLE.
 *
 * `theGraphicsLayerOrder` proves the timeline's `animation` reaches the props and the component's
 * call site. That is the wiring, and wiring is exactly what was missing — but it is not proof that
 * the value does anything once it arrives.
 *
 * The mutation that found this defect makes the point: replacing `animationAt(animation, …)` with
 * `animationAt("fade_rise", …)` inside `GraphicBody` leaves every prop assertion green. Only a
 * frame can tell the difference, so this renders the same card twice — identical words, identical
 * payload, identical position, one with `mask_reveal` — and reads both back.
 *
 * `mask_reveal` is chosen because it wipes the card open from the left, so early in its life it
 * ends further to the left than a card that is merely fading in. The assertion is that the two
 * frames differ, not by how much: how a reveal should look is a design decision and this file has
 * no opinion about it.
 */
describeRender("GRAPHICS §9 — a graphic's animation changes the frame it draws", () => {
  const W = 640;
  const H = 360;
  const ANIM_FPS = 24;
  let dir = "";
  let plain = { count: 0, maxX: -1 };
  let revealed = { count: 0, maxX: -1 };

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gfx-anim-"));
    const src = path.join(dir, "src.mp4");
    await execFileAsync(resolveFFmpegBin(), [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", `color=c=red:s=${W}x${H}:d=4:r=${ANIM_FPS}`,
      "-c:v", "libx264", "-pix_fmt", "yuv420p", src,
    ]);

    /** Same card in both slots; only slot 1 names an animation. */
    const t = emptyTimeline(1, { widthPx: W, heightPx: H, fps: ANIM_FPS });
    t.durationSec = 4;
    for (const track of t.tracks) {
      if (track.kind === "GRAPHICS") {
        track.graphics.push(
          { id: "plain", graphicType: "date_card", label: "1843", data: { date: "1843" },
            start: 0, end: 2 } as never,
          { id: "revealed", graphicType: "date_card", label: "1843", data: { date: "1843" },
            start: 2, end: 4, animation: "mask_reveal" } as never
        );
      }
      if (track.kind === "VIDEO") {
        track.clips.push({
          id: "c", kind: "video", source: { provider: "pexels", providerAssetId: "fixture" },
          sourceIn: 0, sourceOut: 4, timelineStart: 0, timelineEnd: 4,
          motion: "none", transitionIn: "hard_cut", transitionOut: "hard_cut",
        } as never);
      }
    }
    const renderDir = path.join(dir, "r");
    fs.mkdirSync(renderDir, { recursive: true });
    const out = path.join(dir, "anim.mp4");
    await renderTimeline({
      timeline: t,
      workDir: renderDir,
      outputPath: out,
      resolveMedia: async () => src,
      graphicsOverlay: productionGraphicsOverlay({ workDir: renderDir, cacheDir: path.join(dir, "b") }),
    });

    /**
     * THE SAME EARLY OFFSET INTO EACH CARD'S OWN WINDOW, while the entrance is still running.
     *
     * `transitionFrames` gives a 48-frame card an 8-frame entrance, so frame 3 is a third of the
     * way through it: `mask_reveal` has wiped about three quarters of the card open and
     * `fade_rise` has the whole card at partial opacity. A frame from the settled middle would
     * show two identical cards whatever their animation, which is the whole reason this defect
     * survived so long.
     */
    const measure = async (atSec: number, name: string) => {
      const raw = path.join(dir, name);
      await execFileAsync(resolveFFmpegBin(), [
        "-y", "-hide_banner", "-loglevel", "error", "-i", out, "-ss", atSec.toFixed(3),
        "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", raw,
      ]);
      const rgb = fs.readFileSync(raw);
      let count = 0;
      let maxX = -1;
      for (let y = 0; y < H; y++) {
        for (let px = 0; px < W; px++) {
          const i = (y * W + px) * 3;
          if (isRed(rgb[i]!, rgb[i + 1]!, rgb[i + 2]!)) continue;
          count++;
          if (px > maxX) maxX = px;
        }
      }
      return { count, maxX };
    };
    plain = await measure(3 / ANIM_FPS, "plain.raw");
    revealed = await measure(2 + 3 / ANIM_FPS, "revealed.raw");
  }, 900_000);

  afterAll(() => {
    if (dir) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* a leftover temp dir is not a test failure */
      }
    }
  });

  it("both cards are actually drawn — otherwise the comparison below means nothing", () => {
    expect(plain.count, "the default card drew nothing").toBeGreaterThan(200);
    expect(revealed.count, "the animated card drew nothing").toBeGreaterThan(200);
  });

  it("THE TWO FRAMES DIFFER — the animation is not thrown away between props and pixels", () => {
    /**
     * ── Why the RIGHT EDGE and not the pixel count ─────────────────────────────────────────
     *
     * The first version of this compared how many pixels each card covered, and the two came out
     * ten pixels apart out of about 1770 — while the frames plainly showed "1843" faint and whole
     * against "184" crisp with the last digit wiped away. Fewer glyphs at full opacity happened to
     * cover almost exactly what more glyphs at a third of it did.
     *
     * `mask_reveal` wipes from the left, so what it certainly changes is where the ink STOPS. That
     * is the measurement, and it is the one the animation's own definition makes: a
     * `revealFraction` below 1 is a `clipPath: inset(0 N% 0 0)` and nothing else.
     */
    expect(
      plain.maxX - revealed.maxX,
      `fade_rise ends at x=${plain.maxX} and mask_reveal at x=${revealed.maxX}` +
        ` (${plain.count}px vs ${revealed.count}px)`
    ).toBeGreaterThan(15);
  });
}, 900_000);
