/** AI Director — Attention Manager (Phase 5).
 *
 *  Covers everything about where the viewer's attention is likely to go or drift:
 *  EDITORIAL PRINCIPLES (avoid repeating the same visual style/shot, avoid visual fatigue) and
 *  INTELLIGENT VARIATION (vary shot types, duration, transitions across scenes) are both
 *  "compare this scene's plan against previousDecisions" checks; ATTENTION MANAGEMENT,
 *  HOOK OPTIMIZATION, and RETENTION STRATEGY are all "what should the editor do about a
 *  moment that's likely to lose the viewer" checks. Grouped together because they share the
 *  same underlying question and the same previousDecisions input — splitting them into
 *  separate files would mean re-deriving the same repetition checks twice.
 */
import type { Scene } from "../pipeline/types";
import type {
  AttentionRecommendation,
  DirectorContext,
  DirectorDecision,
  HookGuidance,
  NarrativeFunction,
  PacingLabel,
  RetentionRisk,
  VisualStrategy,
} from "./types";
import { averageSceneDurationSec } from "./pacingAdvisor";

export const HOOK_WINDOW_SEC = 30;
const REPETITION_LOOKBACK = 2;

function recentDecisions(context: DirectorContext, n: number): DirectorDecision[] {
  return context.previousDecisions.slice(-n);
}

// ─── Editorial principles + intelligent variation ────────────────────────────────

/**
 * Checks this scene's plan against the last few scenes' decisions and recommends changes
 * where the plan risks repetition or visual fatigue. Never invents a recommendation without a
 * concrete repeated/at-risk pattern behind it.
 */
export function buildAttentionRecommendations(
  context: DirectorContext,
  narrativeFunction: NarrativeFunction,
  visualStrategy: VisualStrategy,
  pacing: PacingLabel
): AttentionRecommendation[] {
  const out: AttentionRecommendation[] = [];
  const recent = recentDecisions(context, REPETITION_LOOKBACK);

  if (recent.length === REPETITION_LOOKBACK && recent.every((d) => d.visualStrategy === visualStrategy)) {
    out.push({
      type: "change_shot_type",
      reason: `The same visual strategy ("${visualStrategy}") has been used for the last ${REPETITION_LOOKBACK} scenes in a row — risks visual fatigue.`,
    });
  }

  if (recent.length === REPETITION_LOOKBACK && recent.every((d) => d.pacing === "slow") && pacing === "slow") {
    out.push({
      type: "introduce_contrast",
      reason: "Three consecutive slow-paced scenes (including this one) — a contrast beat would re-engage the viewer.",
    });
  }

  if (recent.length === REPETITION_LOOKBACK && recent.every((d) => d.transitionStyle === recent[0]!.transitionStyle)) {
    out.push({
      type: "add_emphasis",
      reason: `Transition style hasn't varied across the last ${REPETITION_LOOKBACK} scenes ("${recent[0]!.transitionStyle}") — worth breaking the pattern.`,
    });
  }

  const avgDuration = averageSceneDurationSec(context);
  if (avgDuration > 0 && context.sceneDurationSec > avgDuration * 1.3 && narrativeFunction === "explain") {
    out.push({
      type: "insert_supporting_visual",
      reason: `Scene runs longer than average (${context.sceneDurationSec.toFixed(1)}s vs. ~${avgDuration.toFixed(1)}s) and is a plain explanatory beat — a supporting visual keeps it from feeling static.`,
    });
  }

  if (recent.length > 0 && recent[recent.length - 1]!.energyTrend === "decreasing" && narrativeFunction !== "resolve") {
    out.push({
      type: "increase_energy",
      reason: "The previous scene's energy was decreasing and this isn't the story's resolution — energy should recover here, not keep falling.",
    });
  }

  return out;
}

// ─── Hook optimization (first 30 seconds) ────────────────────────────────────────

export function buildHookGuidance(context: DirectorContext): HookGuidance {
  const isHookSegment = context.sceneStartSec < HOOK_WINDOW_SEC;
  if (!isHookSegment) {
    return {
      isHookSegment: false,
      recommendations: [],
      reason: `Scene starts at ${context.sceneStartSec.toFixed(1)}s, after the ${HOOK_WINDOW_SEC}-second hook window — no hook-specific guidance applies.`,
    };
  }
  return {
    isHookSegment: true,
    recommendations: [
      "Increase energy.",
      "Use faster cuts.",
      "Add more visual variety.",
      "Open with the strongest available visual.",
    ],
    reason: `Scene starts at ${context.sceneStartSec.toFixed(1)}s, within the first ${HOOK_WINDOW_SEC} seconds where viewers decide whether to keep watching.`,
  };
}

// ─── Retention strategy (boring-section detection) ───────────────────────────────

export function buildRetentionRisk(
  context: DirectorContext,
  narrativeFunction: NarrativeFunction,
  visualStrategy: VisualStrategy,
  pacing: PacingLabel,
  scene: Scene
): RetentionRisk {
  const factors: string[] = [];
  const recommendations: string[] = [];

  const avgDuration = averageSceneDurationSec(context);
  if (avgDuration > 0 && context.sceneDurationSec > avgDuration * 1.3) {
    factors.push(`runs longer than average (${context.sceneDurationSec.toFixed(1)}s vs. ~${avgDuration.toFixed(1)}s)`);
    recommendations.push("Increase energy or shorten the scene.");
  }

  if (narrativeFunction === "explain" && pacing !== "fast") {
    factors.push("is a plain explanatory beat with no faster pacing to compensate");
    recommendations.push("Insert a supporting visual to break up the explanation.");
  }

  const recent = recentDecisions(context, REPETITION_LOOKBACK);
  if (recent.length === REPETITION_LOOKBACK && recent.every((d) => d.visualStrategy === visualStrategy)) {
    factors.push(`repeats the same visual strategy ("${visualStrategy}") as the last ${REPETITION_LOOKBACK} scenes`);
    recommendations.push("Change shot type or visual strategy for variety.");
  }

  const entityCount = new Set(
    context.beatIntents.flatMap((i) => [...i.people, ...i.companies, ...i.brands, ...i.objects].map((s) => s.toLowerCase()))
  ).size;
  if (entityCount === 0 && !scene.statCallout) {
    factors.push("has no named entities or highlighted statistic to anchor viewer interest");
    recommendations.push("Add a contrast beat, statistic, or named example.");
  }

  const isAtRisk = factors.length >= 2;

  return {
    isAtRisk,
    reason: isAtRisk
      ? `Scene ${factors.join("; and ")} — combined, these raise the risk of losing viewer attention.`
      : "No combination of risk factors (long duration, plain explanation, repeated strategy, low content density) found together.",
    recommendations: isAtRisk ? recommendations : [],
  };
}
