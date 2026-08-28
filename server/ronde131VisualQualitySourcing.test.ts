/**
 * RONDE 131 — the refusal explains itself, and the render acts on it.
 *
 * These tests are written against the numbers video 546 actually produced: 34 gate questions, 34
 * real answers, 21 of them `does_not_fit`, and a raw visual quality score of 17/100. The round's
 * claim is that the twenty-one refusals carried a usable diagnosis that was being thrown away.
 *
 * What is proved here, in order:
 *
 *   1-9    the classifier reads real gate wording, and refuses to guess when it cannot.
 *   10-13  fault attribution — does this indict the question or the material.
 *   14-20  the reorder is a permutation, is stable, and is a tie-break rather than an override.
 *   21-25  the tally, the split, and the two log surfaces.
 *   M1-M5  mutations: each guard removed makes a named test fail.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { describe, it, expect } from "vitest";
import {
  classifyMismatch,
  createMismatchTally,
  formatMismatchFeedback,
  formatMismatchSummary,
  mismatchFault,
  mismatchFaultSplit,
  mismatchWasPreventableBySearch,
  recordMismatch,
  reorderAfterMismatch,
  reorderChangedOrder,
  sourcePreferenceForMismatch,
  summarizeMismatchKinds,
  type MismatchKind,
} from "./visualMismatchFeedback";

/** A candidate as the funnel holds it: the shape, not the whole thing. */
const cand = (id: string, source: string) => ({ id, source });

describe("RONDE 131 — classifying what the picture editor said", () => {
  it("1. reads a period error stated in the reason", () => {
    // RONDE 135 split present-day wording out as MODERN_FOOTAGE — a period fault still, with the
    // same QUESTION blame and the same correction, counted separately so a render can tell a
    // modern catalogue from an archive that reached for the wrong decade.
    const kind = classifyMismatch({
      depicts: "a city street with cars",
      reason: "this is present-day footage under narration about Berlin in April 1945",
    });
    expect(kind).toBe("MODERN_FOOTAGE");
    expect(mismatchFault(kind)).toBe("QUESTION");
  });

  it("2. reads a period error stated only in depicts", () => {
    const kind = classifyMismatch({
      depicts: "a modern city street with parked cars and road markings, filmed in colour",
      reason: "it does not belong here",
    });
    expect(kind).toBe("MODERN_FOOTAGE");
    expect(mismatchFault(kind)).toBe("QUESTION");
  });

  it("2b. a decade error with no present-day wording stays WRONG_PERIOD", () => {
    expect(
      classifyMismatch({
        depicts: "a newsreel of marching troops",
        reason: "this is a different decade from the one the narration describes",
      })
    ).toBe("WRONG_PERIOD");
  });

  it("3. recognises a title card as a material problem, not a period one", () => {
    // Both words are present. The MATERIAL fault must win: the query was answered, the asset is
    // text. RONDE 135 split the text kinds — a frame that IS text is TITLE_CARD, text OVER
    // footage is TEXT_ON_SCREEN — so the assertion is on the fault, plus the exact kind.
    const kind = classifyMismatch({
      depicts: "a modern title card with white lettering on black",
      reason: "the frame is a title card rather than footage",
    });
    expect(kind).toBe("TITLE_CARD");
    expect(mismatchFault(kind)).toBe("MATERIAL");
  });

  it("4. recognises a person addressing the camera", () => {
    expect(
      classifyMismatch({
        depicts: "a man talking to camera in front of a bookshelf",
        reason: "this is commentary, not archive footage",
      })
    ).toBe("TALKING_HEAD");
  });

  it("5. recognises a wrong subject", () => {
    expect(
      classifyMismatch({
        depicts: "a portrait of an unidentified officer",
        reason: "this is a different person from the one the narration names",
      })
    ).toBe("WRONG_SUBJECT");
  });

  it("6. recognises a wrong place", () => {
    expect(
      classifyMismatch({
        depicts: "a harbour with fishing boats",
        reason: "a different country entirely — nothing to do with the story",
      })
    ).toBe("WRONG_PLACE");
  });

  it("7. falls back to UNRELATED when the refusal is generic", () => {
    expect(
      classifyMismatch({ depicts: "a field of sunflowers", reason: "unrelated to the narration" })
    ).toBe("UNRELATED");
  });

  it("8. returns UNCLEAR rather than guessing when the words say nothing", () => {
    expect(classifyMismatch({ depicts: "a grey image", reason: "no" })).toBe("UNCLEAR");
    expect(classifyMismatch({})).toBe("UNCLEAR");
    expect(classifyMismatch({ depicts: "", reason: "   " })).toBe("UNCLEAR");
  });

  it("9. is case-insensitive, because the model capitalises where it likes", () => {
    expect(classifyMismatch({ reason: "Different country entirely." })).toBe("WRONG_PLACE");
    // RONDE 135: present-day wording is MODERN_FOOTAGE, a watermark/logo is TEXT_ON_SCREEN.
    expect(classifyMismatch({ reason: "Modern footage." })).toBe("MODERN_FOOTAGE");
    expect(classifyMismatch({ reason: "A LOGO fills the frame." })).toBe("TEXT_ON_SCREEN");
  });
});

describe("RONDE 131 — where the fault lies", () => {
  it("10. period, place, subject and unrelated indict the QUESTION", () => {
    for (const k of ["WRONG_PERIOD", "WRONG_PLACE", "WRONG_SUBJECT", "UNRELATED"] as MismatchKind[]) {
      expect(mismatchFault(k)).toBe("QUESTION");
      expect(mismatchWasPreventableBySearch(k)).toBe(true);
    }
  });

  it("11. text on screen and talking heads indict the MATERIAL", () => {
    for (const k of ["TEXT_ON_SCREEN", "TALKING_HEAD"] as MismatchKind[]) {
      expect(mismatchFault(k)).toBe("MATERIAL");
      expect(mismatchWasPreventableBySearch(k)).toBe(false);
    }
  });

  it("12. an unclassified refusal indicts nothing", () => {
    expect(mismatchFault("UNCLEAR")).toBe("UNKNOWN");
    expect(mismatchWasPreventableBySearch("UNCLEAR")).toBe(false);
  });

  it("13. every kind has a fault — no kind falls through the switch", () => {
    const kinds: MismatchKind[] = [
      "WRONG_PERIOD", "WRONG_SUBJECT", "WRONG_PLACE",
      "TEXT_ON_SCREEN", "TALKING_HEAD", "UNRELATED", "UNCLEAR",
    ];
    for (const k of kinds) {
      expect(["QUESTION", "MATERIAL", "UNKNOWN"]).toContain(mismatchFault(k));
    }
  });
});

describe("RONDE 131 — the reorder is a permutation, never a filter", () => {
  const field = [
    cand("a", "pexels"),
    cand("b", "wikimedia"),
    cand("c", "pixabay"),
    cand("d", "nara"),
    cand("e", "youtube"),
  ];

  it("14. returns every candidate that went in, for every kind", () => {
    const kinds: MismatchKind[] = [
      "WRONG_PERIOD", "WRONG_SUBJECT", "WRONG_PLACE",
      "TEXT_ON_SCREEN", "TALKING_HEAD", "UNRELATED", "UNCLEAR",
    ];
    for (const k of kinds) {
      const out = reorderAfterMismatch(field, k);
      expect(out).toHaveLength(field.length);
      expect(new Set(out.map((c) => c.id))).toEqual(new Set(field.map((c) => c.id)));
    }
  });

  it("15. on a period error, archives lead and modern stock goes last", () => {
    const out = reorderAfterMismatch(field, "WRONG_PERIOD").map((c) => c.id);
    // b (wikimedia) and d (nara) are historical; a (pexels) and c (pixabay) are modern stock;
    // e (youtube) is neither, so it keeps the middle.
    expect(out).toEqual(["b", "d", "e", "a", "c"]);
  });

  it("16. on a title card, upload-shaped sources go last and nothing is promoted", () => {
    const out = reorderAfterMismatch(field, "TEXT_ON_SCREEN").map((c) => c.id);
    expect(out).toEqual(["a", "b", "c", "d", "e"].filter((id) => id !== "e").concat("e"));
  });

  it("17. keeps the incoming order inside each group — the existing ranking survives", () => {
    const many = [
      cand("s1", "pexels"), cand("s2", "pexels"), cand("s3", "pexels"),
      cand("h1", "loc"), cand("h2", "wikimedia"),
    ];
    const out = reorderAfterMismatch(many, "WRONG_PERIOD").map((c) => c.id);
    expect(out).toEqual(["h1", "h2", "s1", "s2", "s3"]);
  });

  it("18. a kind with no source preference returns the order untouched", () => {
    for (const k of ["WRONG_SUBJECT", "WRONG_PLACE", "UNRELATED", "UNCLEAR"] as MismatchKind[]) {
      expect(sourcePreferenceForMismatch(k).prefer.size).toBe(0);
      expect(sourcePreferenceForMismatch(k).avoid.size).toBe(0);
      expect(reorderAfterMismatch(field, k).map((c) => c.id)).toEqual(field.map((c) => c.id));
    }
  });

  it("19. reads the source through a caller-supplied accessor", () => {
    const wrapped = field.map((c) => ({ candidate: c, clipPath: `/tmp/${c.id}.mp4` }));
    const out = reorderAfterMismatch(wrapped, "WRONG_PERIOD", (w) => w.candidate.source);
    expect(out.map((w) => w.candidate.id)).toEqual(["b", "d", "e", "a", "c"]);
  });

  it("20. a source in both the prefer and avoid sets resolves to prefer", () => {
    // internet_archive is a historical archive AND upload-shaped. On a period error the
    // historical reading is the one that argues for it.
    const both = [cand("x", "pexels"), cand("y", "internet_archive")];
    expect(reorderAfterMismatch(both, "WRONG_PERIOD").map((c) => c.id)).toEqual(["y", "x"]);
    // On a title card it is the upload reading that applies, and it goes last.
    expect(reorderAfterMismatch(both, "TEXT_ON_SCREEN").map((c) => c.id)).toEqual(["x", "y"]);
  });

  it("21. reorderChangedOrder tells a real reorder from a no-op", () => {
    const before = reorderAfterMismatch(field, "UNCLEAR");
    expect(reorderChangedOrder(field, before)).toBe(false);
    const after = reorderAfterMismatch(field, "WRONG_PERIOD");
    expect(reorderChangedOrder(field, after)).toBe(true);
    // A single-provider beat cannot be reordered, and must not claim it was.
    const one = [cand("p", "pexels"), cand("q", "pexels")];
    expect(reorderChangedOrder(one, reorderAfterMismatch(one, "WRONG_PERIOD"))).toBe(false);
  });
});

describe("RONDE 131 — the tally, which is what video 546 could not produce", () => {
  it("22. counts by kind and keeps one quotable example each", () => {
    const tally = createMismatchTally();
    recordMismatch(tally, {
      kind: "WRONG_PERIOD", source: "pexels",
      depicts: "a modern street", reason: "present-day footage",
    });
    recordMismatch(tally, {
      kind: "WRONG_PERIOD", source: "Pixabay",
      depicts: "a modern office", reason: "contemporary",
    });
    recordMismatch(tally, { kind: "TEXT_ON_SCREEN", source: "youtube", reason: "a title card" });

    expect(tally.total).toBe(3);
    expect(tally.byKind.get("WRONG_PERIOD")).toBe(2);
    expect(tally.byKind.get("TEXT_ON_SCREEN")).toBe(1);
    // The source is normalised, so "Pixabay" and "pixabay" are one bucket.
    expect(tally.byKindAndSource.get("WRONG_PERIOD|pixabay")).toBe(1);
    // The FIRST example is kept, not the last — a later refusal must not overwrite the quote.
    expect(tally.examples.get("WRONG_PERIOD")?.reason).toBe("present-day footage");
  });

  it("23. splits the render's refusals into search-preventable and catalogue faults", () => {
    const tally = createMismatchTally();
    for (let i = 0; i < 12; i++) recordMismatch(tally, { kind: "WRONG_PERIOD", source: "pexels" });
    for (let i = 0; i < 5; i++) recordMismatch(tally, { kind: "TEXT_ON_SCREEN", source: "youtube" });
    for (let i = 0; i < 4; i++) recordMismatch(tally, { kind: "UNCLEAR", source: "loc" });

    expect(mismatchFaultSplit(tally)).toEqual({ question: 12, material: 5, unknown: 4 });
    // The split must account for every refusal — no bucket may be dropped.
    const split = mismatchFaultSplit(tally);
    expect(split.question + split.material + split.unknown).toBe(tally.total);
  });

  it("24. summarises kinds most frequent first", () => {
    const tally = createMismatchTally();
    recordMismatch(tally, { kind: "TEXT_ON_SCREEN", source: "youtube" });
    for (let i = 0; i < 3; i++) recordMismatch(tally, { kind: "WRONG_PERIOD", source: "pexels" });
    const rows = summarizeMismatchKinds(tally);
    expect(rows[0]).toEqual({ kind: "WRONG_PERIOD", count: 3, fault: "QUESTION" });
    expect(rows[1]).toEqual({ kind: "TEXT_ON_SCREEN", count: 1, fault: "MATERIAL" });
  });

  it("25. an empty tally produces no summary — silence is the good outcome", () => {
    expect(formatMismatchSummary(createMismatchTally())).toBe("");
    expect(mismatchFaultSplit(createMismatchTally())).toEqual({
      question: 0, material: 0, unknown: 0,
    });
  });
});

describe("RONDE 131 — the log surfaces", () => {
  it("26. the per-refusal line names the kind, the fault and whether anything moved", () => {
    const line = formatMismatchFeedback({
      sceneIndex: 2, beatIndex: 1, source: "pexels",
      kind: "WRONG_PERIOD", reordered: true, remaining: 4,
    });
    expect(line).toContain("s2b1");
    expect(line).toContain("kind=WRONG_PERIOD");
    expect(line).toContain("fault=QUESTION");
    expect(line).toContain("reordered=yes");
    expect(line).toContain("remaining=4");
  });

  it("27. the render summary reproduces video 546's shape as an actionable sentence", () => {
    const tally = createMismatchTally();
    for (let i = 0; i < 12; i++) {
      recordMismatch(tally, {
        kind: "WRONG_PERIOD", source: "pexels", reason: "present-day footage under 1945 narration",
      });
    }
    for (let i = 0; i < 5; i++) recordMismatch(tally, { kind: "TEXT_ON_SCREEN", source: "youtube" });
    for (let i = 0; i < 4; i++) recordMismatch(tally, { kind: "WRONG_SUBJECT", source: "wikimedia" });

    const out = formatMismatchSummary(tally);
    expect(out).toContain("21 refusal(s)");
    expect(out).toContain("search-preventable=16");
    expect(out).toContain("material=5");
    expect(out).toContain("WRONG_PERIOD");
    expect(out).toContain("present-day footage under 1945 narration");
  });
});

/**
 * Mutations. Each one removes a specific guard; the named test must fail when it is gone.
 * Verified by hand against a file copy, in the RONDE 122 manner — no `git checkout`.
 */
describe("RONDE 131 — mutation guards", () => {
  it("M1. a text kind must be checked before a period kind", () => {
    // If the pattern order were reversed, "a modern title card" would classify as a period error
    // and the pipeline would go looking in the archives for a problem the archives also have.
    const kind = classifyMismatch({ depicts: "a modern title card", reason: "text, not footage" });
    expect(kind).toBe("TITLE_CARD");
    expect(mismatchFault(kind)).toBe("MATERIAL");
  });

  it("M2. UNRELATED must come last, so a specific kind is never swallowed by it", () => {
    // The gate's own prompt puts "does not belong" in the model's mouth, so that phrase appears on
    // almost every refusal. If UNRELATED were checked first, every refusal would be UNRELATED and
    // the tally would carry no information at all.
    expect(
      classifyMismatch({
        depicts: "a modern street",
        reason: "unrelated — it does not belong, this is present-day footage",
      })
    ).toBe("MODERN_FOOTAGE");
  });

  it("M3. the reorder must not drop the avoided candidates", () => {
    const onlyStock = [cand("a", "pexels"), cand("b", "pixabay")];
    // A beat whose whole field is stock must come back with its whole field. A filter here would
    // return [] and starve the beat — which is the failure mode this round must not introduce.
    const out = reorderAfterMismatch(onlyStock, "WRONG_PERIOD");
    expect(out).toHaveLength(2);
    expect(out.map((c) => c.id).sort()).toEqual(["a", "b"]);
  });

  it("M4. the tally must count sources case-insensitively", () => {
    const tally = createMismatchTally();
    recordMismatch(tally, { kind: "WRONG_PERIOD", source: "Pexels" });
    recordMismatch(tally, { kind: "WRONG_PERIOD", source: "pexels " });
    expect(tally.byKindAndSource.get("WRONG_PERIOD|pexels")).toBe(2);
  });

  it("M5. an unnamed source is recorded as unknown, never as an empty bucket", () => {
    const tally = createMismatchTally();
    recordMismatch(tally, { kind: "UNCLEAR", source: "" });
    expect(tally.byKindAndSource.get("UNCLEAR|unknown")).toBe(1);
  });

  /**
   * M6 — the wiring itself.
   *
   * Everything above proves the module behaves. None of it proves the PIPELINE asks it anything,
   * and a module nobody calls is precisely the RONDE 26 failure this project keeps rediscovering:
   * healthy code, healthy tests, no effect on a render. So the funnel's refusal branch is read
   * directly and required to contain the three calls that make the round real.
   */
  it("M6. the funnel's does_not_fit branch classifies, records and reorders", () => {
    const src = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");
    const branch = src.indexOf('if (judgement.verdict !== "does_not_fit") break;');
    expect(branch).toBeGreaterThan(0);
    // The window is the refusal branch itself: from the break through to the re-pick that follows.
    const repick = src.indexOf("winner = pickBestFunnelCandidate(", branch);
    expect(repick).toBeGreaterThan(branch);
    const window = src.slice(branch, repick);

    expect(window).toContain("classifyMismatch(judgement)");
    expect(window).toContain("recordMismatch(dedup.mismatchTally");
    // RONDE 135 added the learned repeat-offender argument, so the call spans several lines.
    expect(window).toContain("reorderAfterMismatch(");
    expect(window).toContain("repeatOffenderSources(dedup.mismatchTally)");
    // The reorder must be assigned back — computing a permutation and discarding it is the exact
    // shape of RONDE 122's mutation M2, which passed every test while changing nothing.
    expect(window).toMatch(/scored = reorderAfterMismatch\(/);
  });

  it("M7. the render summary prints the mismatch split", () => {
    const src = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");
    expect(src).toContain("formatMismatchSummary(visualDedup.mismatchTally)");
    expect(src).toContain("mismatchFaultSplit(visualDedup.mismatchTally)");
  });
});
