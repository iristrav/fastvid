/**
 * RONDE 165 — seventeen assets chosen, seventeen assets gone, and nothing saying why.
 *
 * ── What render 554 reported ─────────────────────────────────────────────────────────────────
 *
 * The render finished, the repeat audit passed at 5.8% and no frozen frame reached the file. The
 * lineage audit under it reported seventeen VANISHED_WITHOUT_OUTCOME warnings, on `extend_s*`,
 * `scene_N_slotN_guaranteed`, `scene_N_bM_curated_*`, `_ia_archive_` and `_inet_img_ov_openverse`
 * files alike — five different routes, which is why four previous rounds each closed one and the
 * count did not fall.
 *
 * ── The dominant route, proven from the render's own numbers ─────────────────────────────────
 *
 * Beat s2b3, in two lines the render printed itself:
 *
 *     [ArchiveSourcingAudit] beat=s2b3 ... downloaded=4 visionJudged=4 visionAccepted=4 adopted=1
 *     [VisualDiscovery] s2b3 ... scores={loc:8.0,archive:8.0,archive:8.0,archive:8.0}
 *                                winner=loc(score=8.0) runnerUp=archive(score=8.0)
 *
 * Four candidates fetched, four judged, four PASSED, one used. The three that lost were not
 * refused by anything — they were dropped when `scored` went out of scope. The ledger had them
 * SELECTED and then nothing, which is precisely the shape of the warning.
 *
 * That is a different fault from the four rounds before it. Those closed refusals that forgot to
 * say so; this one is an asset with no refusal to record at all, and the ending it needs is "a
 * better candidate won the beat", which no vocabulary in the pipeline had a word for.
 *
 * ── What this round adds ─────────────────────────────────────────────────────────────────────
 *
 *  · `AssetOutcomeReason` + `recordAssetOutcome` — the reasons named once, so the next route to be
 *    written cannot invent a sixth private reason string and start silent by default.
 *  · `superseded_by_winner` and `not_chosen`, kept apart on purpose: "another candidate was
 *    better" is the funnel working and "the beat found no winner" is the funnel failing.
 *  · `[AssetLifecycleAudit]` — the denominator the seventeen warnings never had.
 *  · `archiveCapStats` — the aggregate the cap decision needs, because render 554 offered exactly
 *    ONE binding beat and a cap must not be raised on one sample.
 *
 * ── What this round deliberately does NOT do ─────────────────────────────────────────────────
 *
 * The download budget stays 6 and the archive cap stays 3. Render 554 measured `cutByBudget=0`
 * across all fifteen beats — the budget bound on nothing — and a single beat at capGap=0.00 is an
 * anecdote. Both are asserted below so a later round cannot quietly move them without saying so.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

import {
  archiveCapStats,
  capGapFor,
  createArchiveSourcingAudit,
  recordBeatOutcome,
  recordShortlistStage,
  summarizeArchiveSourcing,
  type ArchiveSourcingAudit,
} from "./archiveSourcingAudit";
import { MAX_FUNNEL_CANDIDATES_TO_SCORE } from "./retrievalFunnel";
import {
  VisualSourceLedger,
  formatAssetLifecycleAudit,
  recordAssetOutcome,
} from "./visualSourceLineage";

const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");
const FUNNEL = readFileSync(join(__dirname, "retrievalFunnel.ts"), "utf8");
const LINEAGE = readFileSync(join(__dirname, "visualSourceLineage.ts"), "utf8");

/** A ledger holding one candidate, at whatever point in its life the test needs it. */
function ledgerWith(
  paths: string[],
  opts: { provider?: string; route?: string } = {}
): VisualSourceLedger {
  const ledger = new VisualSourceLedger({ renderId: "r165" });
  for (const localPath of paths) {
    ledger.createLineage({
      sceneIndex: 2,
      beatIndex: 3,
      localPath,
      provider: opts.provider ?? "loc",
      route: opts.route ?? "funnel",
    });
  }
  return ledger;
}

/** Everything a candidate collects on its way to being this beat's picture. */
function select(ledger: VisualSourceLedger, clipPath: string): void {
  const record = ledger.resolve(clipPath);
  if (!record) throw new Error(`fixture error: ${clipPath} is not in the ledger`);
  ledger.recordEvent(record.lineageId, "SELECTED", { status: "OK" });
}

describe("RONDE 165 — the funnel's losers get the ending they actually had", () => {
  it("a candidate that was selected and then dropped is what the ledger warns about", () => {
    // The bug as render 554 had it: SELECTED, never delivered, nothing said.
    const ledger = ledgerWith(["/w/a.mp4"]);
    select(ledger, "/w/a.mp4");
    ledger.markFinalVideo([]);
    const codes = ledger.reconcile().warnings.map((w) => w.code);
    expect(codes).toContain("VANISHED_WITHOUT_OUTCOME");
  });

  it("filing superseded_by_winner closes it", () => {
    const ledger = ledgerWith(["/w/a.mp4"]);
    select(ledger, "/w/a.mp4");
    recordAssetOutcome(ledger, "/w/a.mp4", "superseded_by_winner", "s2b3");
    ledger.markFinalVideo([]);
    const codes = ledger.reconcile().warnings.map((w) => w.code);
    expect(codes).not.toContain("VANISHED_WITHOUT_OUTCOME");
  });

  it("a hand-off is REPLACED and a refusal is REJECTED — the ledger can tell them apart", () => {
    const ledger = ledgerWith(["/w/win.mp4", "/w/bad.mp4"]);
    recordAssetOutcome(ledger, "/w/win.mp4", "superseded_by_winner");
    recordAssetOutcome(ledger, "/w/bad.mp4", "vision_rejected");
    const byPath = new Map(
      ledger.allEvents().map((e) => [ledger.allRecords().find((r) => r.lineageId === e.lineageId)?.currentFilename, e])
    );
    expect(byPath.get("win.mp4")?.status).toBe("REPLACED");
    expect(byPath.get("win.mp4")?.stage).toBe("REPLACED");
    expect(byPath.get("bad.mp4")?.status).toBe("REJECTED");
    // REJECTED is a status, not a stage — it is filed on REMOVED, which is the shape the
    // vanished rule looks for.
    expect(byPath.get("bad.mp4")?.stage).toBe("REMOVED");
  });

  it("the reason travels with the beat that produced it", () => {
    const ledger = ledgerWith(["/w/a.mp4"]);
    recordAssetOutcome(ledger, "/w/a.mp4", "not_chosen", "s2b3");
    // [0] is the FOUND event createLineage emits; the outcome is the one filed last.
    expect(ledger.allEvents().at(-1)?.reason).toBe("not_chosen:s2b3");
  });

  it("a path the ledger has never seen is a no-op, not an invented record", () => {
    const ledger = ledgerWith(["/w/a.mp4"]);
    const before = ledger.size;
    recordAssetOutcome(ledger, "/w/never-heard-of.mp4", "not_chosen");
    expect(ledger.size).toBe(before);
    expect(ledger.allEvents().filter((e) => e.stage === "REMOVED")).toHaveLength(0);
  });

  it("no ledger at all is a no-op too — an audit may never fail a render", () => {
    expect(() => recordAssetOutcome(undefined, "/w/a.mp4", "not_chosen")).not.toThrow();
  });

  it("every reason maps to a terminal status; none maps to OK", () => {
    // OK would file an event that the vanished rule reads as "still in play", which is the exact
    // failure this vocabulary exists to make impossible.
    const reasons = LINEAGE.slice(
      LINEAGE.indexOf("const OUTCOME_STATUS"),
      LINEAGE.indexOf("export function recordAssetOutcome")
    );
    expect(reasons).not.toContain(': "OK"');
    for (const status of ["REJECTED", "REMOVED", "REPLACED"]) {
      expect(reasons).toContain(`"${status}"`);
    }
  });
});

describe("RONDE 165 — wired into the routes render 554 lost assets on", () => {
  it("the funnel files an outcome for every scored candidate that is not the winner", () => {
    const idx = PIPE.indexOf("for (const candidate of scored) {");
    expect(idx).toBeGreaterThan(0);
    const block = PIPE.slice(idx, PIPE.indexOf("[VisualDiscovery] audit line", idx));
    expect(block).toContain("if (winner && candidate.clipPath === winner.clipPath) continue;");
    expect(block).toContain('"superseded_by_winner"');
    expect(block).toContain('"not_chosen"');
    expect(block).toContain('"vision_rejected"');
    expect(block).toContain("recordAssetOutcome(");
  });

  it("a beat with no winner files not_chosen, never superseded_by_winner", () => {
    // The two are told apart by `winner`, so the distinction cannot decay into one bucket.
    const idx = PIPE.indexOf("for (const candidate of scored) {");
    const block = PIPE.slice(idx, idx + 900);
    expect(block).toMatch(/winner\s*\n?\s*\?\s*"superseded_by_winner"\s*\n?\s*:\s*"not_chosen"/);
  });

  it("an extension pushClip turned away is recorded, and the two reasons are told apart", () => {
    /**
     * RONDE 167 rewrote this from a source-text match to the rule it was guarding.
     *
     * The original asserted one exact call shape and broke the moment the branch grew. Worse, it
     * could not see that the branch was writing to a path the ledger did not know — it wrote zero
     * events, measured — so the assertion passed on dead code for two rounds.
     *
     * pushClip refuses for two different reasons and they are different endings: the compose
     * barrier refusing on content grounds, and the clip's content key already being on the
     * timeline. An extension hits the second by construction.
     */
    const idx = PIPE.indexOf("const extended = await extendLastClip(dedup.lastRealClip");
    expect(idx).toBeGreaterThan(0);
    const block = PIPE.slice(idx, PIPE.indexOf("extendLastClip HIT", idx));
    expect(block).toContain("composeBarrierAllows(");
    expect(block).toMatch(/barrier\.allow \? "extended_removed" : "extended_rejected"/);
    // And the outcome is filed with an identity, not just a path — see RONDE 167 F2/F3.
    expect(block).toContain("clipContentKey(extended)");
  });

  it("adoptClip's selected-but-not-adopted exits all file an outcome", () => {
    // SELECTED is filed for every eligible candidate; each way out of the iteration that does not
    // reach markAdopted is one of the routes that used to go silent.
    const start = PIPE.indexOf("const eligibleRecord = dedup.sourcingCache.lineage.resolve(p, contentKey);");
    expect(start).toBeGreaterThan(0);
    const block = PIPE.slice(start, PIPE.indexOf("async function tryStockSources", start));
    expect(block.match(/recordAssetOutcome\(dedup\.sourcingCache\.lineage, p,/g)?.length).toBe(3);
    expect(block).toContain('"invalid_file"');
    expect(block).toContain('"transform_failed"');
  });

  it("the render report prints the lifecycle audit next to the warnings it summarises", () => {
    const idx = PIPE.indexOf("const reconciliation = ledger.reconcile();");
    const block = PIPE.slice(idx, idx + 900);
    expect(block).toContain("formatAssetLifecycleAudit(ledger)");
    // A clean render logs; a leaking one warns. Both are printed either way.
    expect(block).toContain('line.includes("unresolved=0")');
  });
});

describe("RONDE 165 — [AssetLifecycleAudit] gives the warnings a denominator", () => {
  /** One of each of the four endings an asset can have. */
  function mixedLedger(): VisualSourceLedger {
    const ledger = ledgerWith(["/w/win.mp4", "/w/lost.mp4", "/w/vanished.mp4", "/w/never.mp4"]);
    select(ledger, "/w/win.mp4");
    select(ledger, "/w/lost.mp4");
    select(ledger, "/w/vanished.mp4");
    // "/w/never.mp4" was found and nothing ever picked it — no ending is owed.
    recordAssetOutcome(ledger, "/w/lost.mp4", "superseded_by_winner", "s2b3");
    ledger.markFinalVideo(["/w/win.mp4"]);
    return ledger;
  }

  it("counts delivered, resolved, never-chosen and unresolved separately", () => {
    const line = formatAssetLifecycleAudit(mixedLedger())[0];
    expect(line).toContain("assets=4");
    expect(line).toContain("delivered=1");
    expect(line).toContain("resolved=1");
    expect(line).toContain("neverChosen=1");
    expect(line).toContain("unresolved=1");
  });

  it("unresolved is exactly the set reconcile() warns about — not a second rule", () => {
    const ledger = mixedLedger();
    const vanished = ledger.reconcile().warnings.filter((w) => w.code === "VANISHED_WITHOUT_OUTCOME");
    const line = formatAssetLifecycleAudit(ledger)[0];
    expect(line).toContain(`unresolved=${vanished.length}`);
  });

  it("it names the unresolved assets and groups them by route", () => {
    const lines = formatAssetLifecycleAudit(mixedLedger());
    expect(lines.some((l) => l.includes("unresolvedByRoute") && l.includes("funnel=1"))).toBe(true);
    expect(lines.some((l) => l.includes("unresolved asset=") && l.includes("file=vanished.mp4"))).toBe(true);
  });

  it("a clean render says unresolved=0 and names nobody", () => {
    const ledger = ledgerWith(["/w/win.mp4", "/w/lost.mp4"]);
    select(ledger, "/w/win.mp4");
    select(ledger, "/w/lost.mp4");
    recordAssetOutcome(ledger, "/w/lost.mp4", "superseded_by_winner");
    ledger.markFinalVideo(["/w/win.mp4"]);
    const lines = formatAssetLifecycleAudit(ledger);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("unresolved=0");
  });

  it("an empty ledger prints nothing rather than a row of zeros", () => {
    // Zeros here would read as "a render that lost everything", which is a different finding.
    expect(formatAssetLifecycleAudit(new VisualSourceLedger({ renderId: "r165" }))).toEqual([]);
  });

  it("a terminal event filed after an ordinary one still counts as the ending", () => {
    // REPLACED is a stage as well as a status, and an earlier OK on it must not mask the outcome.
    const ledger = ledgerWith(["/w/a.mp4"]);
    select(ledger, "/w/a.mp4");
    const record = ledger.resolve("/w/a.mp4")!;
    ledger.recordEvent(record.lineageId, "REPLACED", { status: "OK" });
    recordAssetOutcome(ledger, "/w/a.mp4", "superseded_by_winner");
    ledger.markFinalVideo([]);
    expect(formatAssetLifecycleAudit(ledger)[0]).toContain("unresolved=0");
  });
});

describe("RONDE 165 — the cap statistics a cap decision would need", () => {
  /** A beat as buildDownloadShortlist records it, with the archive scores it kept and refused. */
  function beat(taken: number[], cut: number[]): ArchiveSourcingAudit {
    const audit = createArchiveSourcingAudit();
    recordShortlistStage(audit, {
      afterMetadata: 15,
      afterBeatDedup: 15,
      afterSourceCap: taken.length,
      downloadBudget: 6,
      cutBySourceCap: cut.length,
      cutByBudget: 0,
      archive: { taken, cut },
    });
    recordBeatOutcome(audit, {
      candidatesFound: 26,
      downloaded: taken.length,
      visionJudged: taken.length,
      visionAccepted: taken.length,
      adopted: true,
    });
    return audit;
  }

  it("render 554's s2b3: the cap refused a candidate that scored the same as one it kept", () => {
    expect(capGapFor(beat([8, 8, 8], [8, 7.5]))).toBe(0);
  });

  it("a beat the cap never bound on has no gap — absent, not zero", () => {
    // Averaging a zero in for a beat the cap never touched would read as "the cap is costing us".
    expect(capGapFor(beat([8, 7], []))).toBeNull();
    expect(capGapFor(beat([], []))).toBeNull();
  });

  it("beatsWithCapBinding counts only the beats the cap actually cut on", () => {
    const stats = archiveCapStats([beat([8, 8, 8], [8]), beat([9, 8], []), beat([7, 6, 5], [3])]);
    expect(stats.beatsWithCapBinding).toBe(2);
  });

  it("avg, median, min and max are computed over those beats only", () => {
    const stats = archiveCapStats([
      beat([8, 8, 8], [8]),   // gap 0
      beat([9, 8, 7], [5]),   // gap 2
      beat([9, 8, 6], [2]),   // gap 4
      beat([9, 9], []),       // no binding — must not pull the average to 0
    ]);
    expect(stats.beatsWithCapBinding).toBe(3);
    expect(stats.avgCapGap).toBeCloseTo(2, 6);
    expect(stats.medianCapGap).toBe(2);
    expect(stats.capGapMin).toBe(0);
    expect(stats.capGapMax).toBe(4);
  });

  it("an even number of binding beats takes the mean of the middle two", () => {
    const stats = archiveCapStats([beat([8], [8]), beat([9], [5]), beat([9], [4]), beat([9], [3])]);
    // gaps 0, 4, 5, 6 → median (4+5)/2
    expect(stats.medianCapGap).toBe(4.5);
  });

  it("a render where the cap never bound reports n/a, never 0.00", () => {
    const stats = archiveCapStats([beat([8, 7], []), beat([9], [])]);
    expect(stats).toEqual({
      beatsWithCapBinding: 0,
      avgCapGap: null,
      medianCapGap: null,
      capGapMin: null,
      capGapMax: null,
    });
    expect(summarizeArchiveSourcing([beat([8, 7], [])])).toContain("avgCapGap=n/a");
  });

  it("the render-end line carries the aggregate, so one beat is never the whole argument", () => {
    const line = summarizeArchiveSourcing([beat([8, 8, 8], [8]), beat([9, 8, 7], [5])]);
    expect(line).toContain("beatsWithCapBinding=2");
    expect(line).toContain("avgCapGap=1.00");
    expect(line).toContain("medianCapGap=1.00");
    expect(line).toContain("capGapMin=0.00");
    expect(line).toContain("capGapMax=2.00");
  });
});

describe("RONDE 165 — nothing was widened on this round's evidence", () => {
  it("the download budget stays 6", () => {
    /**
     * Render 554 reported `cutByBudget=0` across all fifteen beats: the budget turned away nothing,
     * so there is no measurement that raising it would buy anything. It costs downloads and wall
     * time on every beat, and the next round needs a render where cutByBudget is actually non-zero
     * before touching it.
     */
    // The VALUE, not the text: the same string appears in a comment further down the file, and a
    // mutation to 8 sailed straight past a toContain() on it while this assertion caught it.
    expect(MAX_FUNNEL_CANDIDATES_TO_SCORE).toBe(6);
  });

  it("the per-source archive cap stays 3", () => {
    // RONDE 157 measured cap=4 starving the other sources; render 554 gives ONE binding beat.
    // These three are module-private, so they are read from the declaration itself.
    // RONDE 170 did NOT raise it. The slack the caps left behind is filled from what they
    // refused, which is a different mechanism and leaves every source's share untouched.
    expect(FUNNEL).toMatch(/^const MAX_SHORTLIST_PER_ARCHIVE_SOURCE = 3;$/m);
    expect(FUNNEL).toMatch(/^const MAX_SHORTLIST_PER_NON_STOCK_SOURCE = 2;$/m);
    expect(FUNNEL).toMatch(/^const MAX_SHORTLIST_PER_STOCK_SOURCE = 1;$/m);
  });

  it("no gate was loosened to make the numbers read better", () => {
    // The round adds accounting. Every judge that refuses a picture is untouched.
    expect(PIPE).toContain("beatImageRelevanceGateEnabled()");
    expect(PIPE).toContain("isMostlyBlackClip(");
    expect(PIPE).toContain("evaluateClipVisionGate(");
  });
});
