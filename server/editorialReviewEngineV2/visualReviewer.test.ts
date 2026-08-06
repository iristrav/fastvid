import { describe, expect, it } from "vitest";
import { reviewVisuals } from "./visualReviewer";
import { flattenEDLs } from "./types";
import { makeDecision, makeEDL } from "./testFixtures";

function withClip(candidateId: string, beatId: string, shotReason = "Beat names a person and the action matches.") {
  return makeDecision({
    beatId,
    clip: { candidateId, assetType: "video", localPath: null, remoteUrl: null, trimStartSec: 0, trimEndSec: 4, startSec: 0, endSec: 4, timingSource: "proportional_estimate" },
    shot: { shotType: "close_up", reason: shotReason },
  });
}

describe("Visual Reviewer (Phase 6) — Visual Accuracy", () => {
  it("scores well when no beat used the generic fallback tier", () => {
    const beats = flattenEDLs([makeEDL(0, [withClip("pexels:a", "b0"), withClip("wikimedia:b", "b1")])]);
    const result = reviewVisuals(beats);
    expect(result.scores.visualAccuracy.score).toBeGreaterThan(85);
  });

  it("flags off_topic_visual when a beat's shot reason cites the generic-category fallback", () => {
    const beats = flattenEDLs([
      makeEDL(0, [withClip("pexels:a", "b0", 'Candidate was retrieved via the generic-category fallback ("office") — supplementary coverage.')]),
    ]);
    const result = reviewVisuals(beats);
    expect(result.problems.some((p) => p.type === "off_topic_visual")).toBe(true);
  });
});

describe("Visual Reviewer (Phase 6) — Visual Diversity", () => {
  it("scores well for a diverse source mix with no repeated clips", () => {
    const beats = flattenEDLs([
      makeEDL(0, [withClip("pexels:a", "b0"), withClip("wikimedia:b", "b1"), withClip("internet_archive:c", "b2"), withClip("pixabay:d", "b3")]),
    ]);
    const result = reviewVisuals(beats);
    expect(result.scores.visualDiversity.score).toBeGreaterThan(80);
    expect(result.problems.some((p) => p.type === "repeated_footage")).toBe(false);
  });

  it("flags repeated_footage when the same clip is used more than once", () => {
    const beats = flattenEDLs([makeEDL(0, [withClip("pexels:same-clip", "b0"), withClip("pexels:same-clip", "b1")])]);
    const result = reviewVisuals(beats);
    const dup = result.problems.find((p) => p.type === "repeated_footage");
    expect(dup).toBeDefined();
    expect(dup!.description).toContain("same-clip");
  });

  it("flags a long run of consecutive clips from the same source", () => {
    const beats = flattenEDLs([
      makeEDL(
        0,
        Array.from({ length: 7 }, (_, i) => withClip(`pexels:${i}`, `b${i}`))
      ),
    ]);
    const result = reviewVisuals(beats);
    expect(result.scores.visualDiversity.score).toBeLessThan(80);
  });

  it("handles zero beats gracefully", () => {
    const result = reviewVisuals([]);
    expect(result.scores.visualAccuracy.score).toBe(50);
    expect(result.scores.visualDiversity.score).toBe(50);
  });
});
