/** Visual Matching Engine V2 — central candidate deduplication.
 *  Sole responsibility: collapse candidates that are the same underlying asset, regardless
 *  of which source returned them, into one entry. Used exclusively by the Retrieval
 *  Orchestrator — no source adapter does its own deduplication.
 *
 *  Key strategy, in priority order: exact candidateId match, then remoteUrl match, then
 *  content hash (when present in metadata). Perceptual hashing for near-duplicate images
 *  is a documented future extension — not implemented here — so a new key type can be
 *  added to `DuplicateGroup.matchedOn` without touching the dedup algorithm's shape. */

import type { CandidateAsset, DuplicateGroup } from "./types";

function contentHashOf(candidate: CandidateAsset): string | null {
  const metadata = candidate.metadata as Record<string, unknown> | null | undefined;
  const hash = metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>).hash : undefined;
  return typeof hash === "string" && hash.length > 0 ? hash : null;
}

/** Computes the dedup key for one candidate, in priority order: remoteUrl is the
 *  strongest signal across sources (same hosted file), then a content hash if the
 *  adapter provided one, then candidateId as the last resort (only catches exact
 *  re-fetches of the same source+id, not cross-source duplicates). */
function dedupKeyOf(candidate: CandidateAsset): { key: string; matchedOn: DuplicateGroup["matchedOn"] } {
  if (candidate.remoteUrl) return { key: `url:${candidate.remoteUrl}`, matchedOn: "remoteUrl" };
  const hash = contentHashOf(candidate);
  if (hash) return { key: `hash:${hash}`, matchedOn: "hash" };
  return { key: `id:${candidate.candidateId}`, matchedOn: "candidateId" };
}

export type DedupResult = {
  deduped: CandidateAsset[];
  duplicateGroups: DuplicateGroup[];
};

/** Deduplicates a flat candidate list. The first candidate seen for a given key is kept;
 *  source-phase order (own archive first, then external sources) means archive/embedding
 *  hits are preferred survivors over external duplicates of the same asset. */
export function dedupeCandidates(candidates: CandidateAsset[]): DedupResult {
  const seen = new Map<string, { kept: CandidateAsset; matchedOn: DuplicateGroup["matchedOn"]; dropped: string[] }>();

  for (const candidate of candidates) {
    const { key, matchedOn } = dedupKeyOf(candidate);
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, { kept: candidate, matchedOn, dropped: [] });
    } else {
      existing.dropped.push(candidate.candidateId);
    }
  }

  const deduped: CandidateAsset[] = [];
  const duplicateGroups: DuplicateGroup[] = [];
  for (const [key, group] of Array.from(seen.entries())) {
    deduped.push(group.kept);
    if (group.dropped.length > 0) {
      duplicateGroups.push({
        dedupKey: key,
        matchedOn: group.matchedOn,
        keptCandidateId: group.kept.candidateId,
        droppedCandidateIds: group.dropped,
      });
    }
  }

  return { deduped, duplicateGroups };
}
