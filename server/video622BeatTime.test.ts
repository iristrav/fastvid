/**
 * VIDEO 622 — every sentence its own share of the scene's time.
 *
 * Scene 2 of render 622: the first sentences waited on downloads until the scene's time was gone,
 * and sentences 3 and 4 opened "6 s after the enclosing budget had already ended" — never searched.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { beatSecondsOnScreen, beatShareOfSceneTimeMs } from "./videoPipeline";

describe("Video 622 — a sentence's share of its scene's time", () => {
  it("five equal sentences in 172 s: the first gets a fifth, not everything", () => {
    expect(beatShareOfSceneTimeMs(172_000, 4, 20)).toBe(34_400);
  });

  it("a longer sentence gets more than a short one", () => {
    const long = beatShareOfSceneTimeMs(120_000, 8, 12);
    const short = beatShareOfSceneTimeMs(120_000, 4, 12);
    expect(long).toBe(80_000);
    expect(short).toBe(40_000);
  });

  it("time a sentence did not use goes to the next: the share is of what is left", () => {
    /** Sentence 1 of 3 used 10 s of its 40; sentence 2 of the two left gets half of the 110 s left. */
    expect(beatShareOfSceneTimeMs(110_000, 4, 8)).toBe(55_000);
  });

  it("the last sentence gets everything left", () => {
    expect(beatShareOfSceneTimeMs(37_000, 4, 4)).toBe(37_000);
  });

  it("no time left is no time; no scope is no limit", () => {
    expect(beatShareOfSceneTimeMs(0, 4, 12)).toBe(0);
    expect(beatShareOfSceneTimeMs(Number.POSITIVE_INFINITY, 4, 12)).toBe(Number.POSITIVE_INFINITY);
  });

  it("a sentence is as long as its voice, else as long as it is held", () => {
    expect(beatSecondsOnScreen({ voiceStartSec: 2, voiceEndSec: 6.5, holdSec: 3 })).toBe(4.5);
    expect(beatSecondsOnScreen({ holdSec: 3 })).toBe(3);
    expect(beatSecondsOnScreen({})).toBe(1);
  });

  it("the scene's sentence loop caps each sentence at its share", () => {
    const src = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    /** OCTOBER 2026 (render 626) — the share is still the cap, now after the later sentences' reserve. */
    expect(src).toContain("beatTurnAfterReserveMs(beatShareMs, sceneLeftMs, beats.length - bi - 1)");
    expect(src).toContain("beatVisualWallMs(dedup.perf),");
    expect(src).toContain("beats.slice(bi).reduce((sum, b) => sum + beatSecondsOnScreen(b), 0)");
  });
});

describe("Video 622 — a YouTube clip that reached the film is not reported as refused", () => {
  it("the lifecycle is read after the render, beside the film's own count", () => {
    const src = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    const trace = src.indexOf("const youtubeLifecycle = lineage ? traceYoutubeLifecycle(lineage, visualDedup.beatRelevance) : [];");
    expect(trace).toBeGreaterThan(src.indexOf("footage = youtubeFootageInTimeline(measured.clips, origins, measured.basis);"));
    expect(src.match(/traceYoutubeLifecycle\(/g)?.length).toBe(1);
  });

  it("a second offer of the same picture refused as already used does not end the adopted one", async () => {
    const { traceYoutubeLifecycle } = await import("./youtubeLifecycleTrace");
    const src = fs.readFileSync(path.join(__dirname, "youtubeLifecycleTrace.ts"), "utf8");
    expect(src).toContain('if (adopted && e.gate === "already_used_in_render") continue;');
    expect(typeof traceYoutubeLifecycle).toBe("function");
  });
});

describe("Video 622 — a beat's YouTube wait leaves room to judge the archive", () => {
  it("a 34 s beat: YouTube may wait about 20 s, the archive keeps at least 10 s", async () => {
    const { youtubeTurnLeavingRoomForArchive } = await import("./videoPipeline");
    expect(youtubeTurnLeavingRoomForArchive(120_000, 34_000)).toBe(20_400);
  });

  it("a long beat: the archive keeps at most a minute, YouTube is still capped at its own two minutes", async () => {
    const { youtubeTurnLeavingRoomForArchive } = await import("./videoPipeline");
    expect(youtubeTurnLeavingRoomForArchive(120_000, 300_000)).toBe(120_000);
    expect(youtubeTurnLeavingRoomForArchive(120_000, 160_000)).toBe(100_000);
  });

  it("a short beat is split in two; no time is no turn; no scope is the full turn", async () => {
    const { youtubeTurnLeavingRoomForArchive } = await import("./videoPipeline");
    expect(youtubeTurnLeavingRoomForArchive(120_000, 12_000)).toBe(6_000);
    expect(youtubeTurnLeavingRoomForArchive(120_000, 0)).toBe(0);
    expect(youtubeTurnLeavingRoomForArchive(120_000, Number.POSITIVE_INFINITY)).toBe(120_000);
  });
});
