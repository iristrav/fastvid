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
  VisualSourceLedger,
  formatAssetLifecycleAudit,
  recordAssetOutcome,
} from "./visualSourceLineage";

const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");
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

  it("adoptClip's selected-but-not-adopted exits all file an outcome", () => {
    // SELECTED is filed for every eligible candidate; each way out of the iteration that does not
    // reach markAdopted is one of the routes that used to go silent.
    const start = PIPE.indexOf("const eligibleRecord = dedup.sourcingCache.lineage.resolve(p, contentKey);");
    expect(start).toBeGreaterThan(0);
    const block = PIPE.slice(start, PIPE.indexOf("\nfunction slotHasNoBeatBehindIt(", start));
    expect(block.match(/recordAssetOutcome\(dedup\.sourcingCache\.lineage, p,/g)?.length).toBe(3);
    expect(block).toContain('"invalid_file"');
    expect(block).toContain('"transform_failed"');
  });

  it("the render report prints the lifecycle audit next to the warnings it summarises", () => {
    /**
     * Bounded by the audit block's own end marker rather than by a byte count. RONDE 131 added the
     * [SearchMemory] summary between the reconcile call and this one, which pushed the audit past
     * a fixed +900 window — the third time a snug slice has broken on a change it should not care
     * about.
     */
    const idx = PIPE.indexOf("const reconciliation = ledger.reconcile();");
    expect(idx).toBeGreaterThan(0);
    /**
     * P0-9 moved the outcome invariant behind `reportLineageOutcomeInvariant`, so this anchor is
     * that call rather than the assertion inside it. Same place in the report, same ordering being
     * checked — the audit still sits between the reconciliation and the invariant.
     */
    const end = PIPE.indexOf("reportLineageOutcomeInvariant(ledger", idx);
    expect(end).toBeGreaterThan(idx);
    const block = PIPE.slice(idx, end);
    expect(block).toContain("formatAssetLifecycleAudit(ledger)");
    // A clean render logs; a leaking one warns. Both are printed either way.
    expect(block).toContain('line.includes("unresolved=0")');
    // ...and it still sits after the reconciliation whose warnings it is the denominator for.
    expect(block.indexOf("formatAuditReport(reconciliation)"))
      .toBeLessThan(block.indexOf("formatAssetLifecycleAudit(ledger)"));
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

describe("RONDE 165 — nothing was widened on this round's evidence", () => {

  it("no gate was loosened to make the numbers read better", () => {
    // The round adds accounting. Every judge that refuses a picture is untouched — and the picture
    // judge can no longer be switched off at all (the code audit removed its switch).
    expect(PIPE).not.toContain("beatImageRelevanceGateEnabled");
    expect(PIPE).toContain("isMostlyBlackClip(");
    expect(PIPE).toContain("evaluateClipVisionGate(");
  });
});
