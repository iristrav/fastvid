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
 * ── F3: a whole route the outcome writers could not see ──────────────────────────────────────
 *
 * The biggest of the three, found by asking the same question of the OTHER routes. The curated
 * archive route registers its record from the DB row and never registers a path: every terminal
 * outcome writer in the pipeline passed only the path, so all of them wrote nothing for an archive
 * clip. That includes RONDE 165's headline `superseded_by_winner` — inert for exactly the beat its
 * own evidence was about — and RONDE 95's `recordReplacement`, so archive swaps went unrecorded.
 *
 * The record was always reachable: `clipContentKey` maps the filename back to `curated:asset:<id>`.
 * Nobody was passing it. Every writer does now.
 *
 * ── What is deliberately NOT changed ─────────────────────────────────────────────────────────
 *
 * An extension is still never judged against the beat it fills — see the last block. That is a
 * product decision, not a bug to fix quietly.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

import { curatedAssetContentKey } from "./curatedMediaSourcing";
import { formatVisualFitAudit } from "./beatVisualStatus";
import { clipContentKey } from "./videoPipeline";
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

describe("RONDE 167 — F3: the curated route has no path, only a key", () => {
  /**
   * The biggest of the three, and the one that made RONDE 165's headline fix inert.
   *
   * `ensureCuratedAssetLineage` opens the record from the DB row, under the placeholder
   * `archive-asset:<id>` and the asset's content key. `prepareCuratedArchiveClip` then writes
   * `scene_N_bM_curated_a<id>.mp4` and touches the ledger not at all — curatedMediaSourcing.ts
   * contains no reference to `lineage`. So the file on disk has no registered path.
   *
   * `resolve` tries the exact path, the derivation chain, then the content key. Every terminal
   * outcome writer in the pipeline passed only the path. Measured: zero events written.
   *
   * That is exactly the beat render 554's evidence was about — s2b3, three archive runners-up at
   * score 8.0 losing to a loc winner at 8.0 — so RONDE 165 wrote its `superseded_by_winner` for
   * those three into nothing while its test asserted the call's source text and passed.
   */
  const ASSET = 56153;
  const CLIP = "/w/scene_2_b3_curated_a56153.mp4";

  function curatedLedger(): VisualSourceLedger {
    const l = new VisualSourceLedger({ renderId: "r167" });
    const rec = l.createLineage({
      sceneIndex: 2, beatIndex: 3, contentKey: curatedAssetContentKey(ASSET),
      localPath: `archive-asset:${ASSET}`, provider: "bundesarchiv",
    });
    l.recordEvent(rec.lineageId, "SELECTED", { status: "OK" });
    return l;
  }

  it("the file the render writes is not reachable by its own path", () => {
    expect(curatedLedger().resolve(CLIP)).toBeNull();
  });

  it("clipContentKey maps that filename straight back to the record", () => {
    // The record was always reachable; nobody was passing the handle.
    expect(clipContentKey(CLIP)).toBe(curatedAssetContentKey(ASSET));
    expect(curatedLedger().resolve(CLIP, clipContentKey(CLIP))).not.toBeNull();
  });

  it("the bug: an outcome filed by path alone wrote nothing", () => {
    const l = curatedLedger();
    const before = l.allEvents().length;
    recordAssetOutcome(l, CLIP, "superseded_by_winner", "s2b3");
    expect(l.allEvents().length - before).toBe(0);
  });

  it("with the key it writes exactly one, and the asset stops being unaccounted for", () => {
    const l = curatedLedger();
    recordAssetOutcome(l, CLIP, "superseded_by_winner", "s2b3", clipContentKey(CLIP));
    l.markFinalVideo([]);
    expect(l.reconcile().warnings.filter((w) => w.code === "VANISHED_WITHOUT_OUTCOME")).toHaveLength(0);
  });

  it("a replacement of a curated clip is recorded too", () => {
    // recordReplacement resolved by path alone as well, so every archive swap went unrecorded —
    // the silent substitution RONDE 95 §8 exists to catch.
    const l = curatedLedger();
    expect(l.recordReplacement(CLIP, "/w/other.mp4", "healed")).toBe(false);
    expect(
      l.recordReplacement(CLIP, "/w/other.mp4", "healed", { originalContentKey: clipContentKey(CLIP) })
    ).toBe(true);
  });

  it("every outcome writer in the pipeline now passes a content key", () => {
    /**
     * Five writers, one rule. A new one that forgets the key is the same dead-code bug again, and
     * it would pass its own source-text test exactly as RONDE 165's did.
     */
    for (const call of [
      'recordAssetOutcome(dedup.sourcingCache.lineage, p, "invalid_file", `s${sceneIndex}b${beatIndex}`, contentKey)',
      'recordAssetOutcome(dedup.sourcingCache.lineage, p, "transform_failed", `s${sceneIndex}b${beatIndex}`, contentKey)',
      "clipContentKey(candidate.clipPath)",
      "clipContentKey(extended)",
      "originalContentKey: clipContentKey(dropped.path)",
    ]) {
      expect(PIPE, call).toContain(call);
    }
    // The two REMOVED writers R159/R162 added carry it as well.
    expect(
      (PIPE.match(/recordEventForPath\(clipPath, "REMOVED", \{ status: "REMOVED", reason, contentKey: clipContentKey\(clipPath\) \}\)/g) ?? []).length
    ).toBe(2);
  });
});

describe("RONDE 167 — F4: the fit audit was flattering itself", () => {
  const statuses = [
    { sceneIndex: 0, beatIndex: 0, coverage: "own_footage", verification: "verified_fit",
      source: "archive", basename: "good.mp4", verifiedOwnVisual: true, reason: "" },
    { sceneIndex: 1, beatIndex: 6, coverage: "own_footage", verification: "verified_mismatch",
      source: "archive", basename: "vague.mp4", verifiedOwnVisual: false, reason: "x" },
  ] as const;

  it("an unclassified refusal is no longer counted as a soft one", () => {
    /**
     * `classifyMismatch` reads the gate's prose for phrases its own prompt invites. When the model
     * answers in words none of the patterns know, the severity is UNKNOWN and the reprieve is
     * ALLOWED — deliberately, because RONDE 160 proved guessing here is worse. Those beats are
     * exactly where RONDE 166 has no opinion, and reporting them as softMismatch said the
     * opposite: it made the guard look like it had ruled on traffic it never saw.
     */
    const line = formatVisualFitAudit([...statuses], () => "UNKNOWN")[0];
    expect(line).toContain("unclassifiedMismatch=1");
    expect(line).toContain("softMismatch=0");
  });

  it("a real soft mismatch is still a soft mismatch", () => {
    const line = formatVisualFitAudit([...statuses], () => "SOFT_MISMATCH")[0];
    expect(line).toContain("softMismatch=1");
    expect(line).toContain("unclassifiedMismatch=0");
  });

  it("a hard mismatch ON SCREEN with no reprieve is called out", () => {
    /**
     * The other way the invariant breaks, which the reprieve check could not see: there was no
     * reprieve to inspect. `own_footage` + `verified_mismatch` means a refused picture reached the
     * timeline down a path that never met the compose barrier. Video 554 reported four beats in
     * exactly this state and the audit said nothing about any of them.
     */
    const lines = formatVisualFitAudit([...statuses], () => "HARD_MISMATCH");
    expect(lines.some((l) => l.includes("INVARIANT_BROKEN") && l.includes("compose barrier was bypassed")))
      .toBe(true);
  });

  it("a soft mismatch on screen is a fallback, not a violation", () => {
    const lines = formatVisualFitAudit([...statuses], () => "SOFT_MISMATCH");
    expect(lines.some((l) => l.includes("INVARIANT_BROKEN"))).toBe(false);
  });

  it("a placeholder beat that was refused is not blamed on the barrier", () => {
    // Only a beat holding its OWN footage can have walked a refusal past the barrier.
    const onCard = [{ ...statuses[1], coverage: "placeholder" as const }];
    expect(formatVisualFitAudit(onCard, () => "HARD_MISMATCH").some((l) => l.includes("INVARIANT_BROKEN")))
      .toBe(false);
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
