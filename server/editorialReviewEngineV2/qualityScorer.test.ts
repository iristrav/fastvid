import { describe, expect, it } from "vitest";
import { computeOverallScore, type ScorableDimension } from "./qualityScorer";
import type { DimensionScore } from "./types";

function uniformScores(score: number): Record<ScorableDimension, DimensionScore> {
  const dims: ScorableDimension[] = [
    "narrativeClarity", "visualAccuracy", "visualDiversity", "pacing", "emotionalFlow",
    "viewerRetention", "shotVariety", "transitionQuality", "textUsage", "historicalAccuracy",
    "contextConsistency",
  ];
  return Object.fromEntries(dims.map((d) => [d, { score, feedback: "test" }])) as Record<ScorableDimension, DimensionScore>;
}

describe("Quality Scorer (Phase 6)", () => {
  it("returns the same score for a uniform input (weights sum to 1.0)", () => {
    const { overallScore } = computeOverallScore(uniformScores(80));
    expect(overallScore).toBe(80);
  });

  it("weights narrativeClarity and viewerRetention higher than transitionQuality/textUsage", () => {
    const scores = uniformScores(80);
    scores.narrativeClarity = { score: 40, feedback: "test" };
    const lowNarrative = computeOverallScore(scores).overallScore;

    const scores2 = uniformScores(80);
    scores2.transitionQuality = { score: 40, feedback: "test" };
    const lowTransition = computeOverallScore(scores2).overallScore;

    expect(lowNarrative).toBeLessThan(lowTransition);
  });

  it("clamps the overall score into 0..100", () => {
    const { overallScore } = computeOverallScore(uniformScores(150));
    expect(overallScore).toBeLessThanOrEqual(100);
  });

  it("produces an overallQuality DimensionScore whose score matches overallScore", () => {
    const { overallScore, overallQuality } = computeOverallScore(uniformScores(65));
    expect(overallQuality.score).toBe(overallScore);
    expect(overallQuality.feedback.length).toBeGreaterThan(0);
  });

  it("names the two weakest dimensions in the feedback", () => {
    const scores = uniformScores(90);
    scores.textUsage = { score: 20, feedback: "test" };
    const { overallQuality } = computeOverallScore(scores);
    expect(overallQuality.feedback).toContain("textUsage");
  });
});
