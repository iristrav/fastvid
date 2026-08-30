/**
 * RONDE 167 — checking whether RONDE 165/166 actually did what they claimed.
 *
 * Both rounds shipped green, and neither had been run against a production render. Re-reading the
 * chain rather than the tests turned up two things that no test could have caught, because both
 * tests and code agreed on a picture that was wrong.
 *
 * ── F1: an ending the audit refused to recognise ─────────────────────────────────────────────
 *
 * `preparePooledArchiveClip` files SELECTED, DOWNLOAD_STARTED, and on failure a DOWNLOAD_FAILED
 * carrying the reason. That is complete bookkeeping: there is no file, so the asset obviously is
 * not in the delivered video, and the ledger says exactly why.
 *
 * The vanished rule accepts REPLACED, REMOVED and a REJECTED status. FAILED is none of those, so
 * every curated asset whose fetch timed out was reported VANISHED_WITHOUT_OUTCOME — a warning
 * naming a real problem the render did not have. Video 554's `scene_N_bM_curated_*` vanished
 * entries are this shape, and RONDE 165 counted them toward `unresolved` while claiming to drive
 * that number to zero.
 *
 * ── F2: an outcome written to nobody ─────────────────────────────────────────────────────────
 *
 * RONDE 165 added, at the point the compose barrier turns an extension away:
 *
 *     recordAssetOutcome(lineage, extended, "extended_rejected", …)
 *
 * `recordAssetOutcome` resolves the path first and is a no-op on a path the ledger does not know.
 * `extendLastClip` writes `extend_s<i>b<j>_<ts>.mp4` and nothing ever registered it: `resolve()`
 * has no basename fallback by design, and the only registrations in the pipeline are adoptClip's
 * transform, the curated bindPath and the pad/overlay pair. Measured: the call wrote ZERO events.
 *
 * It was dead on arrival, and the test that "proved" it asserted the source text of the call
 * rather than its effect — which is exactly the failure mode a source-text assertion has.
 *
 * The same silence had a second cost nobody was looking for. An adopted extension reached the
 * manifest through `recordClipAdopt`'s hole-filling branch, which opens a record with NO provider
 * on purpose. So real Library of Congress footage, looped to fill a beat, was reported UNVERIFIED.
 * Linking the extension fixes the outcome and the provenance in one move, and the provenance is
 * proof rather than inference: the pipeline built that file from that clip itself.
 *
 * ── What is deliberately NOT changed ─────────────────────────────────────────────────────────
 *
 * An extension is still never judged against the beat it fills — see the last block. That is a
 * product decision, not a bug to fix quietly.
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

/** A curated asset as preparePooledArchiveClip records it, up to the point named. */
function curatedAsset(events: Array<[string, string]>): VisualSourceLedger {
  const ledger = new VisualSourceLedger({ renderId: "r167" });
  const rec = ledger.createLineage({
    sceneIndex: 1, beatIndex: 2, localPath: "archive-asset:99", provider: "own_archive",
  });
  for (const [stage, status] of events) {
    ledger.recordEvent(rec.lineageId, stage as never, { status: status as never });
  }
  ledger.markFinalVideo([]);
  return ledger;
}

const vanished = (l: VisualSourceLedger): number =>
  l.reconcile().warnings.filter((w) => w.code === "VANISHED_WITHOUT_OUTCOME").length;

describe("RONDE 167 — a download that never finished is an ending", () => {
  it("the render 554 case: SELECTED then DOWNLOAD_FAILED is fully accounted for", () => {
    expect(vanished(curatedAsset([["SELECTED", "OK"], ["DOWNLOAD_FAILED", "FAILED"]]))).toBe(0);
  });

  it("the lifecycle audit agrees with the rule it reports on", () => {
    // Two different readings of "unresolved" would make the number meaningless.
    const l = curatedAsset([["SELECTED", "OK"], ["DOWNLOAD_FAILED", "FAILED"]]);
    expect(formatAssetLifecycleAudit(l)[0]).toContain("unresolved=0");
    expect(formatAssetLifecycleAudit(l)[0]).toContain("resolved=1");
  });

  it("a failure followed by a successful retry is NOT silenced", () => {
    /**
     * The narrow part of the fix. An asset that failed once, was retried, downloaded and then
     * genuinely disappeared must still be caught — otherwise one early failure buys an asset
     * permanent silence, which is a bigger hole than the one being closed.
     */
    expect(vanished(curatedAsset([
      ["SELECTED", "OK"], ["DOWNLOAD_FAILED", "FAILED"], ["DOWNLOAD_SUCCEEDED", "OK"],
    ]))).toBe(1);
  });

  it("an asset that was simply dropped is still reported", () => {
    expect(vanished(curatedAsset([["SELECTED", "OK"]]))).toBe(1);
  });

  it("the real endings still work", () => {
    const l = new VisualSourceLedger({ renderId: "r167" });
    const rec = l.createLineage({ sceneIndex: 0, beatIndex: 0, localPath: "/w/a.mp4", provider: "loc" });
    l.recordEvent(rec.lineageId, "SELECTED", { status: "OK" });
    recordAssetOutcome(l, "/w/a.mp4", "superseded_by_winner");
    l.markFinalVideo([]);
    expect(vanished(l)).toBe(0);
  });
});

describe("RONDE 167 — the extension is on the record now", () => {
  /** What extendLastClip now does: a real file, linked to the clip it was looped from. */
  function extended(): VisualSourceLedger {
    const l = new VisualSourceLedger({ renderId: "r167" });
    l.createLineage({ sceneIndex: 1, beatIndex: 2, localPath: "/w/src_loc.mp4", provider: "loc" });
    l.linkDerivedPath("/w/extend_s1b3_170.mp4", "/w/src_loc.mp4", "TRANSFORMED", {
      reason: "extendLastClip",
      supersedesParent: false,
    });
    return l;
  }

  it("the bug: an unregistered extension swallowed its own outcome", () => {
    // The RONDE 165 call, on a ledger that has never seen the extension. Zero events.
    const l = new VisualSourceLedger({ renderId: "r167" });
    l.createLineage({ sceneIndex: 1, beatIndex: 2, localPath: "/w/src_loc.mp4", provider: "loc" });
    const before = l.allEvents().length;
    recordAssetOutcome(l, "/w/extend_s1b3_170.mp4", "extended_rejected", "s1b3");
    expect(l.allEvents().length - before).toBe(0);
  });

  it("linked, the same call writes exactly one outcome", () => {
    const l = extended();
    const before = l.allEvents().length;
    recordAssetOutcome(l, "/w/extend_s1b3_170.mp4", "extended_rejected", "s1b3");
    expect(l.allEvents().length - before).toBe(1);
  });

  it("the extension carries its source's proven provider, not UNVERIFIED", () => {
    // Not inference: the pipeline built this file from that clip itself.
    expect(extended().providerFor("/w/extend_s1b3_170.mp4")).toBe("loc");
  });

  it("the source clip keeps its own name — an extension does not retire it", () => {
    /**
     * linkDerivedPath renames the parent to the derived file, which is right for a trim or an
     * overlay, where the new file replaces the old one. Both of these are on screen: the source
     * under its own beat and the extension under the next. Retiring the source's name would
     * mislabel it in the manifest and in every warning that names a file.
     */
    const l = extended();
    const src = l.allRecords().find((r) => !r.parentLineageId)!;
    expect(src.currentFilename).toBe("src_loc.mp4");
  });

  it("extendLastClip links at every path that returns a file", () => {
    // Three: the zoom, the stream copy and the re-encode fallback. A silent one is the bug again.
    const idx = PIPE.indexOf("async function extendLastClip(");
    const block = PIPE.slice(idx, PIPE.indexOf("guaranteedTextOverlayDurationSec", idx));
    expect((block.match(/linkExtension\(\);/g) ?? []).length).toBe(3);
    expect((block.match(/return out;/g) ?? []).length).toBe(3);
    /**
     * And it links the way an extension must: the source clip is not retired by it.
     *
     * Matched inside the linkDerivedPath CALL, not anywhere in the block. A plain toContain here
     * passed against a mutation that removed the option, because the comment above the call also
     * contains the words — the same false-anchor shape RONDE 165's budget test had.
     */
    expect(block).toMatch(/linkDerivedPath\([\s\S]{0,160}?supersedesParent: false,/);
  });

  it("both call sites hand it the ledger — an optional argument nobody passes is dead too", () => {
    expect(PIPE).toContain(
      "extendLastClip(dedup.lastRealClip, holdSec, scene.index, beat.index, workDir, dedup.sourcingCache?.lineage)"
    );
    expect(PIPE).toContain(
      "extendLastClip(source, need, scene.index, 900 + attempt, workDir, dedup.sourcingCache?.lineage)"
    );
  });
});

describe("RONDE 167 — what is still open, stated rather than hidden", () => {
  it("an extension is judged against the beat it was made FOR, never the beat it fills", () => {
    /**
     * KNOWN AND DELIBERATE, recorded here so it cannot be mistaken for an oversight.
     *
     * extendLastClip loops `dedup.lastRealClip` — a picture approved for an EARLIER beat — to fill
     * a beat that found nothing. After the link above, the compose barrier resolves the extension
     * to its source's decision, so it inherits a verdict earned against different narration. Before
     * the link it had no decision at all and the barrier failed open. Neither is a judgement about
     * the beat now on screen; the link changes the bookkeeping, not the coverage.
     *
     * Closing it means judging the extension against the new beat, and this route exists precisely
     * because nothing was found for that beat — so most such judgements would refuse, and the beat
     * would fall to a colour card. That is a product trade the owner has to make, not one to slip
     * in under a bookkeeping round.
     */
    const l = new VisualSourceLedger({ renderId: "r167" });
    l.createLineage({ sceneIndex: 1, beatIndex: 2, localPath: "/w/src.mp4", provider: "loc" });
    l.linkDerivedPath("/w/extend_s1b3_170.mp4", "/w/src.mp4", "TRANSFORMED");
    // Same record, so the same verdict — which was about beat 2, not beat 3.
    expect(l.resolve("/w/extend_s1b3_170.mp4")?.beatIndex).toBe(2);
  });

  it("RONDE 165 and 166 are otherwise intact", () => {
    expect(PIPE).toContain('"superseded_by_winner"');
    expect(PIPE).toContain("formatAssetLifecycleAudit(ledger)");
    expect(PIPE).toContain("const reprieved = reprieveBeatClip(");
    expect(PIPE).toContain("formatVisualFitAudit(");
  });
});
