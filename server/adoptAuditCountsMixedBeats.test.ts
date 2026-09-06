/**
 * RENDER 569 — WHY TWO AUDITS OF ONE RENDER SAID OPPOSITE THINGS.
 *
 * ── The contradiction, from the worker log of 2026-09-05 ────────────────────────────────────
 *
 *     [VisualCoverageFinal] scene=1 beat=1 status=adopted coverage=REAL_PLUS_FILLER
 *                           fillTier=color_fallback origin=archive
 *                           selected=scene_1_b1_curated_a57649.mp4
 *     …ten beats like it: archive x6, wikimedia x2, serpapi x2…
 *
 *     [Quality] Video 569: adopt audit beats=14 wiki=0 arch=0 stock=0 kling=0
 *     Error: Render rejected — insufficient real visual coverage:
 *            14/14 filled beat(s) used the color/text fallback
 *
 * One ledger named ten adopted files. The other reported none, and the export gate — which reads
 * the second — threw the film away.
 *
 * ── The cause, established from the code rather than guessed ────────────────────────────────
 *
 * A beat is not one slot. `pushClip` appends (videoPipeline: `clips.push(clipPath)`), so a colour
 * card lands NEXT TO whatever the beat already holds. That is established, not new: render 562
 * produced the same shape and `resolveBeatCoverage` has carried REAL_PLUS_FILLER ever since,
 * precisely because "adopted" and "a card was drawn" are both true on such a beat.
 *
 * All three per-beat guaranteed-fill sites record a SECOND adopt entry — `fallback` or
 * `rescue_placeholder` — under the beat's REAL index, after the real one. `summarizeAdoptAudit`
 * kept the last entry per beat, so the archive clip was discarded and the card was counted.
 *
 * That "later wins" rule was written for a different defect (a beat re-adopted by successive
 * recovery layers, which once reported an impossible "35/14"), and for real-to-real transitions it
 * remains right. It was never true for real-to-filler, because that is not a re-adoption.
 *
 * ── What these tests hold ───────────────────────────────────────────────────────────────────
 *
 * That a beat counts as a fallback beat only when a card is ALL it got; that a mixed beat is
 * counted under its real source and still REPORTED as mixed; and that the double-count fix the old
 * rule existed for is not undone.
 */
import { describe, expect, it } from "vitest";

import { summarizeAdoptAudit, type ClipAdoptEntry } from "./clipAdoptAudit";

const entry = (sceneIndex: number, beatIndex: number, source: string): ClipAdoptEntry => ({
  sceneIndex,
  beatIndex,
  beatText: `s${sceneIndex}b${beatIndex}`,
  basename: `${source}_s${sceneIndex}b${beatIndex}.mp4`,
  source,
});

describe("a beat that got real footage AND a card", () => {
  /** The exact shape of render 569's s1b1: archive adopted, then the card appended. */
  it("is counted under its real source, not as a fallback", () => {
    const s = summarizeAdoptAudit([entry(1, 1, "archive"), entry(1, 1, "fallback")]);
    expect(s.beatsFilled).toBe(1);
    expect(s.archiveBeats, "render 569 reported arch=0 for exactly this beat").toBe(1);
    expect(s.fallbackBeats).toBe(0);
  });

  /** But the card is not swept under the rug — that would be the opposite dishonesty. */
  it("is still reported as mixed", () => {
    const s = summarizeAdoptAudit([entry(1, 1, "archive"), entry(1, 1, "fallback")]);
    expect(s.mixedBeats).toBe(1);
    expect(s.hints.join(" ")).toContain("echt beeld én een kleurkaart");
  });

  it.each(["fallback", "rescue_placeholder"])(
    "recognises %j as the filler, whichever site recorded it",
    (filler) => {
      const s = summarizeAdoptAudit([entry(0, 2, "wikimedia"), entry(0, 2, filler)]);
      expect(s.wikiBeats).toBe(1);
      expect(s.fallbackBeats).toBe(0);
      expect(s.mixedBeats).toBe(1);
    }
  );
});

describe("a beat that got nothing but a card", () => {
  it("is still a fallback beat, and is not called mixed", () => {
    const s = summarizeAdoptAudit([entry(2, 3, "fallback")]);
    expect(s.fallbackBeats).toBe(1);
    expect(s.mixedBeats).toBe(0);
    expect(s.archiveBeats).toBe(0);
  });

  /** Two cards on one empty beat is one failed beat, not two — the original rule's whole point. */
  it("counts once even when several layers each drew one", () => {
    const s = summarizeAdoptAudit([
      entry(2, 3, "fallback"),
      entry(2, 3, "rescue_placeholder"),
      entry(2, 3, "fallback"),
    ]);
    expect(s.beatsFilled).toBe(1);
    expect(s.fallbackBeats).toBe(1);
  });
});

describe("the rule the old code was right about is kept", () => {
  /** Real replaced by real is a genuine re-adoption: the newer source is the beat's source. */
  it("a later real source still wins over an earlier one", () => {
    const s = summarizeAdoptAudit([entry(0, 0, "pexels"), entry(0, 0, "archive")]);
    expect(s.archiveBeats).toBe(1);
    expect(s.stockBeats).toBe(0);
    expect(s.mixedBeats, "nothing was mixed — no card was ever drawn here").toBe(0);
  });

  /** …including when the card sits BETWEEN them, which ordering alone cannot express. */
  it("a real source after a card is the one that counts", () => {
    const s = summarizeAdoptAudit([
      entry(0, 0, "pexels"),
      entry(0, 0, "fallback"),
      entry(0, 0, "archive"),
    ]);
    expect(s.archiveBeats).toBe(1);
    expect(s.fallbackBeats).toBe(0);
    expect(s.mixedBeats).toBe(1);
  });

  /** Sentinel indices are scene padding, not narrative beats — unchanged. */
  it.each([999, 1001, 2000, 2007, 8888, 9999])(
    "beatIndex %i is still excluded from beatsFilled",
    (beatIndex) => {
      const s = summarizeAdoptAudit([entry(0, 0, "archive"), entry(0, beatIndex, "fallback")]);
      expect(s.beatsFilled).toBe(1);
      expect(s.fallbackBeats).toBe(0);
    }
  );

  /** `bySource` counts ENTRIES, not beats, and must keep doing so — the geo checks read it. */
  it("bySource still counts every entry", () => {
    const s = summarizeAdoptAudit([entry(1, 1, "archive"), entry(1, 1, "fallback")]);
    expect(s.bySource).toEqual({ archive: 1, fallback: 1 });
  });
});

describe("render 569 replayed through the corrected summariser", () => {
  /**
   * The render's fourteen narrative beats as its own ledger described them: ten adopted real
   * footage and each of those also carried a card; four got a card and nothing else.
   */
  const RENDER_569 = [
    ...(["archive", "archive", "archive", "archive", "archive", "archive"] as const).map((s, i) =>
      [entry(0, i, s), entry(0, i, "fallback")]
    ),
    ...(["wikimedia", "wikimedia"] as const).map((s, i) => [entry(1, i, s), entry(1, i, "fallback")]),
    ...(["serpapi", "serpapi"] as const).map((s, i) => [entry(2, i, s), entry(2, i, "fallback")]),
    ...[0, 1, 2, 3].map((i) => [entry(3, i, "fallback")]),
  ].flat();

  it("no longer describes a film with ten real beats as fourteen colour cards", () => {
    const s = summarizeAdoptAudit(RENDER_569);
    expect(s.beatsFilled).toBe(14);
    expect(s.archiveBeats).toBe(6);
    expect(s.wikiBeats).toBe(2);
    expect(s.mixedBeats).toBe(10);
    expect(s.fallbackBeats, "the four beats that really got nothing else").toBe(4);
  });

  /**
   * AND THE GATE'S OWN ARITHMETIC, which is the part that mattered.
   *
   * `assertVisualCoverageExportGate` refuses when a strict majority of filled beats are fallback
   * beats. 14/14 was a majority; 4/14 is not. This is the line between a film being refused and
   * being exported, so it is asserted here rather than inferred.
   */
  it("4 of 14 is no longer a majority, so this gate no longer refuses", () => {
    const s = summarizeAdoptAudit(RENDER_569);
    expect(s.fallbackBeats / s.beatsFilled).toBeLessThanOrEqual(0.5);
  });

  /**
   * WHAT IS DELIBERATELY NOT OPENED.
   *
   * A render where the cards really are the film still fails the same test, on the same numbers.
   * The fix distinguishes two situations that were being scored identically; it does not lower a
   * threshold, and no beat that got only a card has moved out of the count.
   */
  it("a film that really is all colour cards is still a majority", () => {
    const allCards = [0, 1, 2, 3, 4, 5].map((i) => entry(0, i, "fallback"));
    const s = summarizeAdoptAudit(allCards);
    expect(s.fallbackBeats).toBe(6);
    expect(s.fallbackBeats / s.beatsFilled).toBeGreaterThan(0.5);
  });
});
