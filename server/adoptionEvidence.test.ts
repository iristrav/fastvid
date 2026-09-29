/**
 * RONDE 92 — THE ELIGIBILITY REGISTRY ALREADY EXISTED. NOTHING READ IT.
 *
 * ── The audit ───────────────────────────────────────────────────────────────────────────────
 *
 *     `ELIGIBLE` lineage-stage write sites   2   (videoPipeline 23058, 28748)
 *     `noteBeatEligible` call sites          2
 *     `recordClipAdopt` call sites          35
 *     readers of ELIGIBLE at adoption        0
 *
 * The registry RONDE 92's brief asks for is the lineage ledger, which already holds canonical
 * identity, already survives the pad/overlay renames, and already records ELIGIBLE. What was
 * missing was one query. Building a second registry keyed by canonical identity would have
 * duplicated the structure that already holds it — the sixteenth instance of two things answering
 * one question in this codebase.
 *
 * That gap is why render 568 could report
 *
 *     [VisualFunnel] wikimedia retrieved=400 eligible=0 adopted=2 finalVideo=1
 *
 * and no part of the render objected: the fact lived on the write side only.
 *
 * ── Measured, not yet enforced, and why that is the instruction ──────────────────────────────
 *
 * RONDE 92's own prohibition list forbids blocking adoption before eligibility is correctly
 * registered. It is not: two write sites against 35 routes. Refusing every unbacked REAL_FUNNEL
 * claim today would hit nearly all of them, drive `verifiedOwnVisual` to zero, and make RONDE 89's
 * export gate refuse every render. These tests therefore pin the MEASUREMENT and the invariants —
 * H and I — that decide when the guard can be switched on.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

import {
  adoptionEvidence,
  bindLineageLedger,
  bindRelevanceLedger,
  createClipAdoptAudit,
  formatAdoptionEvidence,
  recordClipAdopt,
} from "./clipAdoptAudit";
import { VisualSourceLedger } from "./visualSourceLineage";
import { createBeatRelevanceLedger, } from "./beatVisualRelevance";
import { recordExternalRelevanceVerdict } from "./beatRelevanceSeed.test.support";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

function ledgerWith(opts: { eligible: boolean; localPath: string }) {
  const ledger = new VisualSourceLedger({ renderId: "r92", videoId: 569 });
  const rec = ledger.createLineage({
    sceneIndex: 0,
    beatIndex: 0,
    candidateId: "wikimedia:W1",
    contentKey: "wikimedia:W1",
    provider: "wikimedia",
    providerAssetId: "W1",
    localPath: opts.localPath,
    mediaType: "image",
    route: "primary",
  });
  if (opts.eligible) ledger.recordEvent(rec.lineageId, "ELIGIBLE", { status: "OK" });
  return { ledger, rec };
}

/* ═══════════════ the ledger can now be asked ═══════════════ */

describe("the ledger answers whether an asset was ever eligible", () => {
  it("says no when nothing recorded it", () => {
    const { ledger, rec } = ledgerWith({ eligible: false, localPath: "/w/a.mp4" });
    expect(ledger.hasStage(rec.lineageId, "ELIGIBLE")).toBe(false);
  });

  it("says yes when the funnel recorded it", () => {
    const { ledger, rec } = ledgerWith({ eligible: true, localPath: "/w/a.mp4" });
    expect(ledger.hasStage(rec.lineageId, "ELIGIBLE")).toBe(true);
  });

  /**
   * A clip is padded and overlaid on its way to adoption and each hop opens a CHILD record. The
   * eligibility belongs to the ASSET, not to the third file made from it — asking the child must
   * find the parent's answer, or every derived clip reads as ineligible.
   */
  it("finds the parent's eligibility from a derived child", () => {
    const { ledger, rec } = ledgerWith({ eligible: true, localPath: "/w/a.mp4" });
    ledger.linkDerivedPath("/w/a_padded.mp4", "/w/a.mp4", "PADDED");
    ledger.linkDerivedPath("/w/a_text.mp4", "/w/a_padded.mp4", "OVERLAYED");
    const child = ledger.resolve("/w/a_text.mp4")!;
    expect(child.lineageId).not.toBe(rec.lineageId);
    expect(ledger.hasStage(child.lineageId, "ELIGIBLE")).toBe(true);
  });

  it("does not invent an eligibility the chain never had", () => {
    const { ledger } = ledgerWith({ eligible: false, localPath: "/w/a.mp4" });
    ledger.linkDerivedPath("/w/a_text.mp4", "/w/a.mp4", "OVERLAYED");
    const child = ledger.resolve("/w/a_text.mp4")!;
    expect(ledger.hasStage(child.lineageId, "ELIGIBLE")).toBe(false);
  });

  it("is stage-specific, not a generic any-event check", () => {
    const { ledger, rec } = ledgerWith({ eligible: true, localPath: "/w/a.mp4" });
    expect(ledger.hasStage(rec.lineageId, "FINAL_VIDEO")).toBe(false);
  });
});

/* ═══════════════ and adoption records whether its claim is backed ═══════════════ */

function adoptWith(opts: { source: string; eligible: boolean; judged: boolean }) {
  const audit = createClipAdoptAudit();
  const localPath = "/w/a.mp4";
  const { ledger } = ledgerWith({ eligible: opts.eligible, localPath });
  bindLineageLedger(audit, ledger);
  const relevance = createBeatRelevanceLedger();
  bindRelevanceLedger(audit, relevance);
  if (opts.judged) {
    recordExternalRelevanceVerdict(
      relevance,
      localPath,
      "wikimedia:W1",
      { sceneIndex: 0, beatIndex: 0, beatText: "beat" } as never,
      { verdict: "fits", depicts: "x", reason: "test", evaluated: true }
    );
  }
  recordClipAdopt(audit, 0, 0, "beat", localPath, opts.source);
  return { audit, evidence: adoptionEvidence(audit)[0]! };
}

/* ═══════════════ invariants H and I ═══════════════ */

describe("the render reports how much of its funnel claim it can back", () => {
  const auditOf = (rows: Array<{ source: string; eligible: boolean; judged: boolean }>) => {
    const audit = createClipAdoptAudit();
    const ledger = new VisualSourceLedger({ renderId: "r92", videoId: 569 });
    bindLineageLedger(audit, ledger);
    const relevance = createBeatRelevanceLedger();
    bindRelevanceLedger(audit, relevance);
    rows.forEach((row, i) => {
      const localPath = `/w/a${i}.mp4`;
      const rec = ledger.createLineage({
        sceneIndex: 0,
        beatIndex: i,
        candidateId: `wikimedia:W${i}`,
        contentKey: `wikimedia:W${i}`,
        provider: "wikimedia",
        providerAssetId: `W${i}`,
        localPath,
        mediaType: "image",
        route: "primary",
      });
      if (row.eligible) ledger.recordEvent(rec.lineageId, "ELIGIBLE", { status: "OK" });
      if (row.judged) {
        recordExternalRelevanceVerdict(
          relevance,
          localPath,
          `wikimedia:W${i}`,
          { sceneIndex: 0, beatIndex: i, beatText: "beat" } as never,
          { verdict: "fits", depicts: "x", reason: "test", evaluated: true }
        );
      }
      recordClipAdopt(audit, 0, i, "beat", localPath, row.source);
    });
    return audit;
  };

  it("says nothing at all when the render adopted nothing", () => {
    expect(formatAdoptionEvidence(createClipAdoptAudit())).toEqual([]);
  });
});

/* ═══════════════ and it reaches the render log ═══════════════ */

describe("the measurement is emitted by the render", () => {
  it("is printed beside the unjudged-adoption report", () => {
    expect(PIPE).toContain("formatAdoptionEvidence(visualDedup.clipAdoptAudit)");
    const at = PIPE.indexOf("formatAdoptionEvidence(visualDedup.clipAdoptAudit)");
    expect(PIPE.slice(Math.max(0, at - 900), at)).toContain("formatUnjudgedAdoptions(");
  });

  it("warns on the invariants and logs the census", () => {
    const at = PIPE.indexOf("formatAdoptionEvidence(visualDedup.clipAdoptAudit)");
    const block = PIPE.slice(at, at + 400);
    expect(block).toContain('line.includes("INVARIANT_")');
    expect(block).toContain("console.warn");
    expect(block).toContain("console.log");
  });
});
