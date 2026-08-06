/** Editorial Review Engine V2 — Narrative Reviewer (Phase 6).
 *
 *  Scores Narrative Clarity and Emotional Flow from the AI Director's own scene-by-scene
 *  decisions (DirectorDecision, Phase 5's output) — reused directly rather than re-deriving
 *  narrative structure from raw scene text, since the Director already classified each
 *  scene's narrativeFunction and emotion. This reviewer's job is to check whether the
 *  SEQUENCE of those decisions, taken together, actually reads as a coherent story (weak
 *  opening/ending, flat emotional arc) — a whole-video judgment no single per-scene
 *  DirectorDecision makes on its own.
 */
import type { DirectorDecision, DimensionScore, Problem } from "./types";

export type NarrativeReviewResult = {
  scores: { narrativeClarity: DimensionScore; emotionalFlow: DimensionScore };
  problems: Problem[];
};

function scoreNarrativeClarity(decisions: DirectorDecision[]): { score: DimensionScore; problems: Problem[] } {
  if (decisions.length === 0) {
    return { score: { score: 50, feedback: "No scenes to analyze." }, problems: [] };
  }

  const problems: Problem[] = [];
  let penalty = 0;
  const first = decisions[0]!;
  const last = decisions[decisions.length - 1]!;

  if (decisions.length >= 2 && first.narrativeFunction !== "establish" && first.narrativeFunction !== "transition") {
    penalty += 10;
    problems.push({
      type: "weak_opening",
      severity: "medium",
      sceneIndex: first.sceneIndex,
      description: `Opening scene is classified as "${first.narrativeFunction}" rather than establishing the story.`,
      evidence: `Scene ${first.sceneIndex} narrativeFunction = "${first.narrativeFunction}".`,
    });
  }

  if (decisions.length >= 2 && last.narrativeFunction !== "resolve") {
    penalty += 10;
    problems.push({
      type: "weak_ending",
      severity: "medium",
      sceneIndex: last.sceneIndex,
      description: `Closing scene is classified as "${last.narrativeFunction}" rather than resolving the story.`,
      evidence: `Scene ${last.sceneIndex} narrativeFunction = "${last.narrativeFunction}".`,
    });
  }

  const functions = decisions.map((d) => d.narrativeFunction);
  const distinctFunctions = new Set(functions).size;
  let homogeneityIssue: string | undefined;
  if (decisions.length >= 4 && distinctFunctions === 1) {
    penalty += 15;
    homogeneityIssue = `every scene shares the same narrative function ("${functions[0]}") — the story doesn't build or shift`;
  }

  const score = Math.max(0, Math.min(100, 100 - penalty));
  const issues = [...problems.map((p) => p.description), ...(homogeneityIssue ? [homogeneityIssue] : [])];

  return {
    score: {
      score,
      feedback: issues.length === 0 ? "Narrative structure has a clear beginning, middle, and end." : issues.join("; "),
      issue: issues.length > 0 ? issues.join("; ") : undefined,
      suggestion:
        problems.some((p) => p.type === "weak_opening")
          ? "Strengthen the opening scene so it clearly establishes the story before diving into detail."
          : problems.some((p) => p.type === "weak_ending")
          ? "Add a resolving beat at the end so the story doesn't just stop."
          : homogeneityIssue
          ? "Vary narrative function across scenes (contrast, reveal, climax) instead of only explaining."
          : undefined,
    },
    problems,
  };
}

function scoreEmotionalFlow(decisions: DirectorDecision[]): { score: DimensionScore; problems: Problem[] } {
  if (decisions.length === 0) {
    return { score: { score: 50, feedback: "No scenes to analyze." }, problems: [] };
  }

  const emotions = decisions.map((d) => d.emotion);
  const distinctCount = new Set(emotions).size;
  const problems: Problem[] = [];
  let penalty = 0;

  if (distinctCount === 1 && decisions.length >= 3) {
    penalty = Math.min(40, decisions.length * 5);
    problems.push({
      type: "low_emotional_variation",
      severity: decisions.length >= 6 ? "high" : "medium",
      description: `Every scene shares the same emotional tone ("${emotions[0]}") across all ${decisions.length} scenes.`,
      evidence: `Emotions in order: ${emotions.join(", ")}.`,
    });
  }

  const score = Math.max(0, Math.min(100, 100 - penalty));

  return {
    score: {
      score,
      feedback: problems.length === 0 ? `Emotional tone varies across ${distinctCount} distinct feelings.` : problems[0]!.description,
      issue: problems.length > 0 ? problems[0]!.description : undefined,
      suggestion: problems.length > 0 ? "Introduce at least one scene with a contrasting emotional tone (e.g. tension before triumph)." : undefined,
    },
    problems,
  };
}

export function reviewNarrative(decisions: DirectorDecision[]): NarrativeReviewResult {
  const clarity = scoreNarrativeClarity(decisions);
  const flow = scoreEmotionalFlow(decisions);
  return {
    scores: { narrativeClarity: clarity.score, emotionalFlow: flow.score },
    problems: [...clarity.problems, ...flow.problems],
  };
}
