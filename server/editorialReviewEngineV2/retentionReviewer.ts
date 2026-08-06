/** Editorial Review Engine V2 — Retention Reviewer (Phase 6).
 *
 *  Scores Viewer Retention by reusing the AI Director's own retention analysis
 *  (DirectorOutput.retentionRisks/hookGuidance/highlightMoments, Phase 5's output) rather than
 *  recomputing boring-section or hook-quality detection from scratch — the Director already
 *  did that work per scene, with full access to scene duration/position/repetition context.
 *  This reviewer's only job is to turn those already-computed per-scene signals into a
 *  whole-video retention score and problem list.
 *
 *  Director-flagged at-risk scenes are reported as "long_static_section" problems — the
 *  Phase 6 spec uses "boring sections" (RETENTION STRATEGY) and "long static sections"
 *  (PROBLEM DETECTION) to describe the same underlying concern; evidence text always
 *  attributes the finding to the Director's own reasoning so it reads distinctly from
 *  pacingReviewer.ts's independent, clip-duration-based findings of the same type.
 */
import type { DimensionScore, DirectorOutput, Problem } from "./types";

export type RetentionReviewResult = { score: DimensionScore; problems: Problem[] };

export function reviewRetention(directorOutput: DirectorOutput): RetentionReviewResult {
  const decisions = directorOutput.decisions;
  if (decisions.length === 0) {
    return { score: { score: 50, feedback: "No scenes to analyze." }, problems: [] };
  }

  const problems: Problem[] = [];
  const risky = decisions.filter((d) => d.retentionRisk.isAtRisk);

  for (const d of risky) {
    problems.push({
      type: "long_static_section",
      severity: "medium",
      sceneIndex: d.sceneIndex,
      description: `Scene ${d.sceneIndex} was flagged as a viewer-retention risk by the AI Director.`,
      evidence: `AI Director's retention analysis: ${d.retentionRisk.reason}`,
    });
  }

  const openingHook = decisions[0]!.hookGuidance;
  let hookPenalty = 0;
  if (!openingHook.isHookSegment) {
    hookPenalty = 15;
    problems.push({
      type: "weak_opening",
      severity: "medium",
      sceneIndex: decisions[0]!.sceneIndex,
      description: "The opening scene isn't recognized as being within the video's hook window.",
      evidence: openingHook.reason,
    });
  }

  const riskFraction = risky.length / decisions.length;
  const riskPenalty = Math.min(50, risky.length * 12);
  const score = Math.max(0, Math.min(100, 100 - riskPenalty - hookPenalty));

  const highlightCount = directorOutput.highlightMoments.length;
  const issues = problems.map((p) => p.description);

  return {
    score: {
      score,
      feedback:
        issues.length === 0
          ? `No retention risks flagged; ${highlightCount} high-engagement moment(s) identified for trailer/highlight use.`
          : `${issues.join("; ")} (${Math.round(riskFraction * 100)}% of scenes at risk).`,
      issue: issues.length > 0 ? issues.join("; ") : undefined,
      suggestion:
        risky.length > 0
          ? `Address the ${risky.length} flagged scene(s) using the AI Director's own recommendations for each.`
          : !openingHook.isHookSegment
          ? "Shorten or re-energize the opening scene so it falls within the hook window."
          : undefined,
    },
    problems,
  };
}
