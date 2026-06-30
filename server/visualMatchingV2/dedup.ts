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

/** Merges `incoming` into `base` (the survivor), combining retrieval signals from both
 *  instead of discarding the loser. `base` wins on every plain field (title, thumbnail,
 *  etc. — first-seen order still decides those); only the retrieval-signal fields are
 *  unioned, since that's the data the Candidate Scorer needs intact regardless of which
 *  retrieval path arrived first. */
function mergeCandidates(base: CandidateAsset, incoming: CandidateAsset): CandidateAsset {
  return {
    ...base,
    embeddingSimilarity: base.embeddingSimilarity ?? incoming.embeddingSimilarity,
    keywordScore: base.keywordScore ?? incoming.keywordScore,
    retrievalReasons: Array.from(new Set([...base.retrievalReasons, ...incoming.retrievalReasons])),
    retrievalSources: [...base.retrievalSources, ...incoming.retrievalSources],
  };
}

export type DedupResult = {
  deduped: CandidateAsset[];
  duplicateGroups: DuplicateGroup[];
  /** Count of candidates merged into an existing survivor (not just dropped) — used for
   *  the orchestrator's mergeCount metric. */
  mergeCount: number;
};

/** Deduplicates a flat candidate list. The first candidate seen for a given key is kept as
 *  the base; every subsequent candidate resolving to the same key is merged into it (point
 *  1 of the dedup refinement) rather than dropped, so a keyword hit and a semantic hit for
 *  the same asset both contribute their score and retrieval path to the single survivor. */
export function dedupeCandidates(candidates: CandidateAsset[]): DedupResult {
  const seen = new Map<string, { kept: CandidateAsset; matchedOn: DuplicateGroup["matchedOn"]; dropped: string[] }>();
  let mergeCount = 0;

  for (const candidate of candidates) {
    const { key, matchedOn } = dedupKeyOf(candidate);
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, { kept: candidate, matchedOn, dropped: [] });
    } else {
      existing.kept = mergeCandidates(existing.kept, candidate);
      existing.dropped.push(candidate.candidateId);
      mergeCount += 1;
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

  return { deduped, duplicateGroups, mergeCount };
}
