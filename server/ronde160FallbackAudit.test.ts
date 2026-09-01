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
import { renderTimeline } from "./timelineRenderer";
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
