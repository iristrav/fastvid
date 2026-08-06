import { describe, expect, it } from "vitest";
import { generateReviewReport, produceApprovedEDL } from "./reviewReportGenerator";
import type { ReviewInputV2 } from "./types";
import {
  beatsOfShotTypes,
  makeDecision,
  makeDirectorDecision,
  makeDirectorOutput,
  makeEDL,
} from "./testFixtures";

function withUniqueClipsAndMovement(decisions: ReturnType<typeof beatsOfShotTypes>, sceneIndex: number, durationBase: number) {
  const movements = ["slow_push", "pan_left", "zoom_in", "tilt_up"] as const;
  return decisions.map((d, i) => ({
    ...d,
    clip: {
      ...d.clip,
      candidateId: `pexels:s${sceneIndex}c${i}`,
      startSec: i * 4,
      endSec: i * 4 + durationBase + (i % 2),
    },
    camera: { movement: movements[i % movements.length], intensity: 0.5, reason: "test" },
  }));
}

function healthyInput(): ReviewInputV2 {
  const decisions0 = withUniqueClipsAndMovement(beatsOfShotTypes(0, ["establishing", "wide", "medium", "close_up"]), 0, 3);
  const decisions1 = withUniqueClipsAndMovement(beatsOfShotTypes(1, ["medium", "reaction", "close_up", "wide"]), 1, 3.5);
  const edls = [makeEDL(0, decisions0), makeEDL(1, decisions1)];
  const directorDecisions = [
    makeDirectorDecision({
      sceneIndex: 0,
      narrativeFunction: "establish",
      emotion: "curiosity",
      hookGuidance: { isHookSegment: true, recommendations: ["Increase energy."], reason: "test" },
    }),
    makeDirectorDecision({ sceneIndex: 1, narrativeFunction: "resolve", emotion: "hope" }),
  ];
  return {
    videoId: "v1",
    videoTitle: "Test Video",
    edls,
    directorOutput: makeDirectorOutput(directorDecisions),
  };
}

describe("Review Report Generator (Phase 6) — end to end", () => {
  it("produces a complete ReviewReport with all 12 dimensions scored", () => {
    const report = generateReviewReport(healthyInput());
    const dims = [
      "narrativeClarity", "visualAccuracy", "visualDiversity", "pacing", "emotionalFlow",
      "viewerRetention", "shotVariety", "transitionQuality", "textUsage", "historicalAccuracy",
      "contextConsistency", "overallProfessionalQuality",
    ];
    for (const dim of dims) {
      expect(report.scores).toHaveProperty(dim);
      expect(typeof report.scores[dim as keyof typeof report.scores].score).toBe("number");
    }
    expect(typeof report.overallScore).toBe("number");
  });

  it("aggregates problems from every reviewer", () => {
    const decisions = beatsOfShotTypes(0, ["medium", "medium", "medium", "medium"]);
    const edls = [makeEDL(0, decisions)];
    const input: ReviewInputV2 = {
      videoId: "v2",
      videoTitle: "Repetitive Video",
      edls,
      directorOutput: makeDirectorOutput([makeDirectorDecision({ sceneIndex: 0 })]),
    };
    const report = generateReviewReport(input);
    expect(report.problems.some((p) => p.type === "low_visual_variety")).toBe(true);
    expect(report.recommendations.length).toBe(report.problems.length);
  });

  it("assigns approved for a healthy, low-problem video", () => {
    const report = generateReviewReport(healthyInput());
    expect(["approved", "approved_with_notes"]).toContain(report.approvalStatus);
  });

  it("assigns rejected for a video with 3+ high-severity problems", () => {
    // Deliberately triggers three independent high-severity findings: the same clip reused
    // 4x (repeated_footage), the same shot type 4x in a row (low_visual_variety), and the
    // same non-cut transition 4x in a row (repeated_transition) — each individually crosses
    // that reviewer's "high" severity threshold.
    const decisions = Array.from({ length: 4 }, (_, i) =>
      makeDecision({
        beatId: `b${i}`,
        sceneIndex: 0,
        clip: { candidateId: "pexels:same", assetType: "video", localPath: null, remoteUrl: null, trimStartSec: 0, trimEndSec: 3, startSec: i * 3, endSec: i * 3 + 3, timingSource: "proportional_estimate" },
        shot: { shotType: "medium", reason: "test" },
        transitionIn: { type: "whip", durationSec: 0.25, reason: "test" },
      })
    );
    const input: ReviewInputV2 = {
      videoId: "v3",
      videoTitle: "Broken Video",
      edls: [makeEDL(0, decisions)],
      directorOutput: makeDirectorOutput([
        makeDirectorDecision({
          sceneIndex: 0,
          narrativeFunction: "explain",
          retentionRisk: { isAtRisk: true, reason: "very repetitive", recommendations: ["Add variety."] },
          hookGuidance: { isHookSegment: false, recommendations: [], reason: "starts late" },
        }),
      ]),
    };
    const report = generateReviewReport(input);
    expect(report.approvalStatus).toBe("rejected");
  });

  it("computes higher confidence for videos with more scenes/beats", () => {
    const small = generateReviewReport({
      videoId: "small",
      videoTitle: "Small",
      edls: [makeEDL(0, [makeDecision({ beatId: "b0", sceneIndex: 0 })])],
      directorOutput: makeDirectorOutput([makeDirectorDecision({ sceneIndex: 0 })]),
    });
    const large = generateReviewReport(healthyInput());
    expect(large.confidenceScore).toBeGreaterThan(small.confidenceScore);
  });

  it("produceApprovedEDL returns null for a rejected review", () => {
    const report = generateReviewReport(healthyInput());
    const rejected = { ...report, approvalStatus: "rejected" as const };
    expect(produceApprovedEDL("v1", healthyInput().edls, rejected)).toBeNull();
  });

  it("produceApprovedEDL returns a real ApprovedEDL carrying the review for a non-rejected report", () => {
    const input = healthyInput();
    const report = generateReviewReport(input);
    if (report.approvalStatus !== "rejected") {
      const approved = produceApprovedEDL(input.videoId, input.edls, report);
      expect(approved).not.toBeNull();
      expect(approved!.edls).toBe(input.edls);
      expect(approved!.review).toBe(report);
      expect(approved!.approvedAt.length).toBeGreaterThan(0);
    }
  });
});
