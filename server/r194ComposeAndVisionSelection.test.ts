/**
 * R194 — TWO THINGS A RENDER COULD NOT PREVIOUSLY BE ASKED.
 *
 * ── 1. Did every clip compose was handed get an ending? ─────────────────────────────────────
 *
 * The three events have existed for rounds and `returnComposed` writes all of them. What did not
 * exist is the arithmetic: a per-scene line printed three numbers and nothing added them up, so
 * `composeInputs = composeSelected + composeDropped` with `unresolved = 0` was never stated and
 * could not fail. A clip that entered compose and left with no ending at all produced a per-scene
 * line whose numbers still looked plausible.
 *
 * ── 2. Did the picture editor's answer decide anything? ─────────────────────────────────────
 *
 * `beatVisualRelevance` builds every decision as `allowed: verdict !== "does_not_fit"`, which
 * folds "this fits" together with "I cannot tell". `adoptClip` adopted the first candidate whose
 * `allowed` was true — so the search stopped at the first picture the editor merely FAILED TO
 * REFUSE, and a picture it would have called a fit further down the ranked list was never reached.
 *
 * The evidence was gathered, written to the ledger and printed in the log, and then not used for
 * the one decision it exists to inform. These tests are what turns "it is used now" from a claim
 * into a property.
 */
import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

import {
  VisualSourceLedger,
  lifecyclesOf,
  type AssetLifecycle,
} from "./visualSourceLineage";
import {
  composeCensusOf,
  composeCensusViolations,
  formatComposeCensus,
} from "./composeCensus";
import {
  VISION_EVIDENCE_ORDER,
  bestByVisionEvidence,
  buildVisionReviewPool,
  createVisionReviewPoolState,
  declareVisionReviewPool,
  evidenceFromVerdict,
  evidenceTier,
  formatVisionSelection,
  isSelectableEvidence,
  noteVisionAdopted,
  noteVisionReviewed,
  visionAwareFinalShortlist,
  visionSelectionViolations,
  type ReviewedCandidate,
  type VisionEvidence,
} from "./visionAwareSelection";

const PIPE = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

/* ═══════════════════════ §4–§14 — the compose lifecycle, counted ═══════════════════════ */

function composeLedger(renderId = "rA") {
  return new VisualSourceLedger({ renderId, videoId: 574 });
}

function composeAsset(
  ledger: VisualSourceLedger,
  id: string,
  outcome: "selected" | "dropped" | "none",
  reason = "UNKNOWN"
) {
  const rec = ledger.createLineage({
    sceneIndex: 0,
    beatIndex: 0,
    candidateId: `internet_archive:${id}`,
    contentKey: `internet_archive:${id}`,
    provider: "internet_archive",
    providerAssetId: id,
    localPath: `/w/${id}.mp4`,
    mediaType: "video",
    route: "primary",
  });
  ledger.recordEvent(rec.lineageId, "ADOPTED", { status: "OK" });
  ledger.recordEvent(rec.lineageId, "COMPOSE_INPUT", { status: "OK" });
  if (outcome === "selected") {
    ledger.recordEvent(rec.lineageId, "COMPOSE_SELECTED", { status: "OK" });
  } else if (outcome === "dropped") {
    ledger.recordEvent(rec.lineageId, "COMPOSE_DROPPED", { status: "REJECTED", reason });
  }
  return rec;
}

const censusOf = (l: VisualSourceLedger) =>
  composeCensusOf(lifecyclesOf(l.allRecords(), l.allEvents()));

describe("every clip compose was handed is accounted for", () => {
  /** Test A — the round's own worked example. */
  it("three in, one kept, two dropped, nothing unresolved", () => {
    const l = composeLedger();
    composeAsset(l, "a1", "selected");
    composeAsset(l, "a2", "dropped", "duplicate_content");
    composeAsset(l, "a3", "dropped", "compose_gate");
    expect(censusOf(l)).toMatchObject({ inputs: 3, selected: 1, dropped: 2, unresolved: 0 });
  });

  it("the invariant holds and says so", () => {
    const l = composeLedger();
    composeAsset(l, "a1", "selected");
    composeAsset(l, "a2", "dropped", "compose_gate");
    const census = censusOf(l);
    expect(census.inputs).toBe(census.selected + census.dropped + census.unresolved);
    expect(composeCensusViolations(census, { composeCompleted: true })).toEqual([]);
    expect(formatComposeCensus(census)[0]).toContain("outcomeInvariant=PASS");
  });

  /** Test E — a kept clip is selected, and only selected. */
  it("a kept clip counts once, as selected", () => {
    const l = composeLedger();
    composeAsset(l, "a1", "selected");
    expect(censusOf(l)).toMatchObject({ inputs: 1, selected: 1, dropped: 0 });
  });

  /** Test C — the duplicate reason travels with the drop. */
  it("a duplicate is dropped for being a duplicate, not for nothing", () => {
    const l = composeLedger();
    composeAsset(l, "a1", "selected");
    composeAsset(l, "a2", "dropped", "duplicate_content");
    expect(censusOf(l).byReason).toEqual([{ reason: "duplicate_content", count: 1 }]);
  });

  /** Tests B and D — the census reports whichever reason the gate that refused it filed. */
  it.each([
    ["invalid_source_range", "a source range that runs backwards"],
    ["scene_boundary", "a beat that fell outside its scene"],
  ])("carries %s through to the report", (reason) => {
    const l = composeLedger();
    composeAsset(l, "a1", "dropped", reason);
    const census = censusOf(l);
    expect(census.dropped).toBe(1);
    expect(census.byReason[0]).toEqual({ reason, count: 1 });
    expect(formatComposeCensus(census)[1]).toContain(`${reason}×1`);
  });

  it("a clip compose saw and said nothing about is unresolved, and named", () => {
    const l = composeLedger();
    composeAsset(l, "a1", "selected");
    composeAsset(l, "a2", "none");
    const census = censusOf(l);
    expect(census.unresolved).toBe(1);
    expect(census.unresolvedAssets).toEqual(["internet_archive:a2"]);
    expect(
      composeCensusViolations(census, { composeCompleted: true }).join("\n")
    ).toContain("COMPOSE_UNRESOLVED_INPUTS");
  });

  /** §11 — an abandoned compose is not a lifecycle defect, and must not read as one. */
  it("a render that never completed is not accused of losing clips", () => {
    const l = composeLedger();
    composeAsset(l, "a1", "none");
    expect(composeCensusViolations(censusOf(l), { composeCompleted: false })).toEqual([]);
  });

  /** §10 — an asset compose never saw is outside the invariant entirely. */
  it("a candidate that never reached compose is not counted as an input", () => {
    const l = composeLedger();
    const rec = l.createLineage({
      sceneIndex: 0,
      beatIndex: 0,
      candidateId: "pexels:p1",
      contentKey: "pexels:p1",
      provider: "pexels",
      providerAssetId: "p1",
      localPath: "/w/p1.mp4",
      mediaType: "video",
      route: "primary",
    });
    l.recordEvent(rec.lineageId, "ADOPTED", { status: "OK" });
    expect(censusOf(l).inputs).toBe(0);
  });

  /** A derivation chain is one picture. Counting events would count it two or three times. */
  it("a transformed copy is the same input, not a second one", () => {
    const l = composeLedger();
    composeAsset(l, "a1", "none");
    l.linkDerivedPath("/w/a1_transformed.mp4", "/w/a1.mp4", "TRANSFORMED");
    const child = l.resolve("/w/a1_transformed.mp4")!;
    l.recordEvent(child.lineageId, "COMPOSE_INPUT", { status: "OK" });
    l.recordEvent(child.lineageId, "COMPOSE_SELECTED", { status: "OK" });
    expect(censusOf(l)).toMatchObject({ inputs: 1, selected: 1, dropped: 0, unresolved: 0 });
  });

  /** Being in the output is the stronger fact — a later drop must not un-ship a shipped clip. */
  it("a clip kept by one scene and dropped by a later attempt counts as kept", () => {
    const l = composeLedger();
    const rec = composeAsset(l, "a1", "selected");
    l.recordEvent(rec.lineageId, "COMPOSE_DROPPED", { status: "REJECTED", reason: "UNKNOWN" });
    expect(censusOf(l)).toMatchObject({ inputs: 1, selected: 1, dropped: 0 });
  });

  /** Test F — two renders, two ledgers, no shared arithmetic. */
  it("two renders keep their compose accounting apart", () => {
    const a = composeLedger("rA");
    const b = composeLedger("rB");
    composeAsset(a, "a1", "selected");
    composeAsset(a, "a2", "dropped", "compose_gate");
    composeAsset(b, "b1", "selected");
    expect(censusOf(a)).toMatchObject({ inputs: 2, selected: 1, dropped: 1 });
    expect(censusOf(b)).toMatchObject({ inputs: 1, selected: 1, dropped: 0 });
  });

  /** The buckets are exclusive; a census that could double-count would report a false PASS. */
  it("the three buckets are exclusive by construction", () => {
    const l = composeLedger();
    composeAsset(l, "a1", "selected");
    composeAsset(l, "a2", "dropped", "compose_gate");
    composeAsset(l, "a3", "none");
    const c = censusOf(l);
    expect(c.selected + c.dropped + c.unresolved).toBe(c.inputs);
  });

  it("an empty render reports zeroes rather than nothing", () => {
    const census = composeCensusOf([] as AssetLifecycle[]);
    expect(census).toMatchObject({ inputs: 0, selected: 0, dropped: 0, unresolved: 0 });
    expect(formatComposeCensus(census)[0]).toContain("composeInputs=0");
  });
});

/* ═══════════════════════ §5–§13 — instrumented where compose really leaves ═══════════════════════ */

describe("the compose lifecycle is written at the one exit and reported once", () => {
  it("the duplicate reason is established, not guessed", () => {
    const at = PIPE.indexOf("const seenContentKeys = new Set<string>();");
    expect(at, "the duplicate check at the compose exit is gone").toBeGreaterThan(-1);
    const block = PIPE.slice(at, at + 1400);
    expect(block).toContain("const duplicate = seenContentKeys.has(contentKey);");
    expect(block).toContain('reason: duplicate ? "duplicate_content" : "UNKNOWN"');
  });

  it("the render-level census is printed and its violations are errors", () => {
    expect(PIPE).toContain("const composeCensus = composeCensusOf(lifecycles);");
    expect(PIPE).toContain("composeCensusViolations(composeCensus, {");
    expect(PIPE).toContain("composeCompleted: ledger.finalVideoWasVerified,");
  });

  /** §13 — the events live on the render's own ledger; there is no videoId-only lookup. */
  it("the ledger it writes to is the render's own", () => {
    const at = PIPE.indexOf("const composeLedger = composeOptions?.dedup?.sourcingCache?.lineage;");
    expect(at).toBeGreaterThan(-1);
  });
});

/* ═══════════════════════ §15–§27 — the editor's answer picks the tier ═══════════════════════ */

describe("four answers, never folded into two", () => {
  it("a fit is a FIT", () => {
    expect(evidenceFromVerdict({ verdict: "fits", evaluated: true })).toBe("FIT");
  });

  it("a refusal is a MISMATCH", () => {
    expect(evidenceFromVerdict({ verdict: "does_not_fit", evaluated: true })).toBe("MISMATCH");
  });

  it("looked and could not tell is UNCLEAR", () => {
    expect(evidenceFromVerdict({ verdict: "unknown", evaluated: true })).toBe("UNCLEAR");
  });

  /** The distinction `evaluated` was added for, acted on here for the first time. */
  it("never looked is UNREVIEWED, even though it is spelled unknown too", () => {
    expect(evidenceFromVerdict({ verdict: "unknown", evaluated: false })).toBe("UNREVIEWED");
  });

  it("no verdict at all is UNREVIEWED, not a guess in either direction", () => {
    expect(evidenceFromVerdict({})).toBe("UNREVIEWED");
  });

  it("the priority is FIT, then unreviewed, then unclear, then mismatch", () => {
    expect([...VISION_EVIDENCE_ORDER]).toEqual(["FIT", "UNREVIEWED", "UNCLEAR", "MISMATCH"]);
    expect(evidenceTier("FIT")).toBeLessThan(evidenceTier("UNREVIEWED"));
    expect(evidenceTier("UNREVIEWED")).toBeLessThan(evidenceTier("UNCLEAR"));
    expect(evidenceTier("UNCLEAR")).toBeLessThan(evidenceTier("MISMATCH"));
  });

  it("only a mismatch is unselectable", () => {
    expect(isSelectableEvidence("MISMATCH")).toBe(false);
    for (const e of ["FIT", "UNREVIEWED", "UNCLEAR"] as VisionEvidence[]) {
      expect(isSelectableEvidence(e)).toBe(true);
    }
  });

  /** An unrecognised name sorts last. A tier nobody defined is not a promotion. */
  it("an unknown evidence name cannot outrank a real one", () => {
    expect(evidenceTier("SOMETHING_ELSE" as VisionEvidence)).toBeGreaterThan(evidenceTier("MISMATCH"));
  });
});

/* ═══════════════════════ §18–§22, §35 — the bounded, deterministic pool ═══════════════════════ */

const ranked = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ contentKey: `pexels:${i}`, cheapRank: i }));

describe("the review pool is the best-ranked candidates, not the first to arrive", () => {
  /** §35 — ten candidates, a budget of four. */
  it("takes the top four by cheap rank", () => {
    const pool = buildVisionReviewPool(ranked(10), 4);
    expect(pool.map((c) => c.cheapRank)).toEqual([0, 1, 2, 3]);
  });

  it("arrival order does not change it", () => {
    const shuffled = [...ranked(10)].reverse();
    expect(buildVisionReviewPool(shuffled, 4).map((c) => c.cheapRank)).toEqual([0, 1, 2, 3]);
  });

  /** §22 — a tie is broken on canonical identity, never on chance. */
  it("a tie is broken on content key, deterministically", () => {
    const tied = [
      { contentKey: "pexels:zz", cheapRank: 1 },
      { contentKey: "pexels:aa", cheapRank: 1 },
    ];
    expect(buildVisionReviewPool(tied, 1)[0]!.contentKey).toBe("pexels:aa");
    expect(buildVisionReviewPool([...tied].reverse(), 1)[0]!.contentKey).toBe("pexels:aa");
  });

  /** §19/§33 — the pool never promises more looks than the budget allows. */
  it("a hundred eligible candidates on a budget of eight give a pool of eight", () => {
    expect(buildVisionReviewPool(ranked(100), 8)).toHaveLength(8);
  });

  it("a budget of zero asks nobody", () => {
    expect(buildVisionReviewPool(ranked(10), 0)).toEqual([]);
  });

  it("fewer candidates than budget is the whole list", () => {
    expect(buildVisionReviewPool(ranked(3), 8)).toHaveLength(3);
  });

  it("the same input gives the same pool every time", () => {
    const a = buildVisionReviewPool(ranked(20), 5).map((c) => c.contentKey);
    const b = buildVisionReviewPool(ranked(20), 5).map((c) => c.contentKey);
    expect(a).toEqual(b);
  });

  it("it does not mutate what it was handed", () => {
    const input = [...ranked(5)].reverse();
    const before = input.map((c) => c.contentKey);
    buildVisionReviewPool(input, 3);
    expect(input.map((c) => c.contentKey)).toEqual(before);
  });
});

/* ═══════════════════════ §24, §34 — FIT beats a better cheap rank ═══════════════════════ */

const reviewed = (
  rows: Array<[string, number, VisionEvidence]>
): ReviewedCandidate[] =>
  rows.map(([contentKey, cheapRank, evidence]) => ({ contentKey, cheapRank, evidence }));

describe("the final shortlist is built from the evidence, not from the ranking alone", () => {
  /** §34's exact case. */
  it("a FIT at rank 5 beats a MISMATCH at rank 1 and an UNCLEAR at rank 2", () => {
    const best = bestByVisionEvidence(
      reviewed([
        ["a", 1, "MISMATCH"],
        ["b", 5, "FIT"],
        ["c", 2, "UNCLEAR"],
      ])
    );
    expect(best?.contentKey).toBe("b");
  });

  it("and the order of the whole list says why", () => {
    const order = visionAwareFinalShortlist(
      reviewed([
        ["a", 1, "MISMATCH"],
        ["b", 5, "FIT"],
        ["c", 2, "UNCLEAR"],
        ["d", 9, "UNREVIEWED"],
      ])
    ).map((c) => c.contentKey);
    expect(order).toEqual(["b", "d", "c", "a"]);
  });

  /** §27 — an unreviewed candidate carries no evidence; a failed look is weak negative evidence. */
  it("never-looked outranks looked-and-could-not-tell", () => {
    const best = bestByVisionEvidence(
      reviewed([
        ["c", 0, "UNCLEAR"],
        ["d", 7, "UNREVIEWED"],
      ])
    );
    expect(best?.contentKey).toBe("d");
  });

  it("within one tier the cheap ranking still decides", () => {
    const best = bestByVisionEvidence(
      reviewed([
        ["late", 6, "FIT"],
        ["early", 2, "FIT"],
      ])
    );
    expect(best?.contentKey).toBe("early");
  });

  /** §25 — a refused picture is never simply selected. */
  it("a mismatch is not selectable, even when it is all there is", () => {
    expect(bestByVisionEvidence(reviewed([["a", 0, "MISMATCH"]]))).toBeNull();
  });

  /** But it stays on the list, because the reprieve needs something to overrule. */
  it("a mismatch stays on the shortlist, last", () => {
    const order = visionAwareFinalShortlist(
      reviewed([
        ["a", 0, "MISMATCH"],
        ["b", 9, "UNCLEAR"],
      ])
    ).map((c) => c.contentKey);
    expect(order).toEqual(["b", "a"]);
  });

  it("an empty review produces no choice rather than a default one", () => {
    expect(bestByVisionEvidence([])).toBeNull();
  });
});

/* ═══════════════════════ §36, §39, §40 — the record, per beat and per render ═══════════════════════ */

describe("the pool is beat-scoped, render-scoped and reported", () => {
  function beatWith(cap = 8) {
    const state = createVisionReviewPoolState();
    declareVisionReviewPool(state, 0, 0, ranked(20), cap);
    for (let i = 0; i < cap; i++) {
      noteVisionReviewed(state, 0, 0, {
        contentKey: `pexels:${i}`,
        cheapRank: i,
        evidence: i === 3 ? "FIT" : "UNCLEAR",
      });
    }
    return state;
  }

  /** §36 — twenty eligible, a pool of eight, eight reviewed: twelve were never looked at. */
  it("the report says how many eligible candidates nobody looked at", () => {
    const state = beatWith(8);
    const line = formatVisionSelection(state)[0]!;
    expect(line).toContain("reviewPool=8");
    expect(line).toContain("reviewed=8");
    expect(line).toContain("FIT=1");
    expect(line).toContain("UNCLEAR=7");
  });

  it("the beat line names the best evidence it found and what it used", () => {
    const state = beatWith(8);
    noteVisionAdopted(state, 0, 0, "pexels:3");
    const line = formatVisionSelection(state)[0]!;
    expect(line).toContain("best=FIT@rank3");
    expect(line).toContain("adopted=pexels:3");
  });

  /** §40 — one beat's pool can never reach another's. */
  it("two beats hold separate pools", () => {
    const state = createVisionReviewPoolState();
    noteVisionReviewed(state, 0, 0, { contentKey: "a", cheapRank: 0, evidence: "FIT" });
    noteVisionReviewed(state, 0, 1, { contentKey: "b", cheapRank: 0, evidence: "MISMATCH" });
    expect(bestByVisionEvidence(state.beats.get("0:0")!.reviewed)?.contentKey).toBe("a");
    expect(bestByVisionEvidence(state.beats.get("0:1")!.reviewed)).toBeNull();
  });

  /** §39 — the state is created per render; two states share nothing. */
  it("two renders hold separate pools", () => {
    const a = createVisionReviewPoolState();
    const b = createVisionReviewPoolState();
    noteVisionReviewed(a, 0, 0, { contentKey: "a", cheapRank: 0, evidence: "FIT" });
    expect(b.beats.size).toBe(0);
  });

  it("re-answering a candidate replaces its verdict rather than counting it twice", () => {
    const state = createVisionReviewPoolState();
    noteVisionReviewed(state, 0, 0, { contentKey: "a", cheapRank: 0, evidence: "UNCLEAR" });
    noteVisionReviewed(state, 0, 0, { contentKey: "a", cheapRank: 0, evidence: "FIT" });
    expect(state.beats.get("0:0")!.reviewed).toHaveLength(1);
    expect(state.beats.get("0:0")!.reviewed[0]!.evidence).toBe("FIT");
  });

  it("a route that declares second does not overwrite the first cut", () => {
    const state = createVisionReviewPoolState();
    declareVisionReviewPool(state, 0, 0, ranked(20), 4);
    declareVisionReviewPool(state, 0, 0, ranked(20).reverse(), 4);
    expect(state.beats.get("0:0")!.declared).toEqual([
      "pexels:0",
      "pexels:1",
      "pexels:2",
      "pexels:3",
    ]);
  });

  it("a render with no pools prints nothing — silence is not a zero", () => {
    expect(formatVisionSelection(createVisionReviewPoolState())).toEqual([]);
    expect(formatVisionSelection(undefined)).toEqual([]);
  });
});

/* ═══════════════════════ the invariants that can fail ═══════════════════════ */

describe("the selection can be checked against its own evidence", () => {
  it("a healthy beat reports nothing", () => {
    const state = createVisionReviewPoolState();
    declareVisionReviewPool(state, 0, 0, ranked(4), 8);
    noteVisionReviewed(state, 0, 0, { contentKey: "pexels:0", cheapRank: 0, evidence: "FIT" });
    noteVisionAdopted(state, 0, 0, "pexels:0");
    expect(visionSelectionViolations(state)).toEqual([]);
  });

  /** §24 as an invariant, not only as an ordering. */
  it("a beat that passed over a FIT is named", () => {
    const state = createVisionReviewPoolState();
    noteVisionReviewed(state, 0, 0, { contentKey: "good", cheapRank: 5, evidence: "FIT" });
    noteVisionReviewed(state, 0, 0, { contentKey: "meh", cheapRank: 0, evidence: "UNCLEAR" });
    noteVisionAdopted(state, 0, 0, "meh");
    expect(visionSelectionViolations(state).join("\n")).toContain("FIT_NOT_PREFERRED");
  });

  /** §25 — the reprieve is legitimate; a reprieve over an available candidate is not. */
  it("a refused picture used while an unrefused one was available is named", () => {
    const state = createVisionReviewPoolState();
    noteVisionReviewed(state, 0, 0, { contentKey: "bad", cheapRank: 0, evidence: "MISMATCH" });
    noteVisionReviewed(state, 0, 0, { contentKey: "ok", cheapRank: 4, evidence: "UNCLEAR" });
    noteVisionAdopted(state, 0, 0, "bad");
    expect(visionSelectionViolations(state).join("\n")).toContain(
      "MISMATCH_ADOPTED_OVER_AVAILABLE"
    );
  });

  it("a beat whose every candidate was refused may use one, and is not accused", () => {
    const state = createVisionReviewPoolState();
    noteVisionReviewed(state, 0, 0, { contentKey: "bad", cheapRank: 0, evidence: "MISMATCH" });
    noteVisionAdopted(state, 0, 0, "bad");
    expect(visionSelectionViolations(state)).toEqual([]);
  });

  /** §19/§33 — the budget invariant exists and can fail. */
  it("a pool larger than the budget is a violation", () => {
    const state = createVisionReviewPoolState();
    const pool = state.beats;
    declareVisionReviewPool(state, 0, 0, ranked(4), 4);
    pool.get("0:0")!.declared.push("pexels:99");
    expect(visionSelectionViolations(state).join("\n")).toContain("REVIEW_POOL_OVER_BUDGET");
  });

  it("more asks than the budget is a violation", () => {
    const state = createVisionReviewPoolState();
    declareVisionReviewPool(state, 0, 0, ranked(2), 2);
    for (let i = 0; i < 3; i++) {
      noteVisionReviewed(state, 0, 0, {
        contentKey: `pexels:${i}`,
        cheapRank: i,
        evidence: "UNCLEAR",
      });
    }
    expect(visionSelectionViolations(state).join("\n")).toContain("REVIEWED_OVER_BUDGET");
  });

  it("a beat that adopted something it never reviewed is not falsely accused", () => {
    const state = createVisionReviewPoolState();
    noteVisionReviewed(state, 0, 0, { contentKey: "a", cheapRank: 0, evidence: "UNCLEAR" });
    noteVisionAdopted(state, 0, 0, "from_another_route");
    expect(visionSelectionViolations(state)).toEqual([]);
  });
});

/* ═══════════════════════ §28, §29, §41 — adoption reads the evidence ═══════════════════════ */

describe("the adoption loop really uses the verdict", () => {
  const adoptBlock = (): string => {
    const at = PIPE.indexOf("async function adoptClip(");
    expect(at, "adoptClip is gone").toBeGreaterThan(-1);
    return PIPE.slice(at, PIPE.indexOf("\n}\n", at));
  };

  /** §28 — the shortlist is settled after the verdict, not before it. */
  it("a candidate weaker than FIT is held and the search continues", () => {
    const b = adoptBlock();
    expect(b).toContain('if (beatEvidence !== "FIT" && firstLookAtCandidate) {');
    expect(b).toContain("heldForWeakEvidence.add(p);");
  });

  /** §29 — the evidence comes from the ledger the judge writes to, not from a second question. */
  it("it reads the verdict back rather than re-judging", () => {
    const b = adoptBlock();
    expect(b).toContain("beatVisionEvidenceFor(dedup, p, contentKey, sceneIndex, beatIndex)");
    expect(PIPE).toContain("return found ? evidenceFromVerdict(found) : \"UNREVIEWED\";");
  });

  /** §27 — the ordering between the weak tiers is decided, not left to arrival order. */
  it("a held candidate waits while something strictly better is unresolved", () => {
    const b = adoptBlock();
    expect(b).toContain("betterEvidencePending(p, beatEvidence)");
    expect(b).toContain("postponedForBetterEvidence.add(p);");
  });

  /** §19 — the route that adopts now feeds the bound it was already consulting. */
  it("the adoption route admits to the same shortlist it checks", () => {
    const b = adoptBlock();
    /** Whitespace-tolerant: the call gained a SOURCE argument and now spans lines. */
    expect(b.replace(/\s+/g, " ")).toContain(
      "admitToShortlist( dedup.beatShortlist, sceneIndex, beatIndex, contentKey, undefined,"
    );
    expect(b).toContain("beatShortlistExhausted(dedup.beatShortlist");
    expect(b).toContain("noteVisionAsked(dedup.beatShortlist, sceneIndex, beatIndex, contentKey)");
  });

  /** §37 — the cap is the existing one. Raising it is not this round's answer. */
  it("the pool is declared with the existing per-beat cap", () => {
    const b = adoptBlock();
    const at = b.indexOf("declareVisionReviewPool(");
    expect(at).toBeGreaterThan(-1);
    expect(b.slice(at, at + 400)).toContain("maxShortlistPerBeat()");
    const shortlist = readFileSync(path.join(__dirname, "beatShortlist.ts"), "utf8");
    expect(shortlist).toContain("MAX_JUDGEMENTS_PER_BEAT * 2");
  });

  /** §29 — the beat's choice is filed where it can be checked against the evidence. */
  it("what the beat adopted is recorded on the pool", () => {
    expect(adoptBlock()).toContain(
      "noteVisionAdopted(dedup.visionReviewPool, sceneIndex, beatIndex, contentKey);"
    );
  });

  /** §39 — render-scoped state, held where every other per-beat ledger is held. */
  it("the pool lives on the render's dedup state, not in a module variable", () => {
    expect(PIPE).toContain("visionReviewPool: createVisionReviewPoolState(),");
    expect(PIPE).toContain("visionReviewPool: VisionReviewPoolState;");
    const module = readFileSync(path.join(__dirname, "visionAwareSelection.ts"), "utf8");
    expect(module).not.toMatch(/^let \w+/m);
    expect(module).not.toContain("Math.random()");
  });

  /**
   * §45 — ONE STATEMENT OF THE PRIORITY, TWO THINGS READING IT.
   *
   * The loop is incremental: standing at candidate 3 it cannot know what candidate 7 will answer,
   * so it cannot call `bestByVisionEvidence` and be done. It implements the same policy through
   * its own queue — which is exactly the seam this codebase keeps splitting on.
   *
   * Two things stop that becoming a drift. The ORDERING has a single definition
   * (`VISION_EVIDENCE_ORDER`, read through `evidenceTier`) and the loop reads it rather than
   * spelling the tiers again. And the pure function CHECKS the loop after the fact: the beat's
   * actual choice is filed on the pool, and `visionSelectionViolations` compares it against
   * `bestByVisionEvidence`, so the two disagreeing is a reported defect rather than a silence.
   */
  it("the loop and the pure rule share one definition of the priority", () => {
    const b = adoptBlock();
    expect(b).toContain("evidenceTier(otherEvidence) < evidenceTier(own)");
    expect(b).not.toMatch(/"UNREVIEWED"\s*\?\s*\d/);
    const module = readFileSync(path.join(__dirname, "visionAwareSelection.ts"), "utf8");
    expect(module).toContain("VISION_EVIDENCE_ORDER.indexOf(evidence)");
    /** And the check that would catch them disagreeing is wired into the render's report. */
    expect(PIPE).toContain("visionSelectionViolations(visualDedup.visionReviewPool)");
    expect(module).toContain("const best = bestByVisionEvidence(pool.reviewed);");
  });

  /** §45 — one selection path. A second `allowed`-only adoption would be the regression. */
  it("the loop no longer adopts on allowed alone", () => {
    const b = adoptBlock();
    const gate = b.indexOf("beatClipPassesImageGate(p, contentKey");
    const evidence = b.indexOf("const beatEvidence: VisionEvidence");
    const accept = b.indexOf("dedup.usedPaths.add(p);");
    expect(gate).toBeGreaterThan(-1);
    expect(evidence, "the verdict is not read between the gate and the acceptance").toBeGreaterThan(gate);
    expect(evidence, "the verdict is read after the clip is already accepted").toBeLessThan(accept);
  });
});
