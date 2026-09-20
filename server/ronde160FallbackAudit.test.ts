/**
 * RONDE 160 §12 — the fallback audit: every substitution must be able to name itself.
 *
 * ── The rule under test ──────────────────────────────────────────────────────────────────────
 *
 * "Geen stilzwijgende fallbacks." A renderer is allowed not to be able to do something. What it is
 * not allowed to do is produce a video that is missing that thing and report success, because the
 * result is indistinguishable from a video that never asked for it — and the person watching has
 * no way to find out which happened.
 *
 * These tests come at it from the direction that actually catches regressions: they take a timeline
 * asking for something this build CANNOT do, render it for real, and assert the render NAMES what
 * it dropped. Then, as the control, they assert that a timeline asking for something it CAN do
 * reports nothing — because a reporter that fires on everything is as useless as one that never
 * fires.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { emptyTimeline, type ProjectTimeline } from "./projectTimeline";
import { assAlignment, assMarginV, renderTimeline } from "./timelineRenderer";
import { positionStyle } from "./remotion/components/Text";
import { SAFE_MARGIN, boxForPosition } from "./captionLayout";
import { LOOK_MODIFIERS, RENDERABLE_LOOKS, lookUnsupportedReason } from "./timelineFilters";
import { resolveFFmpegBin } from "./ffmpegBinary";

const execFileAsync = promisify(execFile);

function timelineWithLook(look?: ProjectTimeline["look"]): ProjectTimeline {
  const t = emptyTimeline(1, { widthPx: 320, heightPx: 180, fps: 24 });
  t.durationSec = 1;
  if (look) t.look = look;
  const track = t.tracks.find((x) => x.kind === "VIDEO");
  if (track?.kind !== "VIDEO") throw new Error("no VIDEO track");
  track.clips.push({
    id: "c1",
    kind: "video",
    source: { provider: "pexels", providerAssetId: "1" },
    sourceIn: 0,
    sourceOut: 1,
    timelineStart: 0,
    timelineEnd: 1,
    motion: "none",
    transitionIn: "hard_cut",
    transitionOut: "hard_cut",
  } as never);
  return t;
}

describe("R160 §12 — an unrenderable LOOK is reported instead of silently dropped", () => {
  let dir: string;
  let source: string;
  let n = 0;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "r160-fallback-"));
    source = path.join(dir, "src.mp4");
    await execFileAsync(resolveFFmpegBin(), [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=0x808080:s=320x180:d=2:r=24",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", source,
    ]);
  }, 300_000);

  afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  async function render(timeline: ProjectTimeline) {
    const id = `r${n++}`;
    return renderTimeline({
      timeline,
      workDir: path.join(dir, id),
      outputPath: path.join(dir, `${id}.mp4`),
      resolveMedia: async () => source,
    });
  }

  /**
   * The bug this closes. `gradeChain` correctly refuses to approximate an unknown grade — guessing
   * at "teal_orange" would give the video a treatment nobody chose — and returns null. But nothing
   * said so, so the render came out completely ungraded and reported success. `lookUnsupportedReason`
   * was written in RONDE 153 for exactly this and was called from nothing but its own test.
   */
  it("a look this build cannot execute is named in `skipped`", async () => {
    const result = await render(timelineWithLook({ grade: "teal_orange" as never }));
    const line = result.skipped.find((s) => s.startsWith("unsupported_look"));
    expect(line, "an unknown look was dropped in silence").toBeTruthy();
    expect(line).toContain("teal_orange");
  }, 300_000);

  /** The control. A look that IS executed must produce no report at all. */
  it("a look this build CAN execute reports nothing", async () => {
    for (const grade of ["documentary", "cinematic", "warm", "cold"] as const) {
      const result = await render(timelineWithLook({ grade }));
      expect(
        result.skipped.filter((s) => s.startsWith("unsupported_look")),
        grade
      ).toEqual([]);
    }
  }, 600_000);

  /** `none` is a real answer, not an unknown one — it must not be reported either. */
  it("grade none is a decision, not a failure", async () => {
    const result = await render(timelineWithLook({ grade: "none" }));
    expect(result.skipped.filter((s) => s.startsWith("unsupported_look"))).toEqual([]);
  }, 300_000);

  /** A timeline with no look at all has nothing to report. */
  it("a timeline that names no look reports nothing", async () => {
    const result = await render(timelineWithLook());
    expect(result.skipped.filter((s) => s.startsWith("unsupported_look"))).toEqual([]);
  }, 300_000);

  /**
   * The two halves of the look vocabulary must agree: every grade the renderer accepts must have a
   * modifier (or be the calibration alone), and every modifier must be an accepted grade. A grade
   * in one list and not the other is the shape of bug this whole section exists to find.
   */
  it("the look vocabulary and the modifier table describe the same set", () => {
    for (const grade of Object.keys(LOOK_MODIFIERS)) {
      expect(RENDERABLE_LOOKS.has(grade), grade).toBe(true);
      expect(lookUnsupportedReason(grade), grade).toBeNull();
    }
    expect(lookUnsupportedReason("none")).toBeNull();
    expect(lookUnsupportedReason("not_a_look")).toBeTruthy();
  });
});

/* ═══════════ the two graphics engines must put text in the SAME place ═══════════ */

/**
 * ── The divergence this closes ───────────────────────────────────────────────────────────────
 *
 * A timeline is rendered by one of two engines: Remotion when a browser is available, libass when
 * it is not. Both read the same `TextPosition`. If they disagree about what a position MEANS, the
 * same timeline produces two different videos and which one you get depends on the machine — the
 * hardest class of bug to reproduce and the easiest to ship.
 *
 * `TextPosition` has six values. The ASS path handled four and let `lower_center` and `custom` fall
 * through to the plain bottom margin in silence, so `lower_center` came out 28% of the frame height
 * lower on the libass route than on the Remotion route.
 */
describe("R160 §12 — libass and Remotion agree on where a text position is", () => {
  /**
   * Remotion states its geometry as CSS padding; this reads it back in PIXELS, for a given frame.
   *
   * ── Why pixels, and why this test used to pass while the renderers were 185px apart ────────
   *
   * It used to read `paddingBottom: "22%"`, pull the NUMBER out of the string and compare 0.22 to
   * `assMarginV`'s fraction of the frame height. The two numbers matched, so the test was green
   * for three rounds — and the browser was putting the lower third 185 pixels away from where
   * libass put it, because CSS resolves a percentage padding against the containing block's WIDTH
   * and nothing here ever asked what the percent was a percentage OF.
   *
   * A pixel cannot be ambiguous about that. `positionStyle` now takes the frame and answers in
   * pixels, and this reads exactly what it answers.
   */
  function remotionBottomPx(
    position: string,
    frame: { widthPx: number; heightPx: number }
  ): number | null {
    const style = positionStyle(position, frame) as Record<string, unknown>;
    if (style.justifyContent !== "flex-end") return null;
    const pad = style.paddingBottom;
    return typeof pad === "number" ? pad : null;
  }

  /**
   * The positions that were BROKEN are now aligned. `lower_center` had no ASS implementation at
   * all — it fell through to the plain bottom margin — so bringing it to Remotion's 28% cannot
   * regress an existing video: no existing video could have been positioned there.
   */
  it("lower_third and lower_center land in the same place in both renderers", () => {
    const frame = { widthPx: 1920, heightPx: 1080 };
    for (const position of ["lower_third", "lower_center"] as const) {
      const remotion = remotionBottomPx(position, frame);
      expect(remotion, `${position}: Remotion does not anchor it to the bottom`).not.toBeNull();
      const ass = assMarginV(position, frame.heightPx);
      expect(
        Math.abs(ass - remotion!),
        `${position}: libass says ${ass}px and Remotion says ${remotion}px`
      ).toBeLessThan(2);
    }
  });

  /**
   * AT MORE THAN ONE SHAPE OF FRAME — the assertion that would have caught the original defect.
   *
   * Two anchors that disagree about whether a fraction is of the width or of the height agree
   * exactly once: on a square. Checking 16:9, 9:16 and a square is what turns "these two numbers
   * are equal" into "these two rules are the same rule".
   */
  it("and they agree at every frame shape, not just the one they were checked at", () => {
    for (const frame of [
      { widthPx: 1920, heightPx: 1080 },
      { widthPx: 1080, heightPx: 1920 },
      { widthPx: 1080, heightPx: 1080 },
      { widthPx: 640, heightPx: 360 },
    ]) {
      for (const position of ["bottom", "lower_third", "lower_center", "custom"] as const) {
        const remotion = remotionBottomPx(position, frame);
        const ass = assMarginV(position, frame.heightPx);
        expect(
          Math.abs(ass - (remotion ?? -1)),
          `${position} at ${frame.widthPx}x${frame.heightPx}: libass ${ass}px, Remotion ${remotion}px`
        ).toBeLessThan(2);
      }
    }
  });

  /**
   * ── The divergence R160 pinned, and this round could finally close ─────────────────────────
   *
   * Plain `bottom` was a fixed 40 PIXELS on the ASS route and 6 PERCENT on the Remotion route.
   * R160 left it alone on purpose and pinned it instead, reasoning that `bottom` is the default
   * position, that every caption ever rendered on the libass route sat at that 40px margin, and
   * that choosing between the two numbers was a design decision rather than an audit finding.
   *
   * What changed is that there is now a THIRD reader of the same fact, and it is the one that
   * matters: `captionLayout.boxForPosition` places every caption against the action-safe margin,
   * and the collision engine reasons about where things are from that box. So the question stopped
   * being "which of two numbers looks better" and became "which of three is the one the layout
   * engine already believes" — and that is the safe margin, which is also what `safeArea` means
   * everywhere else in this codebase.
   *
   * It moves a caption on the libass route by 14px at 1080p, from 40 to 54. That route runs only
   * where no browser is available, and a caption 1.3% of the frame lower is the price of the three
   * readers agreeing. The Remotion route — which is what production renders with — moves the other
   * way, from 6% of the WIDTH to 5% of the height.
   */
  it("plain `bottom` is the action-safe margin in BOTH renderers now", () => {
    const frame = { widthPx: 1920, heightPx: 1080 };
    expect(assMarginV("bottom", frame.heightPx)).toBe(Math.round(frame.heightPx * SAFE_MARGIN));
    expect(remotionBottomPx("bottom", frame)).toBeCloseTo(frame.heightPx * SAFE_MARGIN, 3);
    /** Relative in both, so the gap stays closed at every resolution rather than at one. */
    for (const heightPx of [360, 720, 1080, 1920]) {
      expect(assMarginV("bottom", heightPx) / heightPx).toBeCloseTo(SAFE_MARGIN, 2);
    }
  });

  it("and it is the same margin `captionLayout` places a caption at", () => {
    /**
     * The third reader. A caption's box bottom sits at the safe area's bottom edge, which is what
     * both renderers now draw — so the engine that decides a collision and the engines that draw
     * the result are finally describing one frame.
     */
    const frame = { widthPx: 1920, heightPx: 1080 };
    const box = boxForPosition("bottom", { width: 600, height: 120 }, frame);
    expect(frame.heightPx - (box.y + box.height)).toBeCloseTo(
      assMarginV("bottom", frame.heightPx),
      0
    );
  });

  /** And the three are genuinely different heights — otherwise the agreement above is trivial. */
  it("the three bottom-anchored positions are actually distinct", () => {
    const H = 1080;
    const values = ["bottom", "lower_third", "lower_center"].map((p) =>
      assMarginV(p as never, H)
    );
    expect(new Set(values).size, "two positions render in the same place").toBe(3);
    expect(values[0]).toBeLessThan(values[1]!);
    expect(values[1]).toBeLessThan(values[2]!);
  });

  /**
   * `custom` is placed inside a caller-supplied safe zone by `captionLayout`, and NEITHER renderer
   * implements that — both fall back to the bottom. That is a real limitation, and this test pins
   * it as a SHARED one: the day somebody implements it in one engine, this fails and says so.
   */
  it("custom falls back to the bottom in BOTH renderers, not just one", () => {
    const frame = { widthPx: 1920, heightPx: 1080 };
    expect(assMarginV("custom", frame.heightPx)).toBe(assMarginV("bottom", frame.heightPx));
    expect(remotionBottomPx("custom", frame)).toBe(remotionBottomPx("bottom", frame));
  });

  /** The non-bottom positions must not be silently treated as bottom either. */
  it("top and center are not bottom-anchored in either renderer", () => {
    const frame = { widthPx: 1920, heightPx: 1080 };
    for (const position of ["top", "center"] as const) {
      expect(assAlignment(position), position).not.toBe(2);
      expect(remotionBottomPx(position, frame), position).toBeNull();
    }
  });
});
