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
  detectGradualTransitionsInFile,
  gradualTransitionWindows,
  parseSceneScores,
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
  it("a run of modest changes above the moving baseline is a transition", () => {
    const still = (t0: number, n: number) => Array.from({ length: n }, (_, i) => ({ t: t0 + i / 10, score: 0 }));
    const fade = Array.from({ length: 10 }, (_, i) => ({ t: 2 + i / 10, score: 0.02 }));
    expect(gradualTransitionWindows([...still(0, 20), ...fade, ...still(3, 20)])).toEqual([{ start: 2, end: 2.9 }]);
  });

  it("steady motion on every frame is not", () => {
    const motion = Array.from({ length: 60 }, (_, i) => ({ t: i / 10, score: 0.015 + (i % 3) * 0.005 }));
    expect(gradualTransitionWindows(motion)).toEqual([]);
  });

  it("reads ffmpeg's metadata print, and turns windows into cut edges", () => {
    const out = "frame:0 pts:0 pts_time:0.1\nlavfi.scene_score=0.020000\nframe:1 pts:1 pts_time:0.2\nlavfi.scene_score=0.000000\n";
    expect(parseSceneScores(out)).toEqual([{ t: 0.1, score: 0.02 }, { t: 0.2, score: 0 }]);
    expect(cutsWithTransitions([5], [{ start: 2, end: 2.9 }])).toEqual([2, 2.9, 5]);
  });

  describe("on real ffmpeg video", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fv_softcut_"));
    const ff = (args: string[]) => execFileSync("ffmpeg", ["-loglevel", "error", "-y", ...args]);
    beforeAll(() => {
      ff(["-f", "lavfi", "-i", "color=c=red:s=320x180:d=3:r=25", "-f", "lavfi", "-i", "color=c=blue:s=320x180:d=3:r=25",
        "-filter_complex", "[0][1]xfade=transition=fade:duration=1:offset=2,format=yuv420p", "-c:v", "libx264", path.join(dir, "dissolve.mp4")]);
      ff(["-f", "lavfi", "-i", "testsrc2=s=320x180:d=6:r=25", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(dir, "motion.mp4")]);
    });

    it("finds the 1 s cross-fade at 2–3 s", async () => {
      const w = await detectGradualTransitionsInFile(path.join(dir, "dissolve.mp4"));
      expect(w).toHaveLength(1);
      expect(w[0]!.start).toBeGreaterThanOrEqual(1.8);
      expect(w[0]!.end).toBeLessThanOrEqual(3.2);
    }, 30_000);

    it("finds nothing in footage that only moves", async () => {
      expect(await detectGradualTransitionsInFile(path.join(dir, "motion.mp4"))).toEqual([]);
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
    expect(CUTS).toContain("cutsWithTransitions(hard, soft)");
    expect(fs.readFileSync(path.join(__dirname, "../drizzle/0058_ronde654_remeasure_youtube_cuts.sql"), "utf8"))
      .toContain("SET `shotCutsSec` = NULL");
  });
});
