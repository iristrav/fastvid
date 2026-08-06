import { describe, expect, it } from "vitest";
import { reviewContinuity } from "./continuityReviewer";
import { makeDecision, makeDirectorDecision, makeEDL } from "./testFixtures";

function withCandidate(candidateId: string, beatId: string, sceneIndex: number) {
  return makeDecision({
    beatId,
    sceneIndex,
    clip: { candidateId, assetType: "video", localPath: null, remoteUrl: null, trimStartSec: 0, trimEndSec: 4, startSec: 0, endSec: 4, timingSource: "proportional_estimate" },
  });
}

describe("Continuity Reviewer (Phase 6) — Historical Accuracy", () => {
  it("scores well when archive-strategy scenes are actually sourced from archival footage", () => {
    const decisions = [makeDirectorDecision({ sceneIndex: 0, visualStrategy: "archive_footage" })];
    const edls = [makeEDL(0, [withCandidate("internet_archive:a1", "b0", 0), withCandidate("wikimedia:a2", "b1", 0)])];
    const result = reviewContinuity(decisions, edls);
    expect(result.scores.historicalAccuracy.score).toBeGreaterThan(85);
    expect(result.problems).toEqual([]);
  });

  it("flags a visual_continuity_issue when an archive-strategy scene is mostly modern stock", () => {
    const decisions = [makeDirectorDecision({ sceneIndex: 0, visualStrategy: "archive_footage" })];
    const edls = [makeEDL(0, [withCandidate("pexels:p1", "b0", 0), withCandidate("pixabay:p2", "b1", 0)])];
    const result = reviewContinuity(decisions, edls);
    expect(result.problems.some((p) => p.type === "visual_continuity_issue")).toBe(true);
  });

  it("is not applicable when no scene uses the archive_footage strategy", () => {
    const decisions = [makeDirectorDecision({ sceneIndex: 0, visualStrategy: "b_roll" })];
    const result = reviewContinuity(decisions, [makeEDL(0, [withCandidate("pexels:p1", "b0", 0)])]);
    expect(result.scores.historicalAccuracy.score).toBeGreaterThan(80);
  });
});

describe("Continuity Reviewer (Phase 6) — Context Consistency", () => {
  it("scores well when subjects stay related across scenes", () => {
    const decisions = [
      makeDirectorDecision({ sceneIndex: 0, primarySubject: "Apple", secondarySubject: "Tim Cook" }),
      makeDirectorDecision({ sceneIndex: 1, primarySubject: "Tim Cook", secondarySubject: "Apple" }),
      makeDirectorDecision({ sceneIndex: 2, primarySubject: "Apple", secondarySubject: null }),
    ];
    const result = reviewContinuity(decisions, []);
    expect(result.scores.contextConsistency.score).toBeGreaterThan(85);
  });

  it("flags 3+ consecutive unrelated-subject scenes with no bridging transition", () => {
    const decisions = [
      makeDirectorDecision({ sceneIndex: 0, primarySubject: "Apple", narrativeFunction: "establish" }),
      makeDirectorDecision({ sceneIndex: 1, primarySubject: "Tesla", narrativeFunction: "explain" }),
      makeDirectorDecision({ sceneIndex: 2, primarySubject: "Nvidia", narrativeFunction: "explain" }),
    ];
    const result = reviewContinuity(decisions, []);
    expect(result.problems.some((p) => p.type === "visual_continuity_issue")).toBe(true);
  });

  it("does not flag subject drift when a transition scene bridges it", () => {
    const decisions = [
      makeDirectorDecision({ sceneIndex: 0, primarySubject: "Apple", narrativeFunction: "establish" }),
      makeDirectorDecision({ sceneIndex: 1, primarySubject: "Tesla", narrativeFunction: "transition" }),
      makeDirectorDecision({ sceneIndex: 2, primarySubject: "Nvidia", narrativeFunction: "transition" }),
    ];
    const result = reviewContinuity(decisions, []);
    expect(result.problems.some((p) => p.type === "visual_continuity_issue")).toBe(false);
  });

  it("skips the check entirely for very short videos", () => {
    const decisions = [makeDirectorDecision({ sceneIndex: 0, primarySubject: "Apple" }), makeDirectorDecision({ sceneIndex: 1, primarySubject: "Tesla" })];
    const result = reviewContinuity(decisions, []);
    expect(result.scores.contextConsistency.score).toBeGreaterThan(80);
  });
});
