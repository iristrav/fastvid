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

/* ═══════════════ 1. QUERY SEMANTICS ═══════════════ */

describe("RONDE 71 §1 — the query carries the beat's entities, not its first words", () => {
  const cases: Array<{
    beat: string;
    mustContain: string[];
    mustNotContain: string[];
    why: string;
  }> = [
    {
      beat: "Eva Braun came to the bunker against his wishes and refused to leave.",
      mustContain: ["eva braun", "bunker"],
      mustNotContain: ["came", "wishes", "refused", "leave"],
      why: "was 'Eva Braun come' — the first non-stop word happened to be the verb",
    },
    {
      beat: "It was his final birthday, the twentieth of April 1945.",
      mustContain: ["birthday", "april"],
      mustNotContain: ["final", "twentieth"],
      why: "was 'final birthday twentieth' — two ordinals and no subject",
    },
    {
      beat: "Life inside London during the Blitz.",
      mustContain: ["london", "blitz"],
      mustNotContain: ["inside"],
      why: "was 'life inside london' — the Blitz itself never reached the provider",
    },
    {
      beat: "Churchill addresses the nation after Dunkirk.",
      mustContain: ["churchill", "dunkirk"],
      mustNotContain: ["addresses"],
      why: "was 'churchill addresses nation' — Dunkirk dropped for a verb",
    },
    {
      beat: "British Spitfire fighters scramble from an airfield.",
      mustContain: ["spitfire"],
      mustNotContain: ["scramble"],
      why: "the aircraft must survive; the verb must not",
    },
    {
      beat: "The construction of the Eiffel Tower.",
      mustContain: ["eiffel tower", "construction"],
      mustNotContain: [],
      why: "the named structure anchors the query",
    },
    {
      beat: "Berlin was under constant bombardment in the last week of April 1945.",
      mustContain: ["berlin", "bombardment"],
      mustNotContain: ["under", "constant", "week"],
      why: "was 'berlin under constant' — a preposition and an adjective",
    },
    {
      beat: "The Red Army raised its banner over the Reichstag on the thirtieth of April.",
      mustContain: ["reichstag"],
      mustNotContain: ["raised", "thirtieth"],
      why: "was 'army raised banner' — the most famous building of the war was missing",
    },
    {
      beat: "Hitler received military reports that described armies which no longer existed.",
      mustContain: ["hitler", "military"],
      mustNotContain: ["received", "described"],
      why: "was 'hitler received military' — a verb in the middle of the query",
    },
    {
      beat: "Above them the Reich Chancellery garden was a field of craters.",
      mustContain: ["reich", "chancellery"],
      mustNotContain: ["above", "them"],
      why: "was 'them reich chancellery' — a pronoun as a search term",
    },
    {
      beat: "The bunker itself lay eight and a half metres below the ground.",
      mustContain: ["bunker"],
      mustNotContain: ["itself", "eight", "metres", "half"],
      why: "was 'bunker itself eight' — a measurement is not an image",
    },
    {
      beat: "The German invasion of Poland in September 1939.",
      mustContain: ["poland", "september"],
      mustNotContain: [],
      why: "already worked; must keep working",
    },
  ];

  for (const c of cases) {
    it(`"${c.beat.slice(0, 52)}…" — ${c.why}`, () => {
      const all = queriesForBeat(c.beat, TITLE).join(" | ").toLowerCase();
      for (const need of c.mustContain) expect(all).toContain(need);
      for (const banned of c.mustNotContain) {
        expect(all, `"${banned}" must not reach a provider`).not.toContain(banned);
      }
    });
  }

  it("the query is not simply longer — it stays at most three terms plus a year", () => {
    for (const c of cases) {
      const primary = queriesForBeat(c.beat, TITLE)[0]!;
      expect(primary.split(/\s+/).length).toBeLessThanOrEqual(4);
    }
  });

  it("a beat carrying nothing concrete still produces a query rather than nothing", () => {
    // The abstract case: there is no photograph of an impact, but the beat must not go empty.
    const q = queriesForBeat("The psychological impact of the war on civilians.", TITLE);
    expect(q[0]!.length).toBeGreaterThan(0);
    expect(q[0]).not.toBe("documentary");
  });

  it("REGRESSION — reintroducing positional selection fails these tests", () => {
    // What the old implementation returned, verbatim from the audit. If any of these ever comes
    // back out of the real function, the assertions above are the ones that break — this test
    // states the old outputs so the intent is unmistakable to whoever reads the failure.
    const oldOutputs = [
      "berlin under constant",
      "eva braun come",
      "final birthday twentieth",
      "hitler received military",
      "them reich chancellery",
      "bunker itself eight",
      "army raised banner",
    ];
    const nowProduced = cases.map((c) => queriesForBeat(c.beat, TITLE)[0]!.toLowerCase());
    for (const old of oldOutputs) expect(nowProduced).not.toContain(old);
  });
});

/* ═══════════════ 2. YEAR CONTAMINATION ═══════════════ */

describe("RONDE 71 §2 — a beat that states no year does not inherit the title's", () => {
  it("the Blitz is not searched as 1945", () => {
    const q = queriesForBeat("Life inside London during the Blitz.", TITLE).join(" | ");
    expect(q).not.toContain("1945");
    expect(q.toLowerCase()).toContain("blitz");
  });

  it("Dunkirk is not searched as 1945", () => {
    const q = queriesForBeat("Churchill addresses the nation after Dunkirk.", TITLE).join(" | ");
    expect(q).not.toContain("1945");
  });

  it("the Eiffel Tower is not searched as 1945", () => {
    const q = queriesForBeat("The construction of the Eiffel Tower.", TITLE).join(" | ");
    expect(q).not.toContain("1945");
    expect(q).toContain("Eiffel Tower");
  });

  it("a beat that DOES state the year keeps it", () => {
    const q = queriesForBeat("Hitler dies in the Fuhrerbunker in April 1945.", TITLE).join(" | ");
    expect(q).toContain("1945");
  });

  it("a beat with its own, different year keeps its own", () => {
    const q = queriesForBeat("The German invasion of Poland in September 1939.", TITLE).join(" | ");
    expect(q).toContain("1939");
    expect(q).not.toContain("1945");
  });

  it("the anchor still fires for the person, so it was demoted and not disabled", () => {
    const anchored = anchorQueriesToHistoricalContext({
      primaryQuery: "bunker corridor",
      extraQueries: [],
      sceneText: "Adolf Hitler remained below ground with his staff.",
      videoTitle: TITLE,
      primaryPerson: "Adolf Hitler",
    });
    expect(anchored.anchored).toBe(true);
    expect(anchored.year).toBe("");
    expect([anchored.primaryQuery, ...anchored.extraQueries].join(" | ")).toContain("Adolf Hitler");
  });

  it("the RANKING target period comes from the beat too, or point 3 would amplify the wrong year", () => {
    const blitzPhoto1940 = { title: "London during the Blitz, 1940" };
    const bunkerPhoto1945 = { title: "Berlin bunker, 1945" };
    const beat = "Life inside London during the Blitz.";
    // Neither is rewarded or punished on a year this beat never claimed.
    expect(historicalDateAlignmentScore(blitzPhoto1940, beat, TITLE)).toBe(0);
    expect(historicalDateAlignmentScore(bunkerPhoto1945, beat, TITLE)).toBe(0);
    // And where the beat DOES state a period, the scorer still works exactly as before —
    // same ladder, untouched: 0 years apart +2, within 2 years +1, within 10 years 0, beyond -3.
    const dated = "Hitler in the bunker in April 1945.";
    expect(historicalDateAlignmentScore(bunkerPhoto1945, dated, TITLE)).toBe(2);
    expect(historicalDateAlignmentScore(blitzPhoto1940, dated, TITLE)).toBe(0);
    expect(historicalDateAlignmentScore({ title: "Berlin, 1946" }, dated, TITLE)).toBe(1);
    expect(historicalDateAlignmentScore({ title: "Paris exposition, 1889" }, dated, TITLE)).toBe(-3);
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
