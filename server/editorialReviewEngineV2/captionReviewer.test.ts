import { describe, expect, it } from "vitest";
import { reviewCaptions } from "./captionReviewer";
import { flattenEDLs } from "./types";
import { makeCaption, makeDecision, makeEDL } from "./testFixtures";

describe("Caption Reviewer (Phase 6)", () => {
  it("scores well for light, sparse caption usage", () => {
    const edl = makeEDL(0, [
      makeDecision({ beatId: "b0", clip: { candidateId: "c", assetType: "video", localPath: null, remoteUrl: null, trimStartSec: 0, trimEndSec: 10, startSec: 0, endSec: 10, timingSource: "proportional_estimate" }, captions: [makeCaption({ startSec: 0, endSec: 2 })] }),
    ]);
    const beats = flattenEDLs([edl]);
    const result = reviewCaptions(beats, [edl]);
    expect(result.score.score).toBeGreaterThan(80);
    expect(result.problems).toEqual([]);
  });

  it("flags high global caption density as too_much_text", () => {
    const edl = makeEDL(0, [
      makeDecision({
        beatId: "b0",
        clip: { candidateId: "c", assetType: "video", localPath: null, remoteUrl: null, trimStartSec: 0, trimEndSec: 10, startSec: 0, endSec: 10, timingSource: "proportional_estimate" },
        captions: [makeCaption({ startSec: 0, endSec: 9 })],
      }),
    ]);
    const beats = flattenEDLs([edl]);
    const result = reviewCaptions(beats, [edl]);
    expect(result.problems.some((p) => p.type === "too_much_text" && p.sceneIndex === undefined)).toBe(true);
  });

  it("flags a single beat with more than 3 simultaneous captions", () => {
    const edl = makeEDL(0, [
      makeDecision({
        beatId: "b0",
        captions: [makeCaption(), makeCaption({ captionType: "date" }), makeCaption({ captionType: "name" }), makeCaption({ captionType: "statistic" })],
      }),
    ]);
    const beats = flattenEDLs([edl]);
    const result = reviewCaptions(beats, [edl]);
    expect(result.problems.some((p) => p.beatId === "b0" && p.type === "too_much_text")).toBe(true);
  });

  it("handles zero beats gracefully", () => {
    const result = reviewCaptions([], []);
    expect(result.score.score).toBe(50);
  });
});
