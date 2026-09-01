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

  it("AFTER: the same beat now gets three archive candidates to judge", () => {
    /**
     * RONDE 170 amended the NUMBER, never the rule.
     *
     * The cap still gives the archive three before anyone gets a second — that is what this round
     * fixed and it is asserted below. What changed is what happens to the slots the caps leave
     * empty: this beat has only two sources, so the caps filled four of a six-slot budget and the
     * other two were thrown away. They are now filled from the candidates the cap refused.
     *
     * The guarantee that matters is unchanged and is checked here: the external source still gets
     * its place, so the backfill took nothing from anyone.
     */
    const shortlist = buildDownloadShortlist(beatS1B6(), MAX_FUNNEL_CANDIDATES_TO_SCORE);
    expect(shortlist.filter((c) => c.source === "archive").length).toBeGreaterThanOrEqual(3);
    // And the external candidate is still there — this took nothing from anyone.
    expect(shortlist.some((c) => c.source === "openverse")).toBe(true);
  });

  it("the caps still decide the first picks, one source at a time", () => {
    /**
     * The diversity rule, stated on the part of the shortlist the caps produce. Every source's
     * share is settled before the backfill sees a single slot, so a source can never be pushed out
     * by another source's overflow.
     */
    const shortlist = buildDownloadShortlist(beatS1B6(), MAX_FUNNEL_CANDIDATES_TO_SCORE);
    const firstFour = shortlist.slice(0, 4);
    expect(firstFour.filter((c) => c.source === "archive")).toHaveLength(3);
    expect(firstFour.filter((c) => c.source === "openverse")).toHaveLength(1);
  });

  it("the ones it offers are the best-ranked ones, not an arbitrary three", () => {
    const shortlist = buildDownloadShortlist(beatS1B6(), MAX_FUNNEL_CANDIDATES_TO_SCORE);
    const archive = shortlist.filter((c) => c.source === "archive").map((c) => c.id);
    // Best-ranked first, and RONDE 170's backfill continues down the same ranking rather than
    // reaching for something arbitrary — so the list stays a prefix of the archive ordering.
    expect(archive.slice(0, 3)).toEqual(["archive:0", "archive:1", "archive:2"]);
    expect(archive).toEqual([...archive].sort((a, b) => Number(a.split(":")[1]) - Number(b.split(":")[1])));
  });
});

describe("RONDE 163 — nothing was loosened to get there", () => {
  it("no other source's cap moved", () => {
    const pool = [
      ...Array.from({ length: 4 }, (_, i) => cand(`nara:${i}`, "nara", 9 - i)),
      ...Array.from({ length: 4 }, (_, i) => cand(`pexels:${i}`, "pexels", 5 - i)),
    ];
    const shortlist = buildDownloadShortlist(pool, MAX_FUNNEL_CANDIDATES_TO_SCORE);
    // The caps settle the first three: nara 2, pexels 1. RONDE 170 fills the remaining three
    // slots of the six-slot budget, which were previously discarded.
    const capped = shortlist.slice(0, 3);
    expect(capped.filter((c) => c.source === "nara")).toHaveLength(2);
    expect(capped.filter((c) => c.source === "pexels")).toHaveLength(1);
    // Five, not six: RONDE 170 backfills the slack from nara's overflow but never from stock —
    // six near-duplicate Pexels clips are the case an earlier round deliberately refused to fetch.
    expect(shortlist).toHaveLength(5);
    expect(shortlist.filter((c) => c.source === "pexels")).toHaveLength(1);
  });

  it("a shortlist the caps already fill is not touched by the backfill", async () => {
    /**
     * The condition under which RONDE 170 does nothing at all: enough sources to fill the budget.
     * `backfilledFromCap=0` on such a beat is the proof that the caps, not the backfill, are
     * deciding — and a render where it stays 0 throughout has no slack to reclaim.
     */
    const { createArchiveSourcingAudit } = await import("./archiveSourcingAudit");
    const audit = createArchiveSourcingAudit();
    const pool = [
      ...Array.from({ length: 4 }, (_, i) => cand(`archive:${i}`, "archive", 9 - i * 0.1)),
      ...Array.from({ length: 3 }, (_, i) => cand(`nara:${i}`, "nara", 8 - i * 0.1)),
      cand("wikimedia:0", "wikimedia", 7.5),
      cand("nasa:0", "nasa", 7.4),
    ];
    const shortlist = buildDownloadShortlist(pool, MAX_FUNNEL_CANDIDATES_TO_SCORE, undefined, audit);
    expect(shortlist).toHaveLength(MAX_FUNNEL_CANDIDATES_TO_SCORE);
    expect(audit.backfilledFromCap).toBe(0);
    expect(shortlist.filter((c) => c.source === "archive")).toHaveLength(3);
  });

  it("every source that has a candidate still reaches the shortlist", () => {
    /**
     * The property the earlier guard protects, and the reason the cap is 3 and not 4: with a
     * budget of 6, three archive candidates leave room for every other source present.
     */
    const pool = [
      ...Array.from({ length: 5 }, (_, i) => cand(`archive:${i}`, "archive", 9 - i * 0.1)),
      cand("wikimedia:1", "wikimedia", 7.0),
      cand("nasa:1", "nasa", 6.9),
      cand("nara:1", "nara", 6.8),
    ];
    const shortlist = buildDownloadShortlist(pool, MAX_FUNNEL_CANDIDATES_TO_SCORE);
    for (const source of ["wikimedia", "nasa", "nara"]) {
      expect(shortlist.some((c) => c.source === source), source).toBe(true);
    }
    expect(shortlist.filter((c) => c.source === "archive").length).toBeLessThanOrEqual(3);
  });

  it("the download budget is still the ceiling", () => {
    const shortlist = buildDownloadShortlist(beatS1B6(), MAX_FUNNEL_CANDIDATES_TO_SCORE);
    expect(shortlist.length).toBeLessThanOrEqual(MAX_FUNNEL_CANDIDATES_TO_SCORE);
  });

  it("a budget of zero still yields nothing — no floor was introduced", () => {
    expect(buildDownloadShortlist(beatS1B6(), 0)).toEqual([]);
  });

  it("no duplicate is forced in to fill a slot", () => {
    // Two candidates, budget six: the shortlist is two, not two padded to six.
    const pool = [cand("archive:0", "archive", 5), cand("nara:0", "nara", 4)];
    expect(buildDownloadShortlist(pool, MAX_FUNNEL_CANDIDATES_TO_SCORE)).toHaveLength(2);
  });

  it("the per-beat exclusion still runs before the caps", () => {
    /**
     * RONDE 2's cross-beat reuse: a candidate an earlier beat already took is dropped from the
     * input, so the same ranking reaches further down for the next beat. Raising the archive cap
     * must not shortcut that.
     */
    const used = new Set(["archive:0", "archive:1"]);
    const shortlist = buildDownloadShortlist(beatS1B6(), MAX_FUNNEL_CANDIDATES_TO_SCORE, used);
    expect(shortlist.map((c) => c.id)).not.toContain("archive:0");
    expect(shortlist.map((c) => c.id)).not.toContain("archive:1");
    // The exclusion happens before the caps AND before the backfill, so neither can bring an
    // already-used candidate back — which is the property RONDE 2 depends on.
    expect(shortlist.filter((c) => c.source === "archive").length).toBeGreaterThanOrEqual(3);
  });

  it("when every candidate has been used the full list comes back — a beat is never starved", () => {
    const all = new Set(beatS1B6().map((c) => c.id));
    const shortlist = buildDownloadShortlist(beatS1B6(), MAX_FUNNEL_CANDIDATES_TO_SCORE, all);
    expect(shortlist.length).toBeGreaterThan(0);
  });
});

describe("RONDE 163 — where candidates are lost is now counted", () => {
  it("the shortlist stage reports each count into the beat's audit", async () => {
    /**
     * RONDE 164 moved the printing to the beat, where the downstream numbers (downloaded,
     * visionJudged, adopted) are known — one line per beat instead of one per stage. What this
     * round put in place is the counting, and that is what is asserted here: the same values,
     * recorded rather than logged in isolation.
     */
    const { createArchiveSourcingAudit } = await import("./archiveSourcingAudit");
    const audit = createArchiveSourcingAudit();
    buildDownloadShortlist(beatS1B6(), MAX_FUNNEL_CANDIDATES_TO_SCORE, undefined, audit);
    expect(audit.afterMetadata).toBe(26);
    expect(audit.afterBeatDedup).toBe(26);
    // Four, not six: the budget is a ceiling and this beat has only two sources, so the caps —
    // not the budget — decide. That distinction is the whole point of recording both.
    // RONDE 170: the caps let four through and the backfill filled the two slots the budget had
    // left over, so the shortlist is six. `cutBySourceCap` counts what the caps refused and the
    // backfill did NOT reclaim, so it falls by exactly the two that were reclaimed.
    expect(audit.afterSourceCap).toBe(6);
    expect(audit.backfilledFromCap).toBe(2);
    expect(audit.cutBySourceCap).toBe(20);
    expect(audit.cutByBudget).toBe(0);
  });

  it("a caller that tracks nothing still gets a shortlist", () => {
    // The audit is optional: every other call site is unchanged and unaffected.
    expect(buildDownloadShortlist(beatS1B6(), MAX_FUNNEL_CANDIDATES_TO_SCORE)).toHaveLength(6);
  });
});
