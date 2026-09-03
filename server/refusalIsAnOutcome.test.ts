/**
 * A CLIP TURNED AWAY AT THE SCENE'S DOOR GETS AN ENDING.
 *
 * ── The hole, and why it could never be read back ───────────────────────────────────────────
 *
 * Every `pushSceneClip` opens with the same two refusals — the beat-relevance barrier, and "this
 * render already used this footage". Both warned to the console and returned false. Neither
 * touched the ledger.
 *
 * That is not merely a missing log line. A clip refused there never enters the scene's clip list,
 * and `noteSceneClipsResourced` — the one place that writes REPLACED when a scene is re-sourced —
 * iterates `previous.clips`. So the asset is invisible to the only pass that could have explained
 * it afterwards. Its record stops at ADOPTED with nothing after it, which is precisely what the
 * audit reports as:
 *
 *     [AssetNotRendered] … reachedAssigned=true outcome=DROPPED_WITHOUT_EVENT
 *
 * Render 567's approved YouTube clip is in that state: adopted for s0b0, absent from the film,
 * the beat filled by `scene_0_slot100_guaranteed.mp4` instead. Whether this gate is what turned
 * THAT clip away is not established — the supplied log begins after sourcing — and this file does
 * not claim it. It closes the hole that makes the question unanswerable for any clip.
 *
 * ── Where the fix lives, and why ────────────────────────────────────────────────────────────
 *
 * There are FOUR `pushSceneClip` definitions and all four open with
 * `beatClipRefusedByRelevanceGate`. Recording inside the callers means remembering it four times,
 * and a fifth for the next one — the seam this codebase keeps splitting on. It is recorded at the
 * single point every route already passes through, so the refusal cannot be made without it.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

import { VisualSourceLedger, formatSelectedButNotRendered } from "./visualSourceLineage";

const SRC = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

/* ═══════════════════════ the ledger keeps the ending ═══════════════════════ */

describe("a refusal ends the asset's story on the ledger", () => {
  const ledgerWithAdoptedClip = () => {
    const ledger = new VisualSourceLedger({ renderId: "r1", videoId: 567 });
    const rec = ledger.createLineage({
      sceneIndex: 0,
      beatIndex: 0,
      candidateId: "youtube_cc:abc",
      contentKey: "youtube_cc:abc",
      provider: "youtube_cc",
      providerAssetId: "abc",
      localPath: "/w/clip.mp4",
      mediaType: "video",
      route: "primary",
    });
    ledger.recordEvent(rec.lineageId, "SELECTED", { status: "OK" });
    ledger.recordEvent(rec.lineageId, "ADOPTED", { status: "OK", currentPath: "/w/clip.mp4" });
    return { ledger, rec };
  };

  it("an adopted clip with no ending is reported as dropped — the state being fixed", () => {
    const { ledger } = ledgerWithAdoptedClip();
    const lines = formatSelectedButNotRendered(ledger.allRecords(), ledger.allEvents(), true);
    expect(lines[0]).toContain("DROPPED_WITHOUT_EVENT");
  });

  it("recording the refusal gives it a terminal outcome instead", () => {
    const { ledger } = ledgerWithAdoptedClip();
    expect(
      ledger.recordRejection("/w/clip.mp4", "duplicate_clip_once_per_video", "youtube_cc:abc"),
      "the ledger could not resolve a clip it opened itself"
    ).toBe(true);
    expect(ledger.hasOutcomeFor("/w/clip.mp4", "youtube_cc:abc")).toBe(true);
  });

  it("the reason travels with it, not a bare DROPPED", () => {
    const { ledger, rec } = ledgerWithAdoptedClip();
    ledger.recordRejection("/w/clip.mp4", "duplicate_clip_once_per_video", "youtube_cc:abc");
    const mine = ledger.allEvents().filter((e) => e.lineageId === rec.lineageId);
    const refusal = mine.find((e) => e.status === "REJECTED");
    expect(refusal, "no REJECTED event was written").toBeTruthy();
    expect(refusal!.reason).toBe("duplicate_clip_once_per_video");
    expect(refusal!.gate).toBe("duplicate_clip_once_per_video");
  });

  /** Provider and beat survive, so the line names an asset a person can act on. */
  it("keeps the identity the audit needs", () => {
    const { ledger } = ledgerWithAdoptedClip();
    ledger.recordRejection("/w/clip.mp4", "off_subject", "youtube_cc:abc");
    const r = ledger.resolve("/w/clip.mp4", "youtube_cc:abc");
    expect(r?.provider).toBe("youtube_cc");
    expect(r?.providerAssetId).toBe("abc");
    expect(r?.sceneIndex).toBe(0);
    expect(r?.beatIndex).toBe(0);
  });

  /** A clip the ledger never knew is an honest miss — never an invented record. */
  it("refuses to invent a record for an unknown clip", () => {
    const ledger = new VisualSourceLedger({ renderId: "r2" });
    expect(ledger.recordRejection("/w/never-seen.mp4", "off_subject")).toBe(false);
    expect(ledger.allRecords()).toHaveLength(0);
  });
});

/* ═══════════════════════ the seam stays closed ═══════════════════════ */

describe("every push route records its refusals", () => {
  /** The relevance barrier records at the one point all four routes call. */
  it("the relevance gate records before it returns true", () => {
    const at = SRC.indexOf("async function beatClipRefusedByRelevanceGate(");
    expect(at).toBeGreaterThan(-1);
    const body = SRC.slice(at, SRC.indexOf("\n}", SRC.indexOf("return true;", at)));
    expect(body).toContain("recordRejection(clipPath, barrier.reason, contentKey)");
    expect(
      body.indexOf("recordRejection"),
      "the refusal returns before it is recorded"
    ).toBeLessThan(body.lastIndexOf("return true;"));
  });

  /**
   * The count is the guard. Four `pushSceneClip` definitions, four duplicate refusals, four
   * recordings — a fifth route added without one makes this fail rather than go quiet.
   */
  it("every duplicate refusal is recorded", () => {
    const defs = SRC.match(/const pushSceneClip = async/g) ?? [];
    const refusals = SRC.match(/if \(dedup\.usedContentKeys\.has\(key\)\)/g) ?? [];
    /**
     * Matched on the call, not on its argument list. The signature has already grown once — the
     * beat's reject tally needs the scene and beat the ledger call did not — and pinning the exact
     * spelling made this test fail for a change that kept the property it exists to guard.
     */
    const records = SRC.match(/noteDuplicateClipRefused\(\s*dedup,\s*clipPath,\s*key\b/g) ?? [];
    expect(defs.length, "the number of push routes changed").toBe(4);
    expect(refusals.length).toBe(4);
    expect(records.length, "a duplicate refusal exists that records nothing").toBe(
      refusals.length
    );
  });

  /** And no duplicate refusal may return before recording. */
  it("no duplicate refusal returns without recording first", () => {
    let from = 0;
    let checked = 0;
    for (;;) {
      const at = SRC.indexOf("if (dedup.usedContentKeys.has(key))", from);
      if (at === -1) break;
      from = at + 1;
      checked++;
      const block = SRC.slice(at, at + 400);
      const record = block.indexOf("noteDuplicateClipRefused");
      const ret = block.indexOf("return false;");
      expect(record, `duplicate refusal #${checked} records nothing`).toBeGreaterThan(-1);
      expect(record, `duplicate refusal #${checked} returns before recording`).toBeLessThan(ret);
    }
    expect(checked).toBe(4);
  });

  /** The helper reads the ledger through the cache, so a render without one is unaffected. */
  it("is a no-op when the render carries no ledger", () => {
    const at = SRC.indexOf("function noteDuplicateClipRefused(");
    expect(at).toBeGreaterThan(-1);
    expect(SRC.slice(at, at + 600)).toContain("dedup.sourcingCache?.lineage?.recordRejection");
  });
});
