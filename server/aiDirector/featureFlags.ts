/** AI Director — feature flags (Phase 5).
 *
 *  Separate from both sourcingPolicy.ts (Phase 3's sourcing concern) and
 *  cinematicEditingEngine/featureFlags.ts (Phase 4's presentation-decision concern) — the AI
 *  Director is a third, distinct concern (scene-level narrative/editorial judgment), so it
 *  gets its own small policy file, same reasoning as Phase 4's.
 *
 *  Defaults OFF, per "keep everything feature-flagged." Nothing in this directory is called
 *  from the live render pipeline, and nothing in cinematicEditingEngine/ requires it — the
 *  optional directorGuidance hook (see cinematicEditingEngine/types.ts) is additive and every
 *  existing caller that omits it keeps its exact current behavior. */
export function aiDirectorEnabled(): boolean {
  return process.env.AI_DIRECTOR === "true";
}
