/** AI Director — Cinematic Editing Engine integration (Phase 5).
 *
 *  The one place that knows how to translate a DirectorDecision into the narrow
 *  DirectorGuidance shape Cinematic Editing Engine's planners optionally accept (see
 *  cinematicEditingEngine/types.ts's DirectorGuidance and its own doc comment on why the two
 *  modules don't share a type directly — avoiding a circular module dependency). Cinematic
 *  Editing Engine has zero knowledge of aiDirector; this adapter lives on the aiDirector side
 *  of the boundary.
 */
import { directorEmotionToPacingTone } from "./narrativeAnalysis";
import type { DirectorDecision } from "./types";
import type { DirectorGuidance } from "../cinematicEditingEngine/types";

/**
 * Adapts a scene-level DirectorDecision into the DirectorGuidance shape a Cinematic Editing
 * Engine planner call (per beat, within that scene) can optionally consult. Callers pass the
 * same DirectorGuidance object to every beat in the scene; ShotPlanner uses the beat's own
 * `beatIndexInScene` to pick the right shotOrder entry.
 */
export function toDirectorGuidance(decision: DirectorDecision): DirectorGuidance {
  return {
    pacingTone: directorEmotionToPacingTone(decision.emotion),
    shotOrder: decision.shotOrder.map((item) => ({ order: item.order, shotType: item.shotType })),
  };
}
