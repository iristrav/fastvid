/** Editorial Review Engine V2 — Pacing Reviewer (Phase 6).
 *
 *  Scores Pacing from the actual planned clip durations and camera movement across the whole
 *  video (EditDecision.clip/camera, Phase 4's output) — not from AI Director's per-scene
 *  pacing LABEL (Phase 5's "slow"/"medium"/"fast" is itself a recommendation going INTO
 *  Cinematic Editing Engine; this reviewer checks what Phase 4 actually did with it,
 *  end to end, the same "verify the plan, don't just trust the intent" spirit as
 *  transitionReviewer.ts).
 *
 *  The duration coefficient-of-variation approach mirrors the legacy engine's scoreRhythm()
 *  (same target band, same extreme-duration thresholds) — reused as an algorithm shape, not a
 *  literal import, since the legacy function reads a raw `number[][]` (post-render beat
 *  durations) while this one reads durations directly off EditDecision.clip.
 */
import type { DimensionScore, FlatBeat, Problem } from "./types";

export type PacingReviewResult = { score: DimensionScore; problems: Problem[] };

const STATIC_RUN_THRESHOLD = 3;
const HOLD_FRACTION_THRESHOLD = 0.85;

export function reviewPacing(beats: FlatBeat[]): PacingReviewResult {
  if (beats.length === 0) {
    return { score: { score: 50, feedback: "No beats to analyze." }, problems: [] };
  }

  const problems: Problem[] = [];
  const durations = beats.map((b) => Math.max(0, b.decision.clip.endSec - b.decision.clip.startSec)).filter((d) => d > 0);

  let cvPenalty = 0;
  let extremePenalty = 0;
  let cv = 0;
  if (durations.length >= 3) {
    const mean = durations.reduce((a, b) => a + b, 0) / durations.length;
    const std = Math.sqrt(durations.map((d) => (d - mean) ** 2).reduce((a, b) => a + b, 0) / durations.length);
    cv = mean > 0 ? std / mean : 0;
    cvPenalty = cv < 0.15 ? (0.15 - cv) * 120 : cv > 0.55 ? (cv - 0.55) * 80 : 0;

    const extremeLong = durations.filter((d) => d > 12).length;
    const extremeShort = durations.filter((d) => d < 0.8).length;
    extremePenalty = (extremeLong + extremeShort) * 3;

    if (cv < 0.15) {
      problems.push({
        type: "poor_timing",
        severity: "low",
        description: "Clip durations are nearly uniform across the video — pacing may feel monotone.",
        evidence: `Coefficient of variation ${cv.toFixed(2)} (target 0.20-0.45), mean ${mean.toFixed(1)}s.`,
      });
    } else if (cv > 0.55) {
      problems.push({
        type: "poor_timing",
        severity: "medium",
        description: "Clip durations vary erratically across the video.",
        evidence: `Coefficient of variation ${cv.toFixed(2)} (target 0.20-0.45), mean ${mean.toFixed(1)}s.`,
      });
    }
  }

  // Long static section detection: consecutive same-scene beats with camera_hold AND the
  // same shot type read as visually static, even if each individual clip's duration is fine.
  let curRun = 1;
  for (let i = 1; i < beats.length; i++) {
    const prev = beats[i - 1]!;
    const cur = beats[i]!;
    const bothStatic = cur.decision.camera.movement === "camera_hold" && prev.decision.camera.movement === "camera_hold";
    const sameShot = cur.decision.shot.shotType === prev.decision.shot.shotType;
    const sameScene = cur.sceneIndex === prev.sceneIndex;
    if (sameScene && bothStatic && sameShot) {
      curRun++;
      if (curRun === STATIC_RUN_THRESHOLD) {
        problems.push({
          type: "long_static_section",
          severity: "medium",
          sceneIndex: cur.sceneIndex,
          beatId: cur.decision.beatId,
          description: `${curRun}+ consecutive static, same-shot-type beats in scene ${cur.sceneIndex}.`,
          evidence: `Beats ${beats[i - curRun + 1]!.decision.beatId}..${cur.decision.beatId} are all camera_hold, shot type "${cur.decision.shot.shotType}".`,
        });
      }
    } else {
      curRun = 1;
    }
  }

  // Repeated non-hold camera movement: the same active movement (e.g. slow_push) three or
  // more times in a row reads as a repetitive camera habit, distinct from a static run (which
  // is about camera_hold specifically) — camera_hold repeating is "too little movement," an
  // active movement repeating is "repeated_camera_movement."
  let movementRun = 1;
  for (let i = 1; i < beats.length; i++) {
    const prev = beats[i - 1]!;
    const cur = beats[i]!;
    const sameActiveMovement =
      cur.decision.camera.movement === prev.decision.camera.movement && cur.decision.camera.movement !== "camera_hold";
    if (sameActiveMovement && cur.sceneIndex === prev.sceneIndex) {
      movementRun++;
      if (movementRun === STATIC_RUN_THRESHOLD) {
        problems.push({
          type: "repeated_camera_movement",
          severity: "low",
          sceneIndex: cur.sceneIndex,
          beatId: cur.decision.beatId,
          description: `${movementRun}+ consecutive "${cur.decision.camera.movement}" camera movements in scene ${cur.sceneIndex}.`,
          evidence: `Beats ${beats[i - movementRun + 1]!.decision.beatId}..${cur.decision.beatId} all use camera movement "${cur.decision.camera.movement}".`,
        });
      }
    } else {
      movementRun = 1;
    }
  }

  const holdFraction = beats.filter((b) => b.decision.camera.movement === "camera_hold").length / beats.length;
  if (holdFraction > HOLD_FRACTION_THRESHOLD) {
    problems.push({
      type: "too_little_movement",
      severity: "low",
      description: `${Math.round(holdFraction * 100)}% of beats use camera_hold with no movement.`,
      evidence: `${beats.filter((b) => b.decision.camera.movement === "camera_hold").length}/${beats.length} beats are static.`,
    });
  }

  const staticSectionPenalty = problems.filter((p) => p.type === "long_static_section").length * 6;
  const movementRepeatPenalty = problems.filter((p) => p.type === "repeated_camera_movement").length * 4;
  const holdPenalty = holdFraction > HOLD_FRACTION_THRESHOLD ? Math.min(15, (holdFraction - HOLD_FRACTION_THRESHOLD) * 100) : 0;

  const score = Math.max(0, Math.min(100, 100 - cvPenalty - extremePenalty - staticSectionPenalty - movementRepeatPenalty - holdPenalty));

  const issues = problems.map((p) => p.description);

  return {
    score: {
      score,
      feedback: issues.length === 0 ? `Pacing looks healthy (duration CV=${cv.toFixed(2)}).` : issues.join("; "),
      issue: issues.length > 0 ? issues.join("; ") : undefined,
      suggestion: problems.some((p) => p.type === "long_static_section")
        ? "Increase pacing in the flagged scene — vary shot type or add camera movement."
        : problems.some((p) => p.type === "repeated_camera_movement")
        ? "Reduce camera movement repetition — vary the movement type across beats."
        : holdFraction > HOLD_FRACTION_THRESHOLD
        ? "Introduce more camera movement across the video."
        : undefined,
    },
    problems,
  };
}
