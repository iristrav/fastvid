/**
 * EVERY TIME A BEAT GAINS OR LOSES A CLIP, THE LOG SAYS SO — BY IDENTITY.
 *
 * ── The gap this closes ─────────────────────────────────────────────────────────────────────
 *
 * `pushSceneClip` is the narrowest point at which a clip becomes a beat's clip, and every caller
 * does `await pushClip(clip);` and throws the answer away. The moment a beat lost its real asset
 * therefore appeared nowhere in the running log; it could only be inferred afterwards, from a
 * guaranteed filler turning up.
 *
 * VID-0567's beat 0 is the case: a YouTube clip adopted, refused at the push, and the beat filled
 * with `scene_0_slot100_guaranteed.mp4`. The `[VisualCoverage]` line printed just before the filler
 * even claimed `(all real/contextual/AI sourcing strategies exhausted)`, which was the opposite of
 * what happened.
 *
 * ── What is asserted ────────────────────────────────────────────────────────────────────────
 *
 * That both outcomes are traced, at every door into a beat, and that the asset is named by what the
 * ledger PROVED — provider and provider asset id, folded to the root of any derivation — rather
 * than by a path or a position. And that the placeholder line no longer claims exhaustion when a
 * real asset was refused.
 *
 * This round adds observability only. No threshold, gate, ranking, budget or montage was touched.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

const SRC = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

/** The body of `tracePushOutcome`, which is the single writer of the line. */
function traceFn(): string {
  const at = SRC.indexOf("function tracePushOutcome(");
  expect(at, "tracePushOutcome is gone").toBeGreaterThan(-1);
  return SRC.slice(at, SRC.indexOf("\n}", at));
}

describe("the push trace names the asset, not its position", () => {
  it("resolves the clip through the ledger", () => {
    const body = traceFn();
    expect(body).toContain("ledger?.resolve(clipPath, clipContentKey(clipPath))");
  });

  /**
   * Folded to the root, because adoption lands on the fair-use transform's derived child while the
   * identity lives on the root. Without the fold a transformed clip would report no provider.
   */
  it("folds a derivation chain onto its root", () => {
    expect(traceFn()).toContain("ledger.rootOf(record.lineageId)");
  });

  it("prints provider and provider asset id", () => {
    const body = traceFn();
    expect(body).toContain("root.provider");
    expect(body).toContain("root.providerAssetId");
    // Never an array index or a loop counter as identity.
    expect(body).not.toMatch(/asset=\$\{(i|idx|index|ci|bi)\}/);
  });

  /** An unknown clip is an honest gap, never a guessed identity. */
  it("says unknown when the ledger never saw the clip", () => {
    const body = traceFn();
    expect(body).toContain('"unknown"');
    expect(body).toContain("path.basename(clipPath)");
  });

  it("carries scene, beat, acceptance and reason", () => {
    const body = traceFn();
    for (const field of ["scene=", "beat=", "accepted=", "reason=", "lineage="]) {
      expect(body, `the trace line has no ${field}`).toContain(field);
    }
  });
});

describe("both outcomes are traced at every door", () => {
  /** Refusals: the two gates every pushSceneClip opens with. */
  it("traces the relevance-barrier refusal", () => {
    /**
     * ARCHIVE-FIRST ROUND — `beatClipRefusedByRelevanceGate` became a two-part answer.
     *
     * The exported function now asks the editorial question first and the archive question second;
     * the editorial gate's own body moved, unchanged, into `relevanceGateRefusesClip`. This claim
     * is about that body, so it is read there. Nothing about what the gate decides changed.
     */
    const at = SRC.indexOf("async function relevanceGateRefusesClip(");
    const body = SRC.slice(at, SRC.indexOf("\n}", SRC.indexOf("return true;", at)));
    expect(body).toContain("tracePushOutcome(dedup, clipPath, sceneIndex, beatIndex, false, barrier.reason)");
  });

  it("traces the duplicate refusal", () => {
    const at = SRC.indexOf("function noteDuplicateClipRefused(");
    expect(SRC.slice(at, at + 900)).toContain(
      'tracePushOutcome(dedup, clipPath, sceneIndex, beatIndex, false, "duplicate_clip_once_per_video")'
    );
  });
});

describe("the placeholder no longer claims exhaustion when a real asset was refused", () => {
  /**
   * The unconditional claim is gone from the CODE.
   *
   * Scoped to the emitting statement rather than the whole file: a doc comment elsewhere quotes
   * the old line verbatim as the evidence for why it was changed, and a file-wide search would
   * fail on that quotation — punishing the explanation instead of the defect.
   */
  it("does not state exhaustion unconditionally", () => {
    const at = SRC.indexOf("`[VisualCoverage] s${scene.index}b${beat.index}:");
    expect(at, "the placeholder line is gone").toBeGreaterThan(-1);
    const statement = SRC.slice(at, SRC.indexOf(");", at));
    expect(
      statement,
      "the placeholder line asserts exhaustion again without checking"
    ).not.toContain("all real/contextual/AI sourcing strategies exhausted");
  });
});
