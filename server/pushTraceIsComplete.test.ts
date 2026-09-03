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
    const at = SRC.indexOf("async function beatClipRefusedByRelevanceGate(");
    const body = SRC.slice(at, SRC.indexOf("\n}", SRC.indexOf("return true;", at)));
    expect(body).toContain("tracePushOutcome(dedup, clipPath, sceneIndex, beatIndex, false, barrier.reason)");
  });

  it("traces the duplicate refusal", () => {
    const at = SRC.indexOf("function noteDuplicateClipRefused(");
    expect(SRC.slice(at, at + 900)).toContain(
      'tracePushOutcome(dedup, clipPath, sceneIndex, beatIndex, false, "duplicate_clip_once_per_video")'
    );
  });

  /**
   * Acceptances: every writer of `clipBeatIndices`. The count is the guard — a new route that
   * assigns a beat without tracing it fails here instead of going quiet.
   *
   * Note that one of these is NOT a `pushSceneClip`: a re-seeding loop rebuilds a scene's clip
   * list from the adopt audit and assigns beats without passing the push gates. It is traced with
   * the same line and its own reason, because a reader following one asset must see every moment
   * it was given a beat, whichever door it came through.
   */
  it("traces every acceptance", () => {
    const assigns = SRC.match(/clipBeatIndices\.push\(/g) ?? [];
    const traces = SRC.match(/tracePushOutcome\([^)]*true,\s*"accepted/g) ?? [];
    expect(assigns.length, "the number of beat-assignment sites changed").toBe(5);
    expect(
      traces.length,
      "a route assigns a beat without tracing it"
    ).toBe(assigns.length - 1);
  });

  /** The re-seed door is labelled, so it is not mistaken for a gated push. */
  it("distinguishes the re-seeding door", () => {
    expect(SRC).toContain('true, "accepted_reseed"');
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

  it("chooses its reason from the beat's own reject tally", () => {
    const at = SRC.indexOf("const fallbackReason =");
    expect(at).toBeGreaterThan(-1);
    const body = SRC.slice(at, at + 400);
    expect(body).toContain("rejectedHere > 0");
    expect(body).toContain("REAL_ASSET_REJECTED");
    expect(body).toContain("ALL_SOURCING_EXHAUSTED");
    // The rejected branch must be the one that fires when something was refused.
    expect(body.indexOf("REAL_ASSET_REJECTED")).toBeLessThan(body.indexOf("ALL_SOURCING_EXHAUSTED"));
  });

  it("prints the chosen reason rather than a fixed string", () => {
    expect(SRC).toContain("fallbackReason=${fallbackReason}");
  });
});
