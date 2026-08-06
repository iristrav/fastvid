/** Editorial Review Engine V2 — Review Report Generator (Phase 6).
 *
 *  The single entrypoint that runs every reviewer over a complete video's EDLs + AI Director
 *  output, aggregates their scores/problems, plans recommendations and auto-fixes, and decides
 *  a final approval status. Makes no editorial judgments of its own — every score/problem
 *  comes from exactly one specialized reviewer; this only sequences them and assembles the
 *  report, the same "orchestrator vs. planner" split as Phase 4's edlGenerator.ts and Phase
 *  5's aiDirector.ts.
 *
 *  Never renders anything. produceApprovedEDL() is the only bridge to a future renderer
 *  (Phase 7+): it returns null for a rejected review — a renderer checking for null before
 *  proceeding is how "must never render anything" from THIS engine becomes "must never render
 *  a rejected plan" for whatever consumes its output next.
 */
import { reviewShots } from "./shotReviewer";
import { reviewTransitions } from "./transitionReviewer";
import { reviewCaptions } from "./captionReviewer";
import { reviewPacing } from "./pacingReviewer";
import { reviewNarrative } from "./narrativeReviewer";
import { reviewRetention } from "./retentionReviewer";
import { reviewContinuity } from "./continuityReviewer";
import { reviewVisuals } from "./visualReviewer";
import { computeOverallScore, type ScorableDimension } from "./qualityScorer";
import { planAutoFixes, planRecommendations } from "./improvementPlanner";
import { flattenEDLs } from "./types";
import type { ApprovalStatus, ApprovedEDL, DimensionScore, EDL, Problem, ReviewDimension, ReviewInputV2, ReviewReport } from "./types";

function decideApprovalStatus(overallScore: number, problems: Problem[]): ApprovalStatus {
  const highSeverityCount = problems.filter((p) => p.severity === "high").length;
  if (overallScore < 45 || highSeverityCount >= 3) return "rejected";
  if (overallScore < 65 || highSeverityCount >= 1) return "needs_revision";
  if (overallScore < 80) return "approved_with_notes";
  return "approved";
}

/** More scenes/beats analyzed = higher confidence in the review itself — not a quality
 *  judgment, a data-sufficiency one. A 1-beat video can still score accurately, but the
 *  review has far less to work with than a 20-beat one. */
function computeConfidence(beatCount: number, sceneCount: number): number {
  if (beatCount === 0) return 0.1;
  const beatConfidence = Math.min(1, beatCount / 15);
  const sceneConfidence = Math.min(1, sceneCount / 5);
  return Math.round((beatConfidence * 0.6 + sceneConfidence * 0.4) * 100) / 100;
}

/**
 * Runs the complete pre-render editorial review for one video: every reviewer, the quality
 * scorer, and the improvement planner, assembled into one ReviewReport.
 */
export function generateReviewReport(input: ReviewInputV2): ReviewReport {
  const beats = flattenEDLs(input.edls);
  const decisions = input.directorOutput.decisions;

  const shot = reviewShots(beats);
  const transition = reviewTransitions(beats);
  const caption = reviewCaptions(beats, input.edls);
  const pacing = reviewPacing(beats);
  const narrative = reviewNarrative(decisions);
  const retention = reviewRetention(input.directorOutput);
  const continuity = reviewContinuity(decisions, input.edls);
  const visual = reviewVisuals(beats);

  const scorable: Record<ScorableDimension, DimensionScore> = {
    narrativeClarity: narrative.scores.narrativeClarity,
    visualAccuracy: visual.scores.visualAccuracy,
    visualDiversity: visual.scores.visualDiversity,
    pacing: pacing.score,
    emotionalFlow: narrative.scores.emotionalFlow,
    viewerRetention: retention.score,
    shotVariety: shot.score,
    transitionQuality: transition.score,
    textUsage: caption.score,
    historicalAccuracy: continuity.scores.historicalAccuracy,
    contextConsistency: continuity.scores.contextConsistency,
  };

  const { overallScore, overallQuality } = computeOverallScore(scorable);
  const scores: Record<ReviewDimension, DimensionScore> = { ...scorable, overallProfessionalQuality: overallQuality };

  const problems: Problem[] = [
    ...shot.problems,
    ...transition.problems,
    ...caption.problems,
    ...pacing.problems,
    ...narrative.problems,
    ...retention.problems,
    ...continuity.problems,
    ...visual.problems,
  ];

  const recommendations = planRecommendations(problems);
  const autoFixes = planAutoFixes(problems, input.edls);
  const approvalStatus = decideApprovalStatus(overallScore, problems);
  const confidenceScore = computeConfidence(beats.length, decisions.length);

  return {
    videoId: input.videoId,
    videoTitle: input.videoTitle,
    reviewedAt: new Date().toISOString(),
    scores,
    overallScore,
    problems,
    recommendations,
    autoFixes,
    approvalStatus,
    confidenceScore,
  };
}

/** The only thing a future renderer should ever consume: an EDL that passed review. Returns
 *  null for a rejected review — there is deliberately no way to obtain an ApprovedEDL for a
 *  video the review rejected short of fixing the underlying problems and re-reviewing. */
export function produceApprovedEDL(videoId: string, edls: EDL[], review: ReviewReport): ApprovedEDL | null {
  if (review.approvalStatus === "rejected") return null;
  return { videoId, edls, review, approvedAt: new Date().toISOString() };
}
