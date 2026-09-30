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
    expect(src).toContain("const beatWallMs = Math.min(beatVisualWallMs(dedup.perf), beatShareMs);");
    expect(src).toContain("beats.slice(bi).reduce((sum, b) => sum + beatSecondsOnScreen(b), 0)");
  });
});
