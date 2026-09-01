/**
 * RONDE 170 — render 555 paid for six downloads a beat and used three, and lost the provenance of
 * thirteen real pictures on the way in.
 *
 * Two findings, both from the same log, both measured rather than argued.
 *
 * ── #1: the caps were shrinking the shortlist below the budget ───────────────────────────────
 *
 *     beat=s2b0 afterMetadata=15 afterSourceCap=3 downloadBudget=6 downloaded=0
 *               cutBySourceCap=8 cutByBudget=0   verdict=LOST_BEFORE_VISION
 *     beat=s2b1 afterSourceCap=3 downloadBudget=6 cutBySourceCap=5 cutByBudget=0
 *     beat=s2b3 afterSourceCap=5 downloadBudget=6 cutBySourceCap=7 cutByBudget=0
 *     TOTAL     cutBySourceCap=106 cutByBudget=6
 *               beatsWithCapBinding=13 medianCapGap=0.00 capGapMax=0.01
 *
 * On three of the four beats the render printed in full, the shortlist came out SMALLER than the
 * download budget while the per-source cap was turning candidates away. s2b0 is the clearest:
 * ninety-three candidates found, three shortlisted, eight refused by the cap, and three of six
 * paid-for slots left empty — after which the beat downloaded nothing and scored
 * LOST_BEFORE_VISION.
 *
 * Across the render the cap cut 106 and the budget cut 6, and on the thirteen beats where the cap
 * actually bound, the median score gap between what it kept and what it refused was 0.00. RONDE
 * 164 and 165 both declined to act on ONE such beat. Thirteen is the evidence they asked for.
 *
 * The answer is not a bigger cap — RONDE 157 raised it to 4 and measured the archive eating slots
 * the other providers needed. The caps are a DIVERSITY rule and they keep deciding the whole
 * shortlist whenever there are candidates enough to fill the budget. What they were also doing was
 * leaving slots empty when no other source had anything to put in them, and an empty slot serves
 * no diversity: nothing is being kept out of it.
 *
 * ── #2: the funnel's curated branch opened no lineage at all ─────────────────────────────────
 *
 *     [Quality] Video 555: score=14/100, clips=16 [UNVERIFIED=14, loc=1, nasa=1]
 *     [Quality] Video 555: 14 clip(s) met niet-bewezen bron (UNVERIFIED).
 *     [Quality] Video 555: 1 kleur-fallback beat(s)
 *
 * Fourteen of sixteen delivered clips could not say where they came from, on a render with exactly
 * ONE colour card — so thirteen were real pictures whose provenance was lost.
 *
 * `prepareCuratedArchiveClip` lives in curatedMediaSourcing, which contains no reference to
 * `lineage`. Every other download route opens a record at the one moment the provider, the asset
 * id and the destination path are all in hand. The funnel's curated branch called that function
 * directly and did neither, so its clips reached `recordClipAdopt` as files the ledger had never
 * seen — and that function's hole-filling branch opens a record with NO provider on purpose,
 * because RONDE 87's rule is that a route label is not a provider. Correct behaviour on a record
 * that should never have been needed.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

import { createArchiveSourcingAudit } from "./archiveSourcingAudit";
import {
  MAX_FUNNEL_CANDIDATES_TO_SCORE,
  buildDownloadShortlist,
  type FunnelCandidate,
  type FunnelCandidateSource,
} from "./retrievalFunnel";

const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

const cand = (id: string, source: FunnelCandidateSource, rankingScore: number): FunnelCandidate =>
  ({ id, source, rankingScore, mediaType: "video" }) as FunnelCandidate;

/** Render 555's s2b0: many archive candidates, one other source, a six-slot budget. */
const s2b0 = (): FunnelCandidate[] => [
  ...Array.from({ length: 14 }, (_, i) => cand(`archive:${i}`, "archive", 0.87 - i * 0.01)),
  cand("openverse:0", "openverse", 0.5),
];

describe("RONDE 170 #1 — the caps no longer leave paid-for slots empty", () => {
  it("the bug: s2b0's shortlist was three against a budget of six", () => {
    // Cap phase only: archive 3, openverse 1. Four of six, and the other two were discarded.
    const shortlist = buildDownloadShortlist(s2b0(), MAX_FUNNEL_CANDIDATES_TO_SCORE);
    expect(shortlist.slice(0, 4).filter((c) => c.source === "archive")).toHaveLength(3);
    // The fix: the budget is now actually spent.
    expect(shortlist).toHaveLength(MAX_FUNNEL_CANDIDATES_TO_SCORE);
  });

  it("the slack is filled from the cap's own refusals, in ranking order", () => {
    // Not something arbitrary: the next-best candidates the cap turned away.
    const shortlist = buildDownloadShortlist(s2b0(), MAX_FUNNEL_CANDIDATES_TO_SCORE);
    expect(shortlist.map((c) => c.id)).toEqual([
      "archive:0", "archive:1", "archive:2", "openverse:0", "archive:3", "archive:4",
    ]);
  });

  it("a beat with sources enough to fill the budget is untouched", () => {
    /**
     * The condition under which this round does nothing at all, and the proof that the caps still
     * decide: `backfilledFromCap=0` and the archive gets exactly its three.
     */
    const audit = createArchiveSourcingAudit();
    const busy = [
      ...Array.from({ length: 6 }, (_, i) => cand(`archive:${i}`, "archive", 9 - i * 0.1)),
      ...Array.from({ length: 3 }, (_, i) => cand(`nara:${i}`, "nara", 8 - i * 0.1)),
      cand("wikimedia:0", "wikimedia", 7.5),
    ];
    // archive 3 + nara 2 + wikimedia 1 = exactly the six-slot budget, so there is no slack.
    const shortlist = buildDownloadShortlist(busy, MAX_FUNNEL_CANDIDATES_TO_SCORE, undefined, audit);
    expect(audit.backfilledFromCap).toBe(0);
    expect(shortlist.filter((c) => c.source === "archive")).toHaveLength(3);
    expect(shortlist.filter((c) => c.source === "nara")).toHaveLength(2);
    expect(shortlist.filter((c) => c.source === "wikimedia")).toHaveLength(1);
  });

  it("no source ever loses a place to another source's overflow", () => {
    /**
     * The RONDE 157 lesson, asserted as a property. Raising the archive cap starved the other
     * providers; the backfill cannot, because every source's capped share is settled before a
     * single slot is backfilled. Checked across a sweep of source mixes.
     */
    for (const archiveCount of [1, 3, 6, 12]) {
      for (const otherCount of [0, 1, 2, 5]) {
        const pool = [
          ...Array.from({ length: archiveCount }, (_, i) => cand(`archive:${i}`, "archive", 9 - i * 0.1)),
          ...Array.from({ length: otherCount }, (_, i) => cand(`nara:${i}`, "nara", 8 - i * 0.1)),
        ];
        const shortlist = buildDownloadShortlist(pool, MAX_FUNNEL_CANDIDATES_TO_SCORE);
        const label = `archive=${archiveCount} nara=${otherCount}`;
        // nara's capped share is min(2, what it has) and it always gets it.
        expect(shortlist.filter((c) => c.source === "nara").length, label)
          .toBeGreaterThanOrEqual(Math.min(2, otherCount));
      }
    }
  });

  it("the shortlist never exceeds the budget, however much slack there was", () => {
    for (const n of [1, 4, 6, 9, 30]) {
      const pool = Array.from({ length: n }, (_, i) => cand(`archive:${i}`, "archive", 9 - i * 0.1));
      expect(buildDownloadShortlist(pool, MAX_FUNNEL_CANDIDATES_TO_SCORE).length, `n=${n}`)
        .toBeLessThanOrEqual(MAX_FUNNEL_CANDIDATES_TO_SCORE);
    }
  });

  it("the counts still add up, with the reclaimed ones named", () => {
    // cutBySourceCap means "refused by the cap and NOT reclaimed", so the three numbers partition
    // the pool exactly. A reader who cannot add them up cannot trust any of them.
    const audit = createArchiveSourcingAudit();
    const pool = s2b0();
    const shortlist = buildDownloadShortlist(pool, MAX_FUNNEL_CANDIDATES_TO_SCORE, undefined, audit);
    expect(
      shortlist.length + (audit.cutBySourceCap ?? 0) + (audit.cutByBudget ?? 0)
    ).toBe(pool.length);
    expect(audit.backfilledFromCap).toBe(2);
  });

  it("neither the cap nor the budget was raised", () => {
    const funnel = readFileSync(join(__dirname, "retrievalFunnel.ts"), "utf8");
    expect(MAX_FUNNEL_CANDIDATES_TO_SCORE).toBe(6);
    expect(funnel).toMatch(/^const MAX_SHORTLIST_PER_ARCHIVE_SOURCE = 3;$/m);
    expect(funnel).toMatch(/^const MAX_SHORTLIST_PER_NON_STOCK_SOURCE = 2;$/m);
    expect(funnel).toMatch(/^const MAX_SHORTLIST_PER_STOCK_SOURCE = 1;$/m);
  });

  it("an empty pool and a zero budget behave as before", () => {
    expect(buildDownloadShortlist([], 6)).toEqual([]);
    expect(buildDownloadShortlist(s2b0(), 0)).toEqual([]);
  });
});

describe("RONDE 170 #2 — the funnel's curated clips carry their provenance", () => {
  it("the curated branch opens the record before the download, like every other route", () => {
    const idx = PIPE.indexOf("if (candidate.archivePick) {");
    expect(idx).toBeGreaterThan(0);
    const block = PIPE.slice(idx, PIPE.indexOf("if (candidate.poolCandidate) {", idx));
    expect(block).toContain("ensureCuratedAssetLineageOn(lineage, candidate.archivePick");
    expect(block).toContain('recordEvent(pending.lineageId, "DOWNLOAD_STARTED"');
  });

  it("and binds it to the file that came out, so the path resolves too", () => {
    const idx = PIPE.indexOf("if (candidate.archivePick) {");
    const block = PIPE.slice(idx, PIPE.indexOf("if (candidate.poolCandidate) {", idx));
    expect(block).toContain("lineage.bindPath(pending.lineageId, clip,");
    expect(block).toContain("curatedAssetContentKey(candidate.archivePick.asset.id)");
    expect(block).toContain('recordEvent(pending.lineageId, "DOWNLOAD_SUCCEEDED"');
  });

  it("a curated download that produces nothing gets an ending, not a silence", () => {
    // RONDE 167 F1: DOWNLOAD_FAILED is a complete account, and it names the asset.
    const idx = PIPE.indexOf("if (candidate.archivePick) {");
    const block = PIPE.slice(idx, PIPE.indexOf("if (candidate.poolCandidate) {", idx));
    expect(block).toContain('"DOWNLOAD_FAILED"');
    expect(block).toContain("curated_clip_not_produced");
  });

  it("the ledger-only entry point exists because the funnel has no VisualDedupState", () => {
    /**
     * `downloadFunnelCandidate` is handed a SourcingCache, not the whole render state, which is a
     * large part of why it could not call `ensureCuratedAssetLineage` and opened no lineage at all.
     * The wrapper keeps every existing caller unchanged.
     */
    expect(PIPE).toContain("export function ensureCuratedAssetLineageOn(");
    expect(PIPE).toContain("ledger: VisualSourceLedger,");
    expect(PIPE).toContain(
      "return ensureCuratedAssetLineageOn(dedup.sourcingCache.lineage, picked, sceneIndex, beatIndex);"
    );
  });

  it("the provider is the archive the row names, never a route label", () => {
    // RONDE 87's rule, unchanged: `own_archive` only when the row itself carries no archive name.
    const idx = PIPE.indexOf("export function ensureCuratedAssetLineageOn(");
    const block = PIPE.slice(idx, idx + 1200);
    expect(block).toContain('provider: picked.archiveName?.trim() || "own_archive"');
    expect(block).toContain("archiveAssetId: picked.asset.id");
  });
});
