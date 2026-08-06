/** Editorial Review Engine V2 — Caption Reviewer (Phase 6).
 *
 *  Scores Text Usage across the whole video's planned captions (EditDecision.captions[],
 *  Phase 4's CaptionPlanner output). Two independent signals: how much of the video's runtime
 *  has some caption on screen (global density), and whether any single beat is overcrowded
 *  with simultaneous captions (local density) — a video can pass one check and fail the other.
 */
import type { DimensionScore, EDL, FlatBeat, Problem } from "./types";

export type CaptionReviewResult = { score: DimensionScore; problems: Problem[] };

const MAX_CAPTIONS_PER_BEAT = 3;
const HIGH_DENSITY_THRESHOLD = 0.6;

export function reviewCaptions(beats: FlatBeat[], edls: EDL[]): CaptionReviewResult {
  if (beats.length === 0) {
    return { score: { score: 50, feedback: "No beats to analyze." }, problems: [] };
  }

  const totalVideoDurationSec = edls.reduce((sum, edl) => sum + edl.totalDurationSec, 0);
  const captionScreenTimeSec = beats.reduce(
    (sum, b) => sum + b.decision.captions.reduce((s, c) => s + Math.max(0, c.endSec - c.startSec), 0),
    0
  );
  const density = totalVideoDurationSec > 0 ? captionScreenTimeSec / totalVideoDurationSec : 0;

  const problems: Problem[] = [];

  if (density > HIGH_DENSITY_THRESHOLD) {
    problems.push({
      type: "too_much_text",
      severity: density > 0.85 ? "high" : "medium",
      description: `Captions are on screen for an estimated ${Math.round(density * 100)}% of the video's runtime.`,
      evidence: `${captionScreenTimeSec.toFixed(1)}s of caption screen time across ${totalVideoDurationSec.toFixed(1)}s total.`,
    });
  }

  const overcrowdedBeats = beats.filter((b) => b.decision.captions.length > MAX_CAPTIONS_PER_BEAT);
  for (const b of overcrowdedBeats) {
    problems.push({
      type: "too_much_text",
      severity: "medium",
      sceneIndex: b.sceneIndex,
      beatId: b.decision.beatId,
      description: `Beat ${b.decision.beatId} has ${b.decision.captions.length} captions active — likely to overlap or overwhelm the viewer.`,
      evidence: b.decision.captions.map((c) => c.captionType).join(", "),
    });
  }

  const densityPenalty = density > HIGH_DENSITY_THRESHOLD ? Math.min(35, (density - HIGH_DENSITY_THRESHOLD) * 100) : 0;
  const overcrowdPenalty = Math.min(30, overcrowdedBeats.length * 8);
  const score = Math.max(0, Math.min(100, 100 - densityPenalty - overcrowdPenalty));

  const issues: string[] = [];
  if (densityPenalty > 0) issues.push(`text on screen ${Math.round(density * 100)}% of the runtime`);
  if (overcrowdedBeats.length > 0) issues.push(`${overcrowdedBeats.length} beat(s) with more than ${MAX_CAPTIONS_PER_BEAT} simultaneous captions`);

  return {
    score: {
      score,
      feedback: issues.length === 0 ? "Text usage looks reasonable — not overwhelming the visuals." : issues.join("; "),
      issue: issues.length > 0 ? issues.join("; ") : undefined,
      suggestion: issues.length > 0 ? "Reduce text duration or drop lower-priority captions on the busiest beats." : undefined,
    },
    problems,
  };
}
