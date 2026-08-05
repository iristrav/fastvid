/** Cinematic Editing Engine — Timeline Planner (Phase 4).
 *
 *  Extends Phase 2's Timeline/TimelineEntry (server/pipeline/types.ts) — which only carries a
 *  scene-level startSec/endSec — down to clip level: exactly when each candidate's clip
 *  starts, ends, and how it's trimmed within a beat that may need more than one shot.
 *
 *  Reuses Phase 3's planSubBeatCuts (visualMatchingV2/timingAlignment.ts) verbatim for the cut
 *  boundaries themselves — that function already implements "use word timestamps if
 *  available, otherwise estimate proportionally," which is exactly what clip-level timing
 *  needs here too. This module's only new contribution is turning those cut boundaries into
 *  ClipInstructions bound to actual candidates (with trim points), not a second timing engine.
 */
import { planSubBeatCuts } from "../visualMatchingV2/timingAlignment";
import type { CandidateAsset } from "../visualMatchingV2/types";
import type { TtsWordTiming } from "../voiceTtsAlignment";
import type { ClipInstruction } from "./types";

/**
 * Plans one ClipInstruction per candidate, positioned across the beat's voice timeline.
 * `candidates` should already be in the order they're meant to appear (ShotPlanner/ranking
 * upstream decide selection and order; this only decides timing/trim). Returns one
 * ClipInstruction per candidate — pass a single-element array for a beat that only needs one
 * shot.
 */
export function planClipTiming(
  beatText: string,
  candidates: CandidateAsset[],
  beatVoiceStartSec: number,
  beatVoiceDurationSec: number,
  beatWords?: TtsWordTiming[]
): ClipInstruction[] {
  if (candidates.length === 0) return [];

  const cuts = planSubBeatCuts(beatText, candidates.length, beatVoiceStartSec, beatVoiceDurationSec, beatWords);

  return cuts.map((cut, i) => {
    const candidate = candidates[i]!;
    const clipDurationSec = cut.endSec - cut.startSec;
    const trimEndSec =
      candidate.assetType === "video" && candidate.duration != null
        ? Math.min(clipDurationSec, candidate.duration)
        : clipDurationSec;

    return {
      candidateId: candidate.candidateId,
      assetType: candidate.assetType,
      localPath: candidate.localPath,
      remoteUrl: candidate.remoteUrl,
      trimStartSec: 0,
      trimEndSec,
      startSec: cut.startSec,
      endSec: cut.endSec,
      timingSource: cut.source,
    };
  });
}
