/** Editorial Review Engine V2 — Shot Reviewer (Phase 6).
 *
 *  Scores Shot Variety across the whole video's already-planned shots (EditDecision.shot,
 *  Phase 4's output) — same algorithm shape as the legacy engine's scoreShootVariety()
 *  (consecutive-run detection, missing close-up/wide, category balance), adapted from
 *  post-render ClipAdoptEntry categories to pre-render ShotType values Phase 4 already
 *  assigned. Doesn't re-classify anything — ShotPlanner already decided the shot type; this
 *  only checks whether the resulting sequence, as planned, is actually varied.
 */
import type { ShotType } from "../cinematicEditingEngine/types";
import type { DimensionScore, FlatBeat, Problem } from "./types";

const CLOSE_TYPES: ShotType[] = ["close_up", "extreme_close_up", "detail"];
const WIDE_TYPES: ShotType[] = ["establishing", "wide"];

export type ShotReviewResult = { score: DimensionScore; problems: Problem[] };

export function reviewShots(beats: FlatBeat[]): ShotReviewResult {
  if (beats.length === 0) {
    return { score: { score: 50, feedback: "No beats to analyze." }, problems: [] };
  }

  const shotTypes = beats.map((b) => b.decision.shot.shotType);
  const counts: Partial<Record<ShotType, number>> = {};
  for (const s of shotTypes) counts[s] = (counts[s] ?? 0) + 1;

  const problems: Problem[] = [];

  // Consecutive-run detection, same shape as the legacy engine.
  let maxRun = 1;
  let curRun = 1;
  let runStartIndex = 0;
  let runPenalty = 0;
  for (let i = 1; i < beats.length; i++) {
    if (shotTypes[i] === shotTypes[i - 1]) {
      curRun++;
      if (curRun >= 3) {
        runPenalty += 4;
        problems.push({
          type: "low_visual_variety",
          severity: curRun >= 4 ? "high" : "medium",
          sceneIndex: beats[i].sceneIndex,
          beatId: beats[i].decision.beatId,
          description: `${curRun} consecutive "${shotTypes[i]}" shots ending at beat ${beats[i].decision.beatId}.`,
          evidence: `Run of ${curRun} identical shot types starting at beat ${beats[runStartIndex].decision.beatId}.`,
        });
      }
    } else {
      maxRun = Math.max(maxRun, curRun);
      curRun = 1;
      runStartIndex = i;
    }
  }
  maxRun = Math.max(maxRun, curRun);

  const hasClose = CLOSE_TYPES.some((t) => (counts[t] ?? 0) > 0);
  const hasWide = WIDE_TYPES.some((t) => (counts[t] ?? 0) > 0);
  const missingClose = !hasClose ? 8 : 0;
  const missingWide = !hasWide && beats.length >= 4 ? 6 : 0;

  const uniqueCategories = Object.keys(counts).length;
  const balancePenalty = Math.max(0, 3 - uniqueCategories) * 5;

  const score = Math.max(0, Math.min(100, 100 - runPenalty - missingClose - missingWide - balancePenalty));

  if (!hasClose) {
    problems.push({
      type: "low_visual_variety",
      severity: "medium",
      description: "No close-up or detail shots anywhere in the video.",
      evidence: `Shot type distribution: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(", ")}.`,
    });
  }
  if (!hasWide && beats.length >= 4) {
    problems.push({
      type: "low_visual_variety",
      severity: "low",
      description: "No establishing or wide shots anywhere in the video.",
      evidence: `Shot type distribution: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(", ")}.`,
    });
  }

  const issues: string[] = [];
  if (maxRun >= 3) issues.push(`${maxRun} consecutive shots of the same type`);
  if (!hasClose) issues.push("no close-up shots");
  if (!hasWide) issues.push("no establishing/wide shots");

  return {
    score: {
      score,
      feedback: issues.length === 0 ? `Good shot variety across ${uniqueCategories} shot types.` : `Shot variety issues: ${issues.join("; ")}.`,
      issue: issues.length > 0 ? issues.join("; ") : undefined,
      suggestion: !hasClose
        ? "Use a close-up instead of another wide shot somewhere in the video."
        : maxRun >= 3
        ? `Break up the run of ${maxRun} same-type shots with a different shot category.`
        : undefined,
    },
    problems,
  };
}
