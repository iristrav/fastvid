import { describe, expect, it } from "vitest";
import {
  scriptStockSearchQueries,
  extractPersonNamesFromText,
  historicalDateAlignmentScore,
  compareBeatCandidates,
  MOTION_TIE_BREAK_MARGIN,
} from "./videoPipeline";
import { anchorQueriesToHistoricalContext } from "./mediaResearchEngine";

/**
 * RONDE 71 — the three defects the forensic audit proved by running the real code.
 *
 *   1. the query was chosen by word POSITION, so a sentence that opened with a verb lost its
 *      entities: "Berlin was under constant bombardment…" -> "berlin under constant"
 *   2. a beat that stated no year inherited the one in the VIDEO TITLE, so with a title of
 *      "… April 1945" the Blitz was searched as 1945 and the Eiffel Tower as 1945
 *   3. `if (stillA !== stillB) return stillA - stillB` decided the sort before a single score
 *      was compared, so any moving clip beat any photograph
 *
 * Every test below runs the real function on real input and asserts the real output. None of
 * them inspect source code: the previous rounds showed a source assertion cannot tell a working
 * invariant from a broken one.
 */

/** The whole query path a beat actually travels: subject extraction, then historical anchoring. */
function queriesForBeat(beat: string, videoTitle: string): string[] {
  const persons = extractPersonNamesFromText(beat);
  const base = scriptStockSearchQueries(beat, persons, beat, videoTitle);
  const anchored = anchorQueriesToHistoricalContext({
    primaryQuery: base[0] ?? "",
    extraQueries: base.slice(1),
    sceneText: beat,
    videoTitle,
    primaryPerson: persons[0] ?? "",
  });
  return [anchored.primaryQuery, ...anchored.extraQueries];
}

const TITLE = "The final days of Hitler in the Fuhrerbunker — April 1945";

/* ═══════════════ 2. YEAR CONTAMINATION ═══════════════ */

describe("RONDE 71 §2 — a beat that states no year does not inherit the title's", () => {

  it("the RANKING target period comes from the beat too, or point 3 would amplify the wrong year", () => {
    const blitzPhoto1940 = { title: "London during the Blitz, 1940" };
    const bunkerPhoto1945 = { title: "Berlin bunker, 1945" };
    const beat = "Life inside London during the Blitz.";
    // Neither is rewarded or punished on a year this beat never claimed.
    expect(historicalDateAlignmentScore(blitzPhoto1940, beat, TITLE)).toBe(0);
    expect(historicalDateAlignmentScore(bunkerPhoto1945, beat, TITLE)).toBe(0);
    // And where the beat DOES state a period, the scorer still works the same way — the rungs
    // are unchanged in meaning and order. RONDE 79 widened the gaps between them (exact +6,
    // within 2 years +3, within 10 years 0, beyond -6, and +8 when the MONTH matches too) so
    // that a six-year error can no longer be bought off by a person's name being present.
    const dated = "Hitler in the bunker in April 1945.";
    expect(historicalDateAlignmentScore(bunkerPhoto1945, dated, TITLE)).toBe(6);
    expect(historicalDateAlignmentScore({ title: "Berlin bunker, April 1945" }, dated, TITLE)).toBe(8);
    expect(historicalDateAlignmentScore(blitzPhoto1940, dated, TITLE)).toBe(0);
    expect(historicalDateAlignmentScore({ title: "Berlin, 1946" }, dated, TITLE)).toBe(3);
    expect(historicalDateAlignmentScore({ title: "Paris exposition, 1889" }, dated, TITLE)).toBe(-6);
    // The ordering the ladder exists for is what actually matters, and it is intact.
    expect(historicalDateAlignmentScore(bunkerPhoto1945, dated, TITLE))
      .toBeGreaterThan(historicalDateAlignmentScore({ title: "Berlin, 1946" }, dated, TITLE));
  });
});

/* ═══════════════ 3. RANKING: PHOTO vs VIDEO ═══════════════ */

describe("RONDE 71 §3 — relevance decides, motion breaks the tie", () => {
  /** Sorts a candidate list the way adoptClip now does. Lower index = preferred. */
  function rank(list: Array<{ id: string; score: number; still: boolean }>) {
    return [...list]
      .sort((a, b) => compareBeatCandidates(a.score, a.still, b.score, b.still))
      .map((c) => c.id);
  }

  it("A — a perfectly relevant historical photo beats a mediocre modern video", () => {
    const order = rank([
      { id: "modern-stock-video", score: 4, still: false },
      { id: "bundesarchiv-photo", score: 16, still: true },
    ]);
    expect(order[0]).toBe("bundesarchiv-photo");
  });

  it("B — an equally relevant historical video still beats the photo", () => {
    const order = rank([
      { id: "archive-photo", score: 12, still: true },
      { id: "archive-newsreel", score: 12, still: false },
    ]);
    expect(order[0]).toBe("archive-newsreel");
  });

  it("C — a historically correct photo beats a historically wrong video", () => {
    // The real gap this produces: +2 for the right year against -3 for the wrong one.
    const order = rank([
      { id: "wrong-year-video", score: 7, still: false },
      { id: "right-year-photo", score: 12, still: true },
    ]);
    expect(order[0]).toBe("right-year-photo");
  });

  it("D — two near-equal candidates keep the existing motion preference", () => {
    for (let delta = 0; delta <= MOTION_TIE_BREAK_MARGIN; delta++) {
      const order = rank([
        { id: "photo", score: 10 + delta, still: true },
        { id: "video", score: 10, still: false },
      ]);
      expect(order[0], `photo led by ${delta}, still within the margin`).toBe("video");
    }
  });

  it("one point past the margin, content wins", () => {
    const order = rank([
      { id: "photo", score: 10 + MOTION_TIE_BREAK_MARGIN + 1, still: true },
      { id: "video", score: 10, still: false },
    ]);
    expect(order[0]).toBe("photo");
  });

  it("a clearly better video still beats a photo — motion was demoted, not inverted", () => {
    const order = rank([
      { id: "photo", score: 3, still: true },
      { id: "relevant-video", score: 15, still: false },
    ]);
    expect(order[0]).toBe("relevant-video");
  });

  it("REGRESSION — the old rule ranked media type before content; it no longer can", () => {
    // Under `if (stillA !== stillB) return stillA - stillB` the video won at ANY score gap.
    // This is that exact scenario at a gap the old rule ignored entirely.
    const order = rank([
      { id: "irrelevant-video", score: 0, still: false },
      { id: "perfect-photo", score: 24, still: true },
    ]);
    expect(order[0]).toBe("perfect-photo");
  });

  it("the comparator is a valid sort function — antisymmetric and transitive on ties", () => {
    const ab = compareBeatCandidates(10, true, 10, false);
    const ba = compareBeatCandidates(10, false, 10, true);
    expect(ab).toBe(-ba);
    expect(ab).toBeGreaterThan(0); // still A sorts after moving B
    // Identical candidates compare equal, so sort order is stable for them.
    expect(compareBeatCandidates(7, true, 7, true)).toBe(0);
    expect(compareBeatCandidates(7, false, 7, false)).toBe(0);
  });

  it("the margin is measured in the same points the sort already used", () => {
    // Small enough that a period mismatch (right +2 vs wrong -3 = 5 points) decides,
    // large enough that ordinary noise does not.
    expect(MOTION_TIE_BREAK_MARGIN).toBeGreaterThan(0);
    expect(MOTION_TIE_BREAK_MARGIN).toBeLessThan(5);
  });
});
