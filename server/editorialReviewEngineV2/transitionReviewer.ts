/** Editorial Review Engine V2 — Transition Reviewer (Phase 6).
 *
 *  Scores Transition Quality across the whole video's planned transitions
 *  (EditDecision.transitionIn, Phase 4's output). TransitionPlanner (Phase 4) already has a
 *  built-in overuse guard (two stylized transitions back to back forces a hard cut), so this
 *  reviewer acts as an independent, whole-video safety net verifying that guard actually held
 *  end to end — not a second copy of the same logic, a check that the first copy worked.
 */
import type { DimensionScore, FlatBeat, Problem } from "./types";

export type TransitionReviewResult = { score: DimensionScore; problems: Problem[] };

export function reviewTransitions(beats: FlatBeat[]): TransitionReviewResult {
  if (beats.length === 0) {
    return { score: { score: 50, feedback: "No beats to analyze." }, problems: [] };
  }

  const types = beats.map((b) => b.decision.transitionIn.type);
  const problems: Problem[] = [];

  let curRun = 1;
  let maxNonCutRun = 0;
  let repeatedRunPenalty = 0;
  for (let i = 1; i < beats.length; i++) {
    if (types[i] === types[i - 1] && types[i] !== "cut") {
      curRun++;
      if (curRun >= 3) {
        maxNonCutRun = Math.max(maxNonCutRun, curRun);
        repeatedRunPenalty += 10;
        problems.push({
          type: "repeated_transition",
          severity: curRun >= 4 ? "high" : "medium",
          sceneIndex: beats[i].sceneIndex,
          beatId: beats[i].decision.beatId,
          description: `${curRun} consecutive "${types[i]}" transitions ending at beat ${beats[i].decision.beatId}.`,
          evidence: `TransitionPlanner's overuse guard should prevent this — found anyway, worth checking why.`,
        });
      }
    } else {
      curRun = 1;
    }
  }

  const cutFraction = types.filter((t) => t === "cut").length / types.length;
  // Nearly-all-cuts across a video with multiple scenes reads as monotonous; nearly-no-cuts
  // reads as over-stylized. Both are penalized, but more gently than an actual repeated run.
  const monotonyPenalty = beats.length >= 6 && cutFraction > 0.85 ? 8 : 0;
  const overstylePenalty = cutFraction < 0.3 ? 10 : 0;

  const score = Math.max(0, Math.min(100, 100 - repeatedRunPenalty - monotonyPenalty - overstylePenalty));

  const issues: string[] = [];
  if (maxNonCutRun >= 3) issues.push(`${maxNonCutRun} consecutive identical transitions found`);
  if (monotonyPenalty > 0) issues.push("almost every cut is a plain cut — no transition variety");
  if (overstylePenalty > 0) issues.push("transitions are overused — too few plain cuts");

  return {
    score: {
      score,
      feedback: issues.length === 0 ? `Transition variety looks healthy (${Math.round(cutFraction * 100)}% plain cuts).` : issues.join("; "),
      issue: issues.length > 0 ? issues.join("; ") : undefined,
      suggestion:
        maxNonCutRun >= 3
          ? "Replace one of the repeated transitions with a simple cut."
          : overstylePenalty > 0
          ? "Reduce transition effects — let more cuts be plain cuts."
          : undefined,
    },
    problems,
  };
}
