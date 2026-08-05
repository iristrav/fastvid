/**
 * Media Search stage — single responsibility: receive a search request, find candidate assets,
 * return ranked media. No rendering happens here.
 *
 * Adapter around the currently-active production search path,
 * searchCuratedCandidatesForBeat (server/curatedMediaSourcing.ts) — a pure search+rank
 * function (no clip materialization/download; that's a separate, hybrid function
 * (fetchCuratedArchiveBeatClip) this stage deliberately does NOT wrap, since it crosses into
 * "prepares a file" territory).
 *
 * Note: server/visualMatchingV2/ (esp. v2Pipeline.ts) already independently implements this
 * exact same "search request in, ranked candidates out" contract, explicitly documented as
 * side-effect-free and network-call-free where possible — but it's currently unwired dead code
 * (gated off, never called from the live pipeline). This stage wraps the live path only;
 * swapping in visualMatchingV2 is a Phase 3-or-later decision, not attempted here.
 */
import { searchCuratedCandidatesForBeat } from "../../curatedMediaSourcing";
import { PIPELINE_ERROR } from "@shared/appErrors";
import { runStage, type MediaSearchRequest, type MediaSearchResult, type StageResult } from "../types";

export async function searchMedia(
  input: MediaSearchRequest
): Promise<StageResult<MediaSearchResult>> {
  return runStage(PIPELINE_ERROR.GENERIC, true, async () => {
    const candidates = await searchCuratedCandidatesForBeat(
      input.beat,
      input.scene,
      input.usedAssetIds,
      input.usedStorageUrls,
      input.videoTitle,
      { varietySeed: input.varietySeed, videoLength: input.videoLength }
    );
    return { candidates };
  });
}
