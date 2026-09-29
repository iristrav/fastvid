/**
 * RONDE 163 — twenty-five relevant archive candidates, two chances.
 *
 * ── The production case, beat s1b6 of render 553 ─────────────────────────────────────────────
 *
 *     [ArchiveRetrieval] s1b6 query="See how internal conflicts further destabilized the Nazi reg"
 *                        candidates=25 bestScore=0.444 knownSuccessful=11 strategy=one_external
 *     [VisualCoverageFinal] scene=1 beat=6 offered=3 visionJudged=0 eligible=0 adopted=0
 *
 * and its neighbour s1b5: also 25 candidates, offered=2, adopted=0. Both ended as beats with no
 * footage in a render that finished with 6 placeholders out of 15 beats.
 *
 * ── Where the other twenty-three went ────────────────────────────────────────────────────────
 *
 * Not the search: the archive found twenty-five and scored them. Not the embedding threshold
 * either — falling under it changes the ORDER (external leads) but keeps the archive candidates
 * in the list. The loss is two caps, applied in sequence:
 *
 *     25 found
 *      8 after the funnel's metadata slice
 *      2 after buildDownloadShortlist's per-source cap        ← the binding one
 *
 * Every archive asset carries the same `source: "archive"`, and the shortlist allowed 2 per
 * non-stock source. So no matter how many archive assets matched a beat, two of them could ever
 * be downloaded and judged.
 *
 * That cap is right for what it was written against — several stock libraries answering the same
 * query with much the same footage, where one filling the shortlist crowds out a better result
 * from another. It is wrong for the catalogue the pipeline is built on, which is not one source
 * among interchangeable peers.
 *
 * ── What changed, and what deliberately did not ──────────────────────────────────────────────
 *
 * The archive gets its own cap: 3 against a download budget of 6. Half the shortlist is the
 * ceiling — 4 was implemented first and rejected, because with five archive candidates outranking
 * three other sources it left one slot and a source with a candidate got none.
 *
 * No gate is loosened, no score raised, no duplicate forced. Relevance still orders the shortlist,
 * the download budget still bounds it, and VisionGate still decides the winner. The only change is
 * how many archive candidates are allowed to compete.
 */
import { describe, expect, it } from "vitest";

import {
  MAX_FUNNEL_CANDIDATES_TO_SCORE,
  buildDownloadShortlist,
  type FunnelCandidate,
  type FunnelCandidateSource,
} from "./retrievalFunnel";

const cand = (id: string, source: FunnelCandidateSource, rankingScore: number): FunnelCandidate => ({
  id,
  source,
  title: `${source} ${id}`,
  thumbnailUrl: null,
  mediaType: "video",
  embeddingSimilarity: null,
  archiveKeywordScore: null,
  clipSimilarity: null,
  rankingScore,
});

/** s1b6's shape: a deep archive result set and one external candidate beside it. */
const beatS1B6 = (): FunnelCandidate[] => [
  ...Array.from({ length: 25 }, (_, i) => cand(`archive:${i}`, "archive", 5 - i * 0.05)),
  cand("openverse:1", "openverse", 3.0),
];

describe("RONDE 163 — the production case, reproduced", () => {
  it("BEFORE: a 2-per-source cap offered two of twenty-five", () => {
    /**
     * The old rule, applied by hand to the same input, so the measurement this round rests on is
     * visible rather than asserted from memory. This is what render 553 did.
     */
    const sorted = [...beatS1B6()].sort((a, b) => b.rankingScore - a.rankingScore);
    const perSource = new Map<string, number>();
    const oldShortlist: FunnelCandidate[] = [];
    for (const c of sorted) {
      if (oldShortlist.length >= MAX_FUNNEL_CANDIDATES_TO_SCORE) break;
      const used = perSource.get(c.source) ?? 0;
      if (used >= 2) continue;
      oldShortlist.push(c);
      perSource.set(c.source, used + 1);
    }
    expect(oldShortlist.filter((c) => c.source === "archive")).toHaveLength(2);
  });



});


