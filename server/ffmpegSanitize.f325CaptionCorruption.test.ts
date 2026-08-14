import { describe, expect, it } from "vitest";
import { isCaptionTextCorrupt } from "./ffmpegSanitize";

// F3-25: a production render burned in a corrupted on-screen caption —
// "THE GUNINSHOT ECHOESVSTEEL AND FLAMES LICK" — words glued together with no separating space
// and an internally corrupted token ("GUNINSHOT" instead of "GUNSHOT"). Every live caption/label
// extractor derives its text via regex match or word-split directly from the beat's own real
// narration string, so correctly functioning code always produces text that appears verbatim
// (whitespace/case-normalized) in that narration. isCaptionTextCorrupt is the hard quality gate
// that catches the case where it doesn't — the strongest available signal, using nothing beyond
// string comparison, that something upstream glued/interleaved fragments that don't belong
// together, per the requirement that a caption must be derivable from (not merely thematically
// related to) the actual script text.
describe("isCaptionTextCorrupt (F3-25 hard caption quality gate)", () => {
  const sourceText =
    "The gunshot echoes through the bunker as steel and flames lick the shattered walls of Berlin.";

  it("Test 16 — a normal caption pulled verbatim from the source text is never flagged as corrupt", () => {
    expect(isCaptionTextCorrupt("GUNSHOT ECHOES", sourceText)).toBe(false);
    expect(isCaptionTextCorrupt("STEEL AND FLAMES", sourceText)).toBe(false);
    expect(isCaptionTextCorrupt("shattered walls", sourceText)).toBe(false);
  });

  it("Test 15 — the exact reported production defect (glued words, corrupted token) is flagged as corrupt", () => {
    expect(isCaptionTextCorrupt("THE GUNINSHOT ECHOESVSTEEL AND FLAMES LICK", sourceText)).toBe(true);
  });

  it("Test 12 — a token join (two real words glued with no space) is flagged as corrupt even though each half is a real word", () => {
    // "gunshotecho" doesn't appear verbatim in the source (the source has "gunshot echoes" with
    // a space) — this is exactly the "words that get glued together" failure mode.
    expect(isCaptionTextCorrupt("GUNSHOTECHOES", sourceText)).toBe(true);
  });

  it("Test 11 — a multi-word caption with correct spacing between real, contiguous words passes", () => {
    expect(isCaptionTextCorrupt("STEEL AND FLAMES LICK", sourceText)).toBe(false);
    // Same words, no space between two of them — must now fail, proving spacing is checked.
    expect(isCaptionTextCorrupt("STEELAND FLAMES LICK", sourceText)).toBe(true);
  });

  it("caption text that mixes fragments from unrelated, non-adjacent parts of the source is flagged as corrupt", () => {
    // "gunshot" (near the start) directly followed by "berlin" (at the very end) never appears
    // as one contiguous phrase in the source — exactly the "two different fragments stitched
    // together" failure mode this gate exists to catch.
    expect(isCaptionTextCorrupt("GUNSHOT BERLIN", sourceText)).toBe(true);
  });

  it("is punctuation/case-insensitive so normal caption formatting (uppercase, stripped punctuation) isn't false-flagged", () => {
    const withPunctSource = "Hitler's final days: the bunker, the map, and the silence.";
    expect(isCaptionTextCorrupt("HITLER'S FINAL DAYS", withPunctSource)).toBe(false);
    expect(isCaptionTextCorrupt("THE BUNKER THE MAP", withPunctSource)).toBe(false);
  });

  it("empty caption text or empty source text never false-positives (nothing to validate)", () => {
    expect(isCaptionTextCorrupt("", sourceText)).toBe(false);
    expect(isCaptionTextCorrupt("   ", sourceText)).toBe(false);
    expect(isCaptionTextCorrupt("GUNSHOT", "")).toBe(false);
  });
});
