/** Editorial Review Engine V2 — Continuity Reviewer (Phase 6).
 *
 *  Scores Historical Accuracy and Context Consistency. Both are "does this stay consistent
 *  with what it claims to be" checks, so they share one file (same split rationale as
 *  narrativeReviewer.ts covering two related dimensions).
 *
 *  Historical Accuracy works from candidateId source prefixes (every SourceAdapter in
 *  visualMatchingV2/sourceAdapters.ts already prefixes candidateId with its source, e.g.
 *  "own_archive:...", "pexels:..." — reused here as a proxy for "does this scene's footage
 *  actually come from an archival source," since ClipInstruction (Phase 4's output) doesn't
 *  carry the original CandidateAsset's `source` field directly). Context Consistency checks
 *  whether the AI Director's own primarySubject/secondarySubject sequence (Phase 5's output)
 *  drifts without a bridging transition scene.
 */
import type { DimensionScore, DirectorDecision, EDL, Problem } from "./types";

export type ContinuityReviewResult = {
  scores: { historicalAccuracy: DimensionScore; contextConsistency: DimensionScore };
  problems: Problem[];
};

const ARCHIVE_ISH_PREFIXES = new Set(["own_archive", "internet_archive", "wikimedia", "europeana"]);
const MODERN_STOCK_PREFIXES = new Set(["pexels", "pixabay", "youtube_cc"]);

function sourcePrefix(candidateId: string): string {
  const idx = candidateId.indexOf(":");
  return idx === -1 ? candidateId : candidateId.slice(0, idx);
}

function scoreHistoricalAccuracy(decisions: DirectorDecision[], edls: EDL[]): { score: DimensionScore; problems: Problem[] } {
  const edlBySceneIndex = new Map(edls.map((e) => [e.sceneIndex, e]));
  const archiveScenes = decisions.filter((d) => d.visualStrategy === "archive_footage");

  if (archiveScenes.length === 0) {
    return { score: { score: 85, feedback: "No scenes rely on archival footage strategy — historical accuracy not applicable." }, problems: [] };
  }

  const problems: Problem[] = [];
  for (const d of archiveScenes) {
    const edl = edlBySceneIndex.get(d.sceneIndex);
    if (!edl || edl.decisions.length === 0) continue;

    const prefixes = edl.decisions.map((dec) => sourcePrefix(dec.clip.candidateId));
    const archiveCount = prefixes.filter((p) => ARCHIVE_ISH_PREFIXES.has(p)).length;
    const modernCount = prefixes.filter((p) => MODERN_STOCK_PREFIXES.has(p)).length;

    if (modernCount > 0 && modernCount >= archiveCount) {
      problems.push({
        type: "visual_continuity_issue",
        severity: modernCount > archiveCount ? "high" : "medium",
        sceneIndex: d.sceneIndex,
        description: `Scene ${d.sceneIndex} is planned as archive footage but ${modernCount}/${prefixes.length} of its clips come from modern stock sources.`,
        evidence: `Clip sources: ${prefixes.join(", ")}.`,
      });
    }
  }

  const penalty = Math.min(60, problems.length * 20);
  const score = Math.max(0, Math.min(100, 100 - penalty));

  return {
    score: {
      score,
      feedback: problems.length === 0 ? "Archive-strategy scenes are sourced consistently with their era." : problems.map((p) => p.description).join("; "),
      issue: problems.length > 0 ? problems.map((p) => p.description).join("; ") : undefined,
      suggestion: problems.length > 0 ? "Replace the modern-stock clips in the flagged scene(s) with archival footage." : undefined,
    },
    problems,
  };
}

function scoreContextConsistency(decisions: DirectorDecision[]): { score: DimensionScore; problems: Problem[] } {
  if (decisions.length < 3) {
    return { score: { score: 85, feedback: "Too few scenes for a meaningful continuity check." }, problems: [] };
  }

  const problems: Problem[] = [];
  let driftRun = 1;
  for (let i = 1; i < decisions.length; i++) {
    const prev = decisions[i - 1]!;
    const cur = decisions[i]!;
    const related =
      prev.primarySubject.toLowerCase() === cur.primarySubject.toLowerCase() ||
      prev.secondarySubject?.toLowerCase() === cur.primarySubject.toLowerCase() ||
      cur.secondarySubject?.toLowerCase() === prev.primarySubject.toLowerCase();

    if (!related && cur.narrativeFunction !== "transition") {
      driftRun++;
      if (driftRun === 3) {
        problems.push({
          type: "visual_continuity_issue",
          severity: "medium",
          sceneIndex: cur.sceneIndex,
          description: `${driftRun} consecutive scenes shift to unrelated subjects with no bridging transition.`,
          evidence: `Subjects: ${decisions
            .slice(i - driftRun + 1, i + 1)
            .map((d) => d.primarySubject)
            .join(" -> ")}.`,
        });
      }
    } else {
      driftRun = 1;
    }
  }

  const penalty = Math.min(40, problems.length * 20);
  const score = Math.max(0, Math.min(100, 100 - penalty));

  return {
    score: {
      score,
      feedback: problems.length === 0 ? "Subject focus stays consistent, or shifts through clear transition scenes." : problems.map((p) => p.description).join("; "),
      issue: problems.length > 0 ? problems.map((p) => p.description).join("; ") : undefined,
      suggestion: problems.length > 0 ? "Add a bridging/transition scene between unrelated subjects, or restructure the scene order." : undefined,
    },
    problems,
  };
}

export function reviewContinuity(decisions: DirectorDecision[], edls: EDL[]): ContinuityReviewResult {
  const historical = scoreHistoricalAccuracy(decisions, edls);
  const context = scoreContextConsistency(decisions);
  return {
    scores: { historicalAccuracy: historical.score, contextConsistency: context.score },
    problems: [...historical.problems, ...context.problems],
  };
}
