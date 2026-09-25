import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import {
  YOUTUBE_CUT_MARGIN_SEC,
  limitYoutubeShots,
  planYoutubePieces,
  shotSegments,
  type YoutubeSourceFacts,
} from "./youtubeShotLimit";
import {
  cutsWithTransitions,
  gradualTransitionWindows,
  parseFrameDifferences,
  scanGradualTransitionsInFile,
  scanReachedTheEnd,
  scanTimeoutMs,
} from "./youtubeSoftCuts";
import { formatCutCheck, timelineEditPoints, unexpectedSceneChanges } from "./deliveredCutCheck";
import type { ProjectTimeline, TimelineVideoClip } from "./projectTimeline";

/**
 * RONDE 654 — "zorg er ook echt voor dat youtube echt knipt op scene. Dus 1 beeld zonder overgang
 * naar een volgend beeld." Render 606 logged "its cuts are ignored for this clip", and nothing
 * detected a dissolve at all.
 */
const measured = (sourceDurationSec: number, cutsSec: number[]): YoutubeSourceFacts => ({ sourceDurationSec, cutsSec, measured: true });

describe("no piece is ever taken across a cut, even when the shots are short", () => {
  it("short shots give shorter pieces instead of ignoring the cuts", () => {
    const facts = measured(20, [3, 6, 9, 12, 15, 18]);
    const { pieces, notes, refused } = planYoutubePieces({ inSec: 0, durationSec: 5, facts });
    expect(refused).toBeUndefined();
    expect(notes.join(" ")).not.toContain("ignored");
    const segs = shotSegments(facts);
    for (const p of pieces) {
      const home = segs.find((s) => p.inSec >= s.start - 1e-6 && p.inSec < s.end);
      expect(home, `piece at ${p.inSec}`).toBeDefined();
      expect(p.inSec + p.durationSec).toBeLessThanOrEqual(home!.end - YOUTUBE_CUT_MARGIN_SEC + 1e-6);
      if (home!.start > 0) expect(p.inSec).toBeGreaterThanOrEqual(home!.start + YOUTUBE_CUT_MARGIN_SEC - 1e-6);
    }
    expect(pieces.reduce((s, p) => s + p.durationSec, 0)).toBeCloseTo(5, 3);
  });

  it("shorter, different pieces rather than the same picture twice (RONDE 657, the dress rehearsal's source)", () => {
    /** Shots 0–4, a dissolve 4–5, 5–8, 8–14: only the last holds a 4 s window clear of its cuts. */
    const facts = measured(14, [4, 5, 8]);
    const { pieces, notes, refused } = planYoutubePieces({ inSec: 8, durationSec: 8, facts });
    expect(refused).toBeUndefined();
    const starts = pieces.map((p) => p.inSec);
    expect(new Set(starts).size).toBe(pieces.length);
    expect(notes.join(" ")).not.toMatch(/— \d+ repeat/);
    expect(notes.join(" ")).toContain("different pieces");
    /** Rounded to the millisecond; `limitYoutubeShots` ends the last piece on the slot's own end. */
    expect(pieces.reduce((sum, p) => sum + p.durationSec, 0)).toBeCloseTo(8, 2);
    const segs = shotSegments(facts);
    for (const p of pieces) {
      expect(p.durationSec).toBeGreaterThanOrEqual(1.5);
      const home = segs.find((seg) => p.inSec >= seg.start - 1e-6 && p.inSec < seg.end)!;
      expect(p.inSec + p.durationSec).toBeLessThanOrEqual(home.end - YOUTUBE_CUT_MARGIN_SEC + 1e-6);
    }
  });

  it("refuses when no shot is long enough once clear of its cuts", () => {
    const plan = planYoutubePieces({ inSec: 0, durationSec: 4, facts: measured(6, [1, 2, 3, 4, 5]) });
    expect(plan.pieces).toEqual([]);
    expect(plan.refused).toMatch(/no shot/);
  });
});

describe("a refused YouTube clip gives its slot to another shot, never a transition", () => {
  const clip = (id: string, start: number, end: number, sceneIndex = 0): TimelineVideoClip =>
    ({
      id, kind: "video", source: { provider: "x" }, sourceIn: 0, sourceOut: end - start,
      timelineStart: start, timelineEnd: end, motion: "none", transitionIn: "hard_cut", transitionOut: "hard_cut",
      previewSource: { kind: "none" }, sceneIndex,
    }) as unknown as TimelineVideoClip;
  const unmeasured: YoutubeSourceFacts = { sourceDurationSec: 0, cutsSec: [], measured: false };

  it("the shot before it holds longer", () => {
    const { clips, notes } = limitYoutubeShots({
      clips: [clip("a", 0, 4), clip("yt", 4, 8)],
      youtube: new Map([["yt", unmeasured]]),
    });
    expect(clips.map((c) => [c.id, c.timelineStart, c.timelineEnd])).toEqual([["a", 0, 8]]);
    expect(notes.join(" ")).toContain("REFUSED");
  });

  it("or the shot after it starts earlier", () => {
    const { clips } = limitYoutubeShots({
      clips: [clip("yt", 0, 4), clip("b", 4, 8)],
      youtube: new Map([["yt", unmeasured]]),
    });
    expect(clips.map((c) => [c.id, c.timelineStart, c.timelineEnd])).toEqual([["b", 0, 8]]);
  });

  it("and when no other shot in the scene can, it stays and says so", () => {
    const { clips, notes } = limitYoutubeShots({
      clips: [clip("yt", 0, 4, 0), clip("other", 4, 8, 1)],
      youtube: new Map([["yt", unmeasured]]),
    });
    expect(clips.map((c) => c.id)).toEqual(["yt", "other"]);
    expect(notes.join(" ")).toContain("KEPT_UNCUT");
  });
});

describe("dissolves and fades are found, camera moves are not", () => {
  /** Scores are the mean absolute frame difference, luma + half of each colour plane, in levels. */
  it("a run of modest changes above the moving baseline is a transition", () => {
    const still = (t0: number, n: number) => Array.from({ length: n }, (_, i) => ({ t: Number((t0 + i / 10).toFixed(1)), score: 0.3 }));
    const fade = Array.from({ length: 10 }, (_, i) => ({ t: Number((2 + i / 10).toFixed(1)), score: 3 }));
    expect(gradualTransitionWindows([...still(0, 20), ...fade, ...still(3, 20)])).toEqual([{ start: 2, end: 2.9 }]);
  });

  it("steady motion on every frame is not, however much it moves", () => {
    const motion = Array.from({ length: 60 }, (_, i) => ({ t: i / 10, score: 9 + (i % 3) * 1.5 }));
    expect(gradualTransitionWindows(motion)).toEqual([]);
  });

  it("a single jump is a hard cut, left to the hard-cut pass", () => {
    const s = Array.from({ length: 40 }, (_, i) => ({ t: i / 10, score: i === 20 ? 90 : 0 }));
    expect(gradualTransitionWindows(s)).toEqual([]);
  });

  it("reads ffmpeg's metadata print, and turns windows into cut edges", () => {
    const out = [
      "frame:0 pts:1 pts_time:0.1",
      "lavfi.signalstats.YAVG=2",
      "frame:0 pts:1 pts_time:0.1",
      "lavfi.signalstats.UAVG=6",
      "frame:0 pts:1 pts_time:0.1",
      "lavfi.signalstats.VAVG=4",
      "frame:1 pts:2 pts_time:0.2",
      "lavfi.signalstats.YAVG=0",
      "frame:1 pts:2 pts_time:0.2",
      "lavfi.signalstats.UAVG=0",
      "frame:1 pts:2 pts_time:0.2",
      "lavfi.signalstats.VAVG=0",
    ].join("\n");
    expect(parseFrameDifferences(out)).toEqual([{ t: 0.1, score: 7 }, { t: 0.2, score: 0 }]);
    expect(cutsWithTransitions([5], [{ start: 2, end: 2.9 }])).toEqual([2, 2.9, 5]);
  });

  it("a scan that stopped early or failed is not a scan", () => {
    const upTo = (end: number) => Array.from({ length: end * 10 }, (_, i) => ({ t: i / 10, score: 0 }));
    expect(scanReachedTheEnd(upTo(60), 60, true)).toBe(true);
    expect(scanReachedTheEnd(upTo(30), 60, true)).toBe(false);
    expect(scanReachedTheEnd(upTo(60), 60, false)).toBe(false);
    expect(scanTimeoutMs(0)).toBe(30_000);
    expect(scanTimeoutMs(300)).toBe(90_000);
    expect(scanTimeoutMs(100_000)).toBe(600_000);
  });

  describe("on real ffmpeg video", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fv_softcut_"));
    const ff = (args: string[]) => execFileSync("ffmpeg", ["-loglevel", "error", "-y", ...args]);
    const xfade = (a: string, b: string, out: string, extra = "") =>
      ff(["-f", "lavfi", "-i", a, "-f", "lavfi", "-i", b,
        "-filter_complex", `[0][1]xfade=transition=fade:duration=1:offset=2${extra},format=yuv420p`, "-c:v", "libx264", path.join(dir, out)]);
    beforeAll(() => {
      xfade("color=c=red:s=320x180:d=3:r=25", "color=c=blue:s=320x180:d=3:r=25", "dissolve.mp4");
      /** RONDE 657 — the dress rehearsal's pair, which the scene score missed: dark red-brown into dark blue. */
      xfade("color=c=0x993322:s=320x180:d=3:r=25", "color=c=0x223399:s=320x180:d=3:r=25", "lowContrast.mp4");
      /** Two greys a few levels apart: as quiet as a real shot change gets. */
      xfade("color=c=0x505050:s=320x180:d=3:r=25", "color=c=0x6a6a6a:s=320x180:d=3:r=25", "greys.mp4");
      /** A dissolve between two pictures that both move. */
      xfade("testsrc2=s=320x180:d=3:r=25", "mandelbrot=s=320x180:r=25,trim=duration=3", "moving.mp4");
      ff(["-f", "lavfi", "-i", "testsrc2=s=320x180:d=6:r=25", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(dir, "motion.mp4")]);
    });

    for (const file of ["dissolve.mp4", "lowContrast.mp4", "greys.mp4", "moving.mp4"]) {
      it(`finds the 1 s cross-fade at 2–3 s in ${file}, and scans to the end`, async () => {
        const scan = await scanGradualTransitionsInFile(path.join(dir, file), { durationSec: 5 });
        expect(scan.complete).toBe(true);
        expect(scan.windows).toHaveLength(1);
        expect(scan.windows[0]!.start).toBeGreaterThanOrEqual(1.8);
        expect(scan.windows[0]!.end).toBeLessThanOrEqual(3.2);
      }, 30_000);
    }

    it("finds nothing in footage that only moves", async () => {
      const scan = await scanGradualTransitionsInFile(path.join(dir, "motion.mp4"), { durationSec: 6 });
      expect(scan.complete).toBe(true);
      expect(scan.windows).toEqual([]);
    }, 30_000);

    it("a scan cut short by its time limit says so", async () => {
      const scan = await scanGradualTransitionsInFile(path.join(dir, "motion.mp4"), { durationSec: 6, timeoutMs: 1 });
      expect(scan.complete).toBe(false);
    }, 30_000);
  });
});

describe("the delivered file is checked against the edit's own cuts", () => {
  const timeline = {
    tracks: [{ kind: "VIDEO", clips: [
      { id: "a", timelineStart: 0, timelineEnd: 4, transitionOut: "crossfade", transitionOutSec: 0.6 },
      { id: "b", timelineStart: 4, timelineEnd: 9, transitionIn: "crossfade", transitionInSec: 0.6 },
    ] }],
  } as unknown as ProjectTimeline;

  it("a change at an edit point is ours; one in the middle of a shot is reported", () => {
    const unexpected = unexpectedSceneChanges([4.1, 6.5], timelineEditPoints(timeline));
    expect(unexpected).toEqual([6.5]);
    expect(formatCutCheck({ videoId: 1, jobId: 2, changes: 2, unexpected })).toContain("insideAShot=1 at 6.50s");
  });

  it("is wired into the render job and the measurement of every YouTube source", () => {
    const WORKER = fs.readFileSync(path.join(__dirname, "renderJobWorker.ts"), "utf8");
    const CUTS = fs.readFileSync(path.join(__dirname, "youtubeShotCuts.ts"), "utf8");
    expect(WORKER).toContain("await scanDeliveredCuts(outputPath, timeline)");
    expect(CUTS).toContain("cutsWithTransitions(hard, soft.windows)");
    expect(fs.readFileSync(path.join(__dirname, "../drizzle/0058_ronde654_remeasure_youtube_cuts.sql"), "utf8"))
      .toContain("SET `shotCutsSec` = NULL");
    /** RONDE 657 — measured once more with the detector that sees a steady cross-fade. */
    expect(fs.readFileSync(path.join(__dirname, "../drizzle/0059_ronde657_remeasure_youtube_dissolves.sql"), "utf8"))
      .toContain("SET `shotCutsSec` = NULL");
  });
});
