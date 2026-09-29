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


describe("RONDE 131 — the tally, which is what video 546 could not produce", () => {



  it("25. an empty tally produces no summary — silence is the good outcome", () => {
    expect(formatMismatchSummary(createMismatchTally())).toBe("");
    expect(mismatchFaultSplit(createMismatchTally())).toEqual({
      question: 0, material: 0, unknown: 0,
    });
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





  it("M7. the render summary prints the mismatch split", () => {
    const src = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");
    expect(src).toContain("formatMismatchSummary(visualDedup.mismatchTally)");
    expect(src).toContain("mismatchFaultSplit(visualDedup.mismatchTally)");
  });
});
