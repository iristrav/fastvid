/** Editorial Review Engine V2 — feature flags (Phase 6).
 *
 *  Separate from sourcingPolicy.ts (Phase 3), cinematicEditingEngine/featureFlags.ts (Phase
 *  4), and aiDirector/featureFlags.ts (Phase 5) — each phase's dormant module gets its own
 *  small flag file rather than growing a shared one.
 *
 *  Named "V2" deliberately: server/editorialReviewEngine.ts (no directory, singular file)
 *  already exists and is LIVE in production — it critiques a video's actually-adopted clips
 *  after rendering completes (fire-and-forget, never blocks). This module is a genuinely
 *  different concern operating at a different pipeline stage (before rendering, on the EDL/
 *  Director output, potentially gating an "Approved EDL"), so "V2" here means the same thing
 *  it meant for visualMatchingV2 in Phase 3: a new, isolated, initially-dormant module next to
 *  an existing live one — not a rename or a replacement.
 *
 *  Defaults OFF, per "keep everything feature-flagged." Nothing in this directory is called
 *  from the live pipeline. */
export function editorialReviewEngineV2Enabled(): boolean {
  return process.env.EDITORIAL_REVIEW_ENGINE_V2 === "true";
}
