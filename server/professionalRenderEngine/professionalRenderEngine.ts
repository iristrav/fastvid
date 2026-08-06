/** Professional Render Engine — top-level orchestrator (Phase 7).
 *
 *  The single public entry point this directory exposes, implementing the pipeline the spec
 *  names exactly: Approved EDL -> Professional Render Engine -> Render Plan -> FFmpeg Filter
 *  Graph Builder -> Encoder -> Final Video. Everything before "Render Plan" (which footage,
 *  which pacing, which captions/effects/transitions) is already decided by the Editorial
 *  Review Engine's ApprovedEDL — this function only executes it, via exportManager.ts's
 *  per-format planning/validation/encoding.
 *
 *  Gated by `professionalRenderEngineEnabled()` (default off — see featureFlags.ts), matching
 *  every other dormant module from this project's earlier phases. Nothing in videoPipeline.ts
 *  calls this; it stays unreachable from the live pipeline regardless of how this function
 *  itself behaves. */
import { professionalRenderEngineEnabled } from "./featureFlags";
import { exportVideo, type ExportDependencies } from "./exportManager";
import type { ExportRequest, ExportResult } from "./types";

export class ProfessionalRenderEngineDisabledError extends Error {
  constructor() {
    super("Professional Render Engine is disabled — set PROFESSIONAL_RENDER_ENGINE=true to enable it.");
    this.name = "ProfessionalRenderEngineDisabledError";
  }
}

/** Executes an Approved EDL into final video file(s), one per requested format. Throws
 *  `ProfessionalRenderEngineDisabledError` when the feature flag is off, rather than silently
 *  no-op'ing — a caller that reaches this function clearly intends to render, so a disabled
 *  flag should fail loudly, not produce a mysteriously-empty result. */
export async function renderApprovedEDL(request: ExportRequest, deps: ExportDependencies): Promise<ExportResult> {
  if (!professionalRenderEngineEnabled()) {
    throw new ProfessionalRenderEngineDisabledError();
  }
  return exportVideo(request, deps);
}
