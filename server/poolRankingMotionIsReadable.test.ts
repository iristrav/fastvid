import { describe, it, expect } from "vitest";

import { poolCandidateToAsset, rankedPool, type RankablePoolCandidate } from "./poolRanking";
import type { VisualIntent } from "./visualMatchingV2/types";

/**
 * THE DIRECTOR'S MOTION TARGET MUST REACH A CANDIDATE THAT CAN ANSWER IT.
 *
 * `targetMotionLevel` is threaded from `videoPipeline` (the rhythm target) through `assetDirector`
 * and `scenePool` into `rankCandidates`, where `motionMatchScore` returns null the moment EITHER
 * side is null. Every pool candidate carried `motionLevel: null`, so the target arrived at a
 * comparison that could not happen: four modules moving a number to nowhere.
 *
 * That is the shape this codebase has now found five times — `other=17`, `ranked=0`,
 * `cinematicDropped=false`, `youtubeLicenseMode`, and this. Each looked like a behavioural failure
 * and was a wiring failure, and each was invisible because the inert path still produced a
 * plausible-looking number.
 *
 * The fix is narrow on purpose: a still image reports motion 0, which is a fact the provider
 * already gave us; a video stays null, because its motion genuinely needs the file. These tests
 * hold that line in both directions — the signal must work for stills, and must NOT start
 * fabricating a value for video.
 */

function candidate(over: Partial<RankablePoolCandidate> = {}): RankablePoolCandidate {
  return {
    id: "c1",
    assetId: "a1",
    source: "pexels",
    remoteUrl: "https://example.invalid/a1",
    thumbnailUrl: null,
    title: "Berlin street 1945",
    description: null,
    tags: [],
    mediaType: "video",
    durationSec: 8,
    license: null,
    width: 1920,
    height: 1080,
    clipSimilarity: 0.5,
    embeddingSimilarity: 0.5,
    rankingScore: null,
    ...over,
  };
}

const INTENT = { beatText: "Berlin street 1945" } as unknown as VisualIntent;

describe("a still reports the motion it has", () => {
  it("an image carries motionLevel 0, not null", () => {
    expect(poolCandidateToAsset(candidate({ mediaType: "image" })).motionLevel).toBe(0);
  });

  it("a video stays null, because its motion needs the file", () => {
    /**
     * The half of the rule that must not drift. Guessing a video's motion from a search result
     * would score "measured, and average" for something nobody measured — which is exactly the
     * fabricated-zero failure the null was protecting against in the first place.
     */
    expect(poolCandidateToAsset(candidate({ mediaType: "video" })).motionLevel).toBeNull();
  });
});

describe("the motion target now changes the order it is passed to change", () => {
  const still = candidate({ id: "still", mediaType: "image", durationSec: null });
  const alsoStill = candidate({ id: "still2", mediaType: "image", durationSec: null });

  it("a high motion target ranks a still below an otherwise identical one it cannot separate", () => {
    /**
     * Two candidates identical in every signal but motion: one a still, one a video whose motion is
     * unknown. With a target of 90, the still scores its true mismatch and the video redistributes.
     * Before this round both returned null and the target could not move anything at all.
     */
    const video = candidate({ id: "video", mediaType: "video" });
    const wants = rankedPool({ intent: INTENT, candidates: [still, video], targetMotionLevel: 90 });
    const scoreOf = (id: string) => wants.find((c) => c.id === id)?.rankingScore ?? 0;
    expect(scoreOf("video")).toBeGreaterThan(scoreOf("still"));
  });

  it("a low motion target does not punish the still for standing still", () => {
    const video = candidate({ id: "video", mediaType: "video" });
    const calm = rankedPool({ intent: INTENT, candidates: [still, video], targetMotionLevel: 0 });
    const scoreOf = (id: string) => calm.find((c) => c.id === id)?.rankingScore ?? 0;
    expect(scoreOf("still")).toBeGreaterThan(scoreOf("video"));
  });

  it("with no target at all, nothing changes — the signal stays absent", () => {
    /**
     * The no-regression case. A caller that never asked about motion must get the ranking it always
     * got, or this round would have made the signal mandatory rather than answerable.
     */
    const ranked = rankedPool({ intent: INTENT, candidates: [still, alsoStill] });
    expect(ranked).toHaveLength(2);
    for (const c of ranked) expect(c.rankingScore).not.toBeNull();
  });
});

describe("ranking remains an ordering", () => {
  it("no candidate is lost when motion separates them", () => {
    const cands = [
      candidate({ id: "a", mediaType: "image" }),
      candidate({ id: "b", mediaType: "video" }),
      candidate({ id: "c", mediaType: "image" }),
    ];
    const ranked = rankedPool({ intent: INTENT, candidates: cands, targetMotionLevel: 70 });
    expect(ranked.map((c) => c.id).sort()).toEqual(["a", "b", "c"]);
  });
});
