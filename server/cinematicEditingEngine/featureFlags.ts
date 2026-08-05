/** Cinematic Editing Engine — feature flags (Phase 4).
 *
 *  Kept separate from sourcingPolicy.ts on purpose: that file gates visual-*sourcing*
 *  decisions (Phase 3, "what footage to find"). This is a distinct concern — editing
 *  decisions about footage that's already been found — so it gets its own small policy
 *  file rather than growing an unrelated one.
 *
 *  Every flag here defaults OFF, per the Phase 4 instruction to keep all new functionality
 *  behind feature flags until validated. Nothing in this directory is called from the live
 *  render pipeline (videoPipeline.ts / server/pipeline/) — it only produces an Edit Decision
 *  List (EDL), never renders — so these flags currently gate nothing risky; they exist so
 *  that wiring the EDL into a real renderer (Phase 5) has an established on/off switch from
 *  day one, matching the same pattern used for visualMatchingV2 in Phase 3. */
export function cinematicEditingEngineEnabled(): boolean {
  return process.env.CINEMATIC_EDITING_ENGINE === "true";
}
