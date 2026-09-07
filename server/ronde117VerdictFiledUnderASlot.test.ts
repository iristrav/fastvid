/**
 * RONDE 117 — THE RENDER THAT CONTRADICTED ITSELF ABOUT THE SAME BEAT.
 *
 * ── The measurement, from one report ────────────────────────────────────────────────────────
 *
 *     [BeatFunnel]  s0b0 visionAsked=8 approved=0 rejected=3 unclear=5
 *     [BeatVisual]  scene=0 beat=0 verification=never_asked reason=real_footage_never_judged
 *
 * Eight judgements on that beat, and the reader that feeds the export gate found none. Video 572
 * did that on all fourteen beats: 58 gate attempts, `verifiedOwnVisual=0`, every beat filed as
 * `real_footage_never_judged`. VID-0573 repeated it — 65 attempts, 15 beats, 0 verified.
 *
 * ── Why the reader could not see them ───────────────────────────────────────────────────────
 *
 * `verificationForBeat` scans the relevance ledger for entries whose `ctx` NAMES the beat. Several
 * fetch routes deliberately offset the slot away from the real beat — `2000 + slot`,
 * `beat.index + attempt * 100`, `si` — and then record the ADOPTION under the real beat. The
 * verdict stays behind on the slot number. `generateGuaranteedBeatClip`'s own note calls that "a
 * drawer `verificationForBeat` never opens", and hands one route a `beatIndex` override; the
 * drawer itself stayed shut for every other route.
 *
 * ── What this file guards ───────────────────────────────────────────────────────────────────
 *
 * That the drawer opens, by ASSET identity, and only where the answer would otherwise have been
 * `never_asked`. It cannot flatter a render: a refusal filed under a slot now reads as
 * `verified_mismatch` and keeps the beat OUT of `verifiedOwnVisual`. Nothing is invented — a
 * verdict that does not exist still reads `never_asked`.
 */
import { describe, expect, it } from "vitest";

import {
  createBeatRelevanceLedger,
  inheritBeatRelevance,
  recordExternalRelevanceVerdict,
  type BeatRelevanceLedger,
} from "./beatVisualRelevance";
import { bindContentKeyResolver, type ClipAdoptEntry } from "./clipAdoptAudit";
import { buildBeatVisualStatuses, formatBeatVisualProblems } from "./beatVisualStatus";

const KEY = "ww2:57364";
const CLIP = "scene_0_b0_curated_a57364.mp4";

/** The adoption, recorded under the REAL beat — which is what every route already does. */
function adoptedOnBeat0(): ClipAdoptEntry[] {
  const audit: ClipAdoptEntry[] = [
    { sceneIndex: 0, beatIndex: 0, source: "archive", basename: CLIP, beatText: "berlin, april 1945" },
  ];
  /** The render binds its own resolver; this is the same seam, with the same key. */
  bindContentKeyResolver(audit, (clipPath) => (clipPath === CLIP ? KEY : ""));
  return audit;
}

/** The verdict, filed under a FETCH SLOT — 2000 + slot, exactly as the offset routes do. */
function judgedUnderSlot(verdict: "fits" | "does_not_fit" | "unknown"): BeatRelevanceLedger {
  const ledger = createBeatRelevanceLedger();
  recordExternalRelevanceVerdict(
    ledger,
    `/w/${CLIP}`,
    KEY,
    { sceneIndex: 0, beatIndex: 2000, beatText: "berlin, april 1945" },
    { verdict, depicts: "a bunker corridor", reason: "test" }
  );
  return ledger;
}

describe("a verdict filed under a slot number is found by the asset it is about", () => {
  it("an approved picture reaches verifiedOwnVisual instead of reading never_asked", () => {
    const [status] = buildBeatVisualStatuses(adoptedOnBeat0(), judgedUnderSlot("fits"));
    expect(status!.verification).toBe("verified_fit");
    expect(status!.verifiedOwnVisual).toBe(true);
    expect(status!.reason).toBe("");
  });

  it("a REFUSED picture reads as the mismatch it is — the stricter answer, not the kinder one", () => {
    const [status] = buildBeatVisualStatuses(adoptedOnBeat0(), judgedUnderSlot("does_not_fit"));
    expect(status!.verification).toBe("verified_mismatch");
    /** The whole point: opening the drawer must never turn a refusal into a verified visual. */
    expect(status!.verifiedOwnVisual).toBe(false);
  });

  it("an UNCLEAR verdict stays unclear and stays out of verifiedOwnVisual", () => {
    const [status] = buildBeatVisualStatuses(adoptedOnBeat0(), judgedUnderSlot("unknown"));
    expect(status!.verification).toBe("unknown");
    expect(status!.verifiedOwnVisual).toBe(false);
  });

  it("no verdict anywhere is still never_asked — nothing is invented", () => {
    const [status] = buildBeatVisualStatuses(adoptedOnBeat0(), createBeatRelevanceLedger());
    expect(status!.verification).toBe("never_asked");
    expect(status!.reason).toBe("real_footage_never_judged");
  });

  it("a verdict about a DIFFERENT asset is not borrowed", () => {
    const ledger = createBeatRelevanceLedger();
    recordExternalRelevanceVerdict(
      ledger,
      "/w/somebody_elses_clip.mp4",
      "ww2:99999",
      { sceneIndex: 0, beatIndex: 2000, beatText: "x" },
      { verdict: "fits", depicts: "", reason: "test" }
    );
    const [status] = buildBeatVisualStatuses(adoptedOnBeat0(), ledger);
    expect(status!.verification).toBe("never_asked");
  });
});

describe("the beat's own verdicts still outrank the asset lookup", () => {
  const beatVerdict = (verdict: "fits" | "does_not_fit"): BeatRelevanceLedger => {
    const ledger = judgedUnderSlot("fits");
    /** A different file, judged ON this beat — the loop must reach this before the asset index. */
    recordExternalRelevanceVerdict(
      ledger,
      "/w/another_candidate.mp4",
      "ww2:11111",
      { sceneIndex: 0, beatIndex: 0, beatText: "berlin, april 1945" },
      { verdict, depicts: "", reason: "test" }
    );
    return ledger;
  };

  it("a beat-scoped refusal is not overwritten by an approval filed under a slot", () => {
    /**
     * The beat scan runs first and its fallback (`onThisBeat`) returns before the asset index is
     * consulted. That ordering is the safety property: the asset lookup can only ever fill a gap.
     */
    const [status] = buildBeatVisualStatuses(adoptedOnBeat0(), beatVerdict("does_not_fit"));
    expect(status!.verification).toBe("verified_mismatch");
  });

  it("and the winner's own beat-scoped verdict still settles it", () => {
    const ledger = createBeatRelevanceLedger();
    recordExternalRelevanceVerdict(
      ledger, `/w/${CLIP}`, KEY,
      { sceneIndex: 0, beatIndex: 0, beatText: "berlin, april 1945" },
      { verdict: "fits", depicts: "", reason: "test" }
    );
    const [status] = buildBeatVisualStatuses(adoptedOnBeat0(), ledger);
    expect(status!.verification).toBe("verified_fit");
  });
});

describe("what the fix does not change", () => {
  it("an audit with no bound resolver behaves exactly as before", () => {
    /** No resolver, no key, no asset lookup — the old answer, unchanged. */
    const audit: ClipAdoptEntry[] = [
      { sceneIndex: 0, beatIndex: 0, source: "archive", basename: CLIP, beatText: "x" },
    ];
    const [status] = buildBeatVisualStatuses(audit, judgedUnderSlot("fits"));
    expect(status!.verification).toBe("never_asked");
  });

  it("a card is still not own footage, however it was judged", () => {
    const audit: ClipAdoptEntry[] = [
      { sceneIndex: 0, beatIndex: 0, source: "subject_fallback", basename: CLIP, beatText: "x" },
    ];
    bindContentKeyResolver(audit, () => KEY);
    const [status] = buildBeatVisualStatuses(audit, judgedUnderSlot("fits"));
    /** `verifiedOwnVisual` is coverage AND verification; a subject card fails the first half. */
    expect(status!.coverage).toBe("subject_only");
    expect(status!.verifiedOwnVisual).toBe(false);
  });
});

/* ═══════════════ which of the two remaining causes it was ═══════════════ */

describe("an unjudged real picture says which lookup came up empty", () => {
  it("names never_judged when the asset is known and the ledger holds nothing for it", () => {
    const [status] = buildBeatVisualStatuses(adoptedOnBeat0(), createBeatRelevanceLedger());
    expect(status!.verification).toBe("never_asked");
    expect(status!.verdictGap).toBe("never_judged");
    expect(formatBeatVisualProblems([status!])[0]).toContain("gap=never_judged");
  });

  it("names no_asset_key when nothing could have been looked up at all", () => {
    /** No resolver bound: the render cannot name this file's asset, so no lookup was possible. */
    const audit: ClipAdoptEntry[] = [
      { sceneIndex: 0, beatIndex: 0, source: "archive", basename: CLIP, beatText: "x" },
    ];
    const [status] = buildBeatVisualStatuses(audit, createBeatRelevanceLedger());
    expect(status!.verdictGap).toBe("no_asset_key");
    expect(formatBeatVisualProblems([status!])[0]).toContain("gap=no_asset_key");
  });

  it("says nothing at all when a verdict was found", () => {
    const [status] = buildBeatVisualStatuses(adoptedOnBeat0(), judgedUnderSlot("fits"));
    expect(status!.verdictGap).toBeUndefined();
    /** Every line that was not about this gap is byte-for-byte what it was. */
    const [refused] = buildBeatVisualStatuses(adoptedOnBeat0(), judgedUnderSlot("does_not_fit"));
    expect(formatBeatVisualProblems([refused!])[0]).not.toContain("gap=");
  });

  it("stays off beats that had no picture to judge", () => {
    const audit: ClipAdoptEntry[] = [
      { sceneIndex: 0, beatIndex: 0, source: "rescue_placeholder", basename: "card.mp4", beatText: "x" },
    ];
    bindContentKeyResolver(audit, () => KEY);
    const [status] = buildBeatVisualStatuses(audit, createBeatRelevanceLedger());
    expect(status!.coverage).toBe("placeholder");
    expect(status!.verdictGap).toBeUndefined();
  });
});

/* ═══════════════ RONDE 118 — the narration has to match too ═══════════════ */

/**
 * A verdict answers "does this picture belong under THESE WORDS". RONDE 117 shipped the asset
 * lookup keyed on identity alone, which would let one beat's answer settle another's — the
 * contamination this round forbids. The beat's TEXT is the guard, and these are its tests.
 */
describe("a verdict earned under different narration is never borrowed", () => {
  const judgedUnderOtherNarration = (): BeatRelevanceLedger => {
    const ledger = createBeatRelevanceLedger();
    recordExternalRelevanceVerdict(
      ledger,
      `/w/${CLIP}`,
      KEY,
      /** Same asset, same slot-shaped index — but a different beat's words. */
      { sceneIndex: 0, beatIndex: 2000, beatText: "he dictated his final will" },
      { verdict: "fits", depicts: "", reason: "test" }
    );
    return ledger;
  };

  it("keeps never_asked when the same asset was approved under another beat's words", () => {
    const [status] = buildBeatVisualStatuses(adoptedOnBeat0(), judgedUnderOtherNarration());
    expect(status!.verification).toBe("never_asked");
    expect(status!.verifiedOwnVisual).toBe(false);
  });

  it("borrows it when the words are this beat's own, whatever index it was filed under", () => {
    const [status] = buildBeatVisualStatuses(adoptedOnBeat0(), judgedUnderSlot("fits"));
    expect(status!.verification).toBe("verified_fit");
  });

  it("will not match on a prefix, a substring or a near miss", () => {
    const ledger = createBeatRelevanceLedger();
    recordExternalRelevanceVerdict(
      ledger, `/w/${CLIP}`, KEY,
      { sceneIndex: 0, beatIndex: 2000, beatText: "berlin, april" },
      { verdict: "fits", depicts: "", reason: "test" }
    );
    const [status] = buildBeatVisualStatuses(adoptedOnBeat0(), ledger);
    expect(status!.verification).toBe("never_asked");
  });

  it("refuses to borrow when either side has no narration to compare", () => {
    const ledger = createBeatRelevanceLedger();
    recordExternalRelevanceVerdict(
      ledger, `/w/${CLIP}`, KEY,
      { sceneIndex: 0, beatIndex: 2000, beatText: "" },
      { verdict: "fits", depicts: "", reason: "test" }
    );
    const [status] = buildBeatVisualStatuses(adoptedOnBeat0(), ledger);
    expect(status!.verification).toBe("never_asked");
  });
});

/* ═══════════════ H — the same asset after a rename or a trim ═══════════════ */

describe("H — a derived copy carries the verdict its source earned", () => {
  it("finds it through the real rename writer, under this beat's words", () => {
    const ledger = createBeatRelevanceLedger();
    /** Judged as downloaded, under a slot index — the shape the offset routes produce. */
    recordExternalRelevanceVerdict(
      ledger,
      "/w/raw_download.mp4",
      KEY,
      { sceneIndex: 0, beatIndex: 2000, beatText: "berlin, april 1945" },
      { verdict: "fits", depicts: "", reason: "test" }
    );
    /** Trimmed, and the pipeline's own writer carries the decision across the rename. */
    inheritBeatRelevance(ledger, "/w/raw_download.mp4", `/w/${CLIP}`);
    const [status] = buildBeatVisualStatuses(adoptedOnBeat0(), ledger);
    expect(status!.verification).toBe("verified_fit");
    expect(status!.verifiedOwnVisual).toBe(true);
  });

  it("and a refusal survives the same rename — a trim cannot launder it", () => {
    const ledger = createBeatRelevanceLedger();
    recordExternalRelevanceVerdict(
      ledger, "/w/raw_download.mp4", KEY,
      { sceneIndex: 0, beatIndex: 2000, beatText: "berlin, april 1945" },
      { verdict: "does_not_fit", depicts: "", reason: "test" }
    );
    inheritBeatRelevance(ledger, "/w/raw_download.mp4", `/w/${CLIP}`);
    const [status] = buildBeatVisualStatuses(adoptedOnBeat0(), ledger);
    expect(status!.verification).toBe("verified_mismatch");
    expect(status!.verifiedOwnVisual).toBe(false);
  });
});
