/** AI Director — orchestrator (Phase 5).
 *
 *  The single entrypoint that runs directorPlanner across every scene of a video, in order,
 *  threading each scene's DirectorDecision into the next scene's `previousDecisions` — this
 *  is what makes the variation/repetition checks in attentionManager.ts possible at all.
 *  Computes each scene's position in the overall timeline (elapsed seconds so far) so
 *  hook-window and pacing-relative-to-position decisions have real numbers to work with.
 *
 *  Returns a DirectorOutput: the full per-scene decision list plus the "future compatibility"
 *  aggregates (highlight moments, retention risks) that Thumbnail/Shorts/Highlight/Trailer
 *  generators (Phase 6+) can read directly instead of re-deriving them from raw decisions.
 */
import { planDirectorDecision } from "./directorPlanner";
import { HOOK_WINDOW_SEC } from "./attentionManager";
import type { Scene } from "../pipeline/types";
import type { VideoContext, VisualIntent } from "../visualMatchingV2/types";
import type { DirectorContext, DirectorDecision, DirectorOutput, HighlightMoment, RetentionRiskEntry } from "./types";

export type SceneInput = {
  scene: Scene;
  /** This scene's beats' already-extracted Visual Intents (Phase 3) — the Director never
   *  triggers that extraction itself, only consumes its output. */
  beatIntents: VisualIntent[];
  durationSec: number;
};

const HIGH_ENERGY_EMOTIONS: DirectorDecision["emotion"][] = ["triumph", "excitement", "awe"];

function buildHighlightMoments(decisions: DirectorDecision[]): HighlightMoment[] {
  const out: HighlightMoment[] = [];
  for (const d of decisions) {
    const suggestedFor = new Set<HighlightMoment["suggestedFor"][number]>();
    const reasons: string[] = [];

    if (d.narrativeFunction === "climax") {
      suggestedFor.add("highlight_reel");
      suggestedFor.add("trailer");
      reasons.push("is a narrative climax");
    }
    if (HIGH_ENERGY_EMOTIONS.includes(d.emotion)) {
      suggestedFor.add("thumbnail");
      suggestedFor.add("shorts");
      reasons.push(`carries a high-impact emotion ("${d.emotion}")`);
    }
    if (d.hookGuidance.isHookSegment && d.narrativeFunction !== "establish") {
      suggestedFor.add("trailer");
      reasons.push("is a strong moment within the video's opening hook");
    }

    if (suggestedFor.size > 0) {
      out.push({
        sceneIndex: d.sceneIndex,
        reason: `Scene ${reasons.join(" and ")} — candidate for ${[...suggestedFor].join(", ")}.`,
        suggestedFor: [...suggestedFor],
      });
    }
  }
  return out;
}

/**
 * Runs the AI Director across an entire video's scenes, in order. `scenes` should be in
 * final script order — the Director relies on that order for hook-window detection and
 * cross-scene variation checks.
 */
export function runAIDirector(scenes: SceneInput[], videoContext?: VideoContext): DirectorOutput {
  const totalVideoDurationSec = scenes.reduce((sum, s) => sum + s.durationSec, 0);
  const decisions: DirectorDecision[] = [];
  let cursor = 0;

  for (let i = 0; i < scenes.length; i++) {
    const input = scenes[i]!;
    const context: DirectorContext = {
      scene: input.scene,
      beatIntents: input.beatIntents,
      videoContext,
      sceneIndex: i,
      totalScenes: scenes.length,
      sceneStartSec: cursor,
      sceneDurationSec: input.durationSec,
      totalVideoDurationSec,
      previousDecisions: decisions,
    };
    decisions.push(planDirectorDecision(context));
    cursor += input.durationSec;
  }

  const retentionRisks: RetentionRiskEntry[] = decisions
    .filter((d) => d.retentionRisk.isAtRisk)
    .map((d) => ({ ...d.retentionRisk, sceneIndex: d.sceneIndex }));

  return {
    decisions,
    hookWindowSec: HOOK_WINDOW_SEC,
    highlightMoments: buildHighlightMoments(decisions),
    retentionRisks,
    totalVideoDurationSec,
  };
}
