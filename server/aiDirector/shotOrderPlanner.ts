/** AI Director — Shot Order Planner (Phase 5).
 *
 *  Builds the scene's recommended shot-type progression — e.g. "1 Establishing, 2 Medium,
 *  3 Close-up, 4 Reaction, 5 Detail" from the Phase 5 output example. This is a scene-wide
 *  editorial template ("audience should first understand context before focusing on
 *  details"), sized to however many beats the scene actually has.
 *
 *  Reuses Cinematic Editing Engine's ShotType vocabulary directly (not a parallel one) — this
 *  is a RECOMMENDATION Phase 4's own ShotPlanner can read as guidance (see
 *  cinematicEditingEngine/shotPlanner.ts's optional directorGuidance parameter), not a
 *  replacement for its per-beat, per-candidate decision.
 */
import type { ShotType } from "../cinematicEditingEngine/types";
import type { NarrativeFunction, ShotOrderItem, VisualStrategy } from "./types";

/** Canonical 5-step progressions per narrative function. Cycled/truncated to fit the scene's
 *  actual beat count — a 3-beat "explain" scene gets the first 3 steps; an 8-beat one repeats
 *  the pattern. */
const TEMPLATES: Record<NarrativeFunction, ShotType[]> = {
  establish: ["establishing", "wide", "medium", "medium", "close_up"],
  explain: ["medium", "close_up", "detail", "medium", "close_up"],
  contrast: ["medium", "cutaway", "medium", "cutaway", "close_up"],
  reveal: ["wide", "medium", "close_up", "detail", "reaction"],
  climax: ["wide", "medium", "close_up", "reaction", "detail"],
  resolve: ["medium", "wide", "establishing", "wide", "medium"],
  transition: ["cutaway", "b_roll", "cutaway", "b_roll", "cutaway"],
};

const SHOT_REASONS: Record<ShotType, string> = {
  establishing: "Opens the scene by orienting the viewer to where/what this is.",
  wide: "Shows the broader context or environment around the subject.",
  medium: "Keeps the subject in frame at a natural, balanced distance.",
  close_up: "Draws focus onto the subject's expression or detail.",
  extreme_close_up: "Isolates a single detail for maximum emphasis.",
  detail: "Shows a specific object or action closely.",
  reaction: "Shows how others respond, adding a human dimension.",
  cutaway: "Bridges the narration with supplementary coverage.",
  b_roll: "Provides supporting visual coverage of the topic.",
  archive_footage: "Grounds the scene in real historical or archival material.",
  overlay_shot: "Carries a graphic overlay (map/chart/timeline) rather than a literal shot.",
};

function cycleToLength(template: ShotType[], length: number): ShotType[] {
  if (length <= 0) return [];
  return Array.from({ length }, (_, i) => template[i % template.length]!);
}

/** Applies a visualStrategy-specific override to the last slot of the template — the
 *  strategy's own coverage need should show up somewhere in the recommended progression, even
 *  when the narrative-function template wouldn't otherwise include it. Only touches the final
 *  slot so the template's opening structure (how the scene is entered) is never disturbed. */
function applyStrategyOverride(shots: ShotType[], strategy: VisualStrategy): { shots: ShotType[]; overrideReason: string | null } {
  if (shots.length === 0) return { shots, overrideReason: null };
  const lastIndex = shots.length - 1;

  if (strategy === "archive_footage" && !shots.includes("archive_footage")) {
    const next = [...shots];
    next[lastIndex] = "archive_footage";
    return { shots: next, overrideReason: "Scene relies on archival footage — worked into the shot order." };
  }
  if ((strategy === "map" || strategy === "chart" || strategy === "timeline") && !shots.includes("overlay_shot")) {
    const next = [...shots];
    next[lastIndex] = "overlay_shot";
    return { shots: next, overrideReason: `Scene relies on a ${strategy} graphic overlay rather than a literal final shot.` };
  }
  if ((strategy === "interview" || strategy === "keynote_or_stage_footage") && !shots.includes("reaction") && shots.length > 1) {
    const next = [...shots];
    next[lastIndex] = "reaction";
    return { shots: next, overrideReason: "Scene features a person on camera — audience/listener reaction rounds it out." };
  }

  return { shots, overrideReason: null };
}

/**
 * Builds the recommended shot-type progression for a scene with `beatCount` beats, given its
 * narrative function and visual strategy.
 */
export function planShotOrder(narrativeFunction: NarrativeFunction, visualStrategy: VisualStrategy, beatCount: number): ShotOrderItem[] {
  const template = TEMPLATES[narrativeFunction];
  const sized = cycleToLength(template, beatCount);
  const { shots, overrideReason } = applyStrategyOverride(sized, visualStrategy);

  return shots.map((shotType, i) => ({
    order: i + 1,
    shotType,
    reason: i === shots.length - 1 && overrideReason ? overrideReason : SHOT_REASONS[shotType],
  }));
}
