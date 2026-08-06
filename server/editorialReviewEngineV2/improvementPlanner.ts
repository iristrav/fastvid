/** Editorial Review Engine V2 — Improvement Planner (Phase 6).
 *
 *  Turns every detected Problem into a structured, human-readable Recommendation, and — only
 *  for the subset of problems whose fix is mechanically executable against the EDL alone
 *  (shot type, camera movement, transition, caption duration) — an AutoFix as well. Problems
 *  that require new footage (repeated_footage, off_topic_visual) get a Recommendation only,
 *  never an AutoFix: fixing those means searching for different media, and this engine
 *  "should NOT search media," the same boundary the AI Director holds for itself.
 */
import type { AutoFix, AutoFixType, EDL, Problem, Recommendation, RecommendationPriority } from "./types";

const PRIORITY_BY_SEVERITY: Record<Problem["severity"], RecommendationPriority> = { high: "high", medium: "medium", low: "low" };

function sceneLabel(problem: Problem): string {
  return problem.sceneIndex !== undefined ? `Scene ${problem.sceneIndex}` : "the video";
}

/** Matches the Phase 6 spec's own example phrasing style for each problem type. */
function recommendationText(problem: Problem): string {
  const scene = sceneLabel(problem);
  switch (problem.type) {
    case "repeated_footage":
      return `Replace the duplicate visual in ${scene} with alternate footage.`;
    case "repeated_camera_movement":
      return `Reduce camera movement repetition in ${scene} — vary the movement type.`;
    case "repeated_transition":
      return `Replace the repeated transition in ${scene} with a simple cut.`;
    case "weak_opening":
      return `Strengthen the opening — use a stronger establishing visual and faster pacing in ${scene}.`;
    case "weak_ending":
      return `Add a resolving beat at the end of the video (${scene}) to close the story.`;
    case "long_static_section":
      return `Increase pacing in ${scene}.`;
    case "low_visual_variety":
      return `Use a close-up instead of another wide shot somewhere in ${scene === "the video" ? "the video" : scene}.`;
    case "low_emotional_variation":
      return "Introduce a scene with a contrasting emotional tone to break up the flat emotional arc.";
    case "too_much_text":
      return `Reduce text duration in ${scene}.`;
    case "too_little_movement":
      return `Add supporting B-roll or camera movement in ${scene}.`;
    case "poor_timing":
      return `Review beat timing in ${scene} — durations read as too uniform or too erratic.`;
    case "off_topic_visual":
      return `Replace ${scene}'s flagged beat with visuals that better match the narration.`;
    case "visual_continuity_issue":
      return `Review ${scene} for continuity — replace mismatched footage or add a bridging transition.`;
    default:
      return `Review ${scene} for the flagged issue.`;
  }
}

export function planRecommendations(problems: Problem[]): Recommendation[] {
  return problems.map((problem) => ({
    problemType: problem.type,
    sceneIndex: problem.sceneIndex,
    beatId: problem.beatId,
    recommendation: recommendationText(problem),
    priority: PRIORITY_BY_SEVERITY[problem.severity],
    reason: problem.description,
  }));
}

/** Looks up the actual current field value for a beat this fix would change, so `before`
 *  reflects the real EDL state rather than a guessed default. Returns undefined when the
 *  scene/beat can't be found (caller skips generating a fix in that case). */
function currentFieldValue(edls: EDL[], sceneIndex: number, beatId: string, fixType: AutoFixType): string | number | undefined {
  const edl = edls.find((e) => e.sceneIndex === sceneIndex);
  const decision = edl?.decisions.find((d) => d.beatId === beatId);
  if (!decision) return undefined;
  switch (fixType) {
    case "change_shot_type":
      return decision.shot.shotType;
    case "change_camera_movement":
      return decision.camera.movement;
    case "change_transition":
      return decision.transitionIn.type;
    case "reduce_text_duration":
      return decision.captions.reduce((sum, c) => sum + Math.max(0, c.endSec - c.startSec), 0);
  }
}

/** Builds AutoFix entries for the subset of problems this engine can mechanically fix on its
 *  own. Only ever reads `edls` (to know the real current value) — never mutates it; applying
 *  the fix is a separate, explicit step (autoFixApply.ts). */
export function planAutoFixes(problems: Problem[], edls: EDL[]): AutoFix[] {
  const fixes: AutoFix[] = [];

  for (const problem of problems) {
    if (problem.sceneIndex === undefined || problem.beatId === undefined) continue;

    if (problem.type === "long_static_section" || problem.type === "low_visual_variety") {
      const before = currentFieldValue(edls, problem.sceneIndex, problem.beatId, "change_shot_type");
      if (before !== undefined) {
        fixes.push({
          type: "change_shot_type",
          sceneIndex: problem.sceneIndex,
          beatId: problem.beatId,
          description: `Change beat ${problem.beatId}'s shot type to break up the repetition.`,
          field: "shot.shotType",
          before,
          after: before === "close_up" ? "medium" : "close_up",
          reversible: true,
          reason: problem.description,
        });
      }
    }

    if (problem.type === "repeated_camera_movement" || problem.type === "too_little_movement") {
      const before = currentFieldValue(edls, problem.sceneIndex, problem.beatId, "change_camera_movement");
      if (before !== undefined) {
        fixes.push({
          type: "change_camera_movement",
          sceneIndex: problem.sceneIndex,
          beatId: problem.beatId,
          description: `Change beat ${problem.beatId}'s camera movement for variety.`,
          field: "camera.movement",
          before,
          after: before === "camera_hold" ? "slow_push" : "camera_hold",
          reversible: true,
          reason: problem.description,
        });
      }
    }

    if (problem.type === "repeated_transition") {
      const before = currentFieldValue(edls, problem.sceneIndex, problem.beatId, "change_transition");
      if (before !== undefined) {
        fixes.push({
          type: "change_transition",
          sceneIndex: problem.sceneIndex,
          beatId: problem.beatId,
          description: `Replace beat ${problem.beatId}'s repeated transition with a simple cut.`,
          field: "transitionIn.type",
          before,
          after: "cut",
          reversible: true,
          reason: problem.description,
        });
      }
    }

    if (problem.type === "too_much_text") {
      const before = currentFieldValue(edls, problem.sceneIndex, problem.beatId, "reduce_text_duration");
      if (typeof before === "number" && before > 0) {
        fixes.push({
          type: "reduce_text_duration",
          sceneIndex: problem.sceneIndex,
          beatId: problem.beatId,
          description: `Reduce beat ${problem.beatId}'s total caption duration by half.`,
          field: "captions[].duration",
          before,
          after: before / 2,
          reversible: true,
          reason: problem.description,
        });
      }
    }
  }

  return fixes;
}
