import { describe, expect, it } from "vitest";
import { extractPersonNamesFromText } from "./videoPipeline";

/**
 * RONDE 72 — a capitalised run is not a person just because it is capitalised.
 *
 * extractPersonNamesFromText matched /[A-Z][a-z]+(\s+[A-Z][a-z]+)+/ and called every hit a
 * person, and required two tokens so a bare surname was never one. Measured on the real
 * function, before this round:
 *
 *     "The construction of the Eiffel Tower."       -> ["Eiffel Tower"]     a building
 *     "British Spitfire fighters scramble…"         -> ["British Spitfire"] an aircraft
 *     "Churchill addresses the nation after Dunkirk." -> []                 a person, missed
 *     "Hitler retreats into the bunker."            -> []                   a person, missed
 *
 * The list feeds the primaryPerson lock, resolveScenePersons and the query builders as literal
 * names, and since RONDE 71 a match is worth +12 in entityMatchTierScore. A building scoring as
 * the beat's protagonist is not a cosmetic problem.
 *
 * Every test runs the real function on real narration and asserts the real output.
 */

const p = (text: string) => extractPersonNamesFromText(text);

/* ───────────── false positives: things must never be people ───────────── */

describe("RONDE 72 — buildings, vehicles and units are not people", () => {
  it("Eiffel Tower is a building, never a person", () => {
    expect(p("The construction of the Eiffel Tower.")).toEqual([]);
    expect(p("Gustave Eiffel designed the Eiffel Tower.")).not.toContain("Eiffel Tower");
  });

  it("British Spitfire is an aircraft, never a person", () => {
    expect(p("British Spitfire fighters scramble from an airfield.")).toEqual([]);
    expect(p("A Spitfire climbed above the coast.")).toEqual([]);
  });

  it("Reichstag stays a building", () => {
    expect(p("Soviet soldiers reached the Reichstag.")).toEqual([]);
    expect(p("The Red Army raised its banner over the Reichstag.")).toEqual([]);
  });

  it("Reich Chancellery and Brandenburg Gate stay buildings", () => {
    expect(p("Above them the Reich Chancellery garden was a field of craters.")).toEqual([]);
    expect(p("The Brandenburg Gate stood in ruins.")).toEqual([]);
  });

  it("military formations stay formations", () => {
    expect(p("The Red Army encircled the city.")).toEqual([]);
    expect(p("The Sixth Army had already surrendered.")).toEqual([]);
    expect(p("The Tiger tank advanced through the forest.")).toEqual([]);
  });

  it("places stay places, even when the sentence has a verb", () => {
    expect(p("Berlin was under constant bombardment in April 1945.")).toEqual([]);
    expect(p("Dunkirk had fallen by the end of the week.")).toEqual([]);
    expect(p("New York woke to the news.")).toEqual([]);
  });

  it("a run whose every token names a place is a place, not a person", () => {
    // This is what the whole-run place rule exists for. "New York" and "Los Angeles" are caught
    // by the older skip-phrase list, so they cannot prove it; these are not.
    expect(p("The invasion of Soviet Russia began in June 1941.")).toEqual([]);
    expect(p("The convoy left Munich Germany at dawn.")).toEqual([]);
    expect(p("Fighting spread across Eastern Poland.")).toEqual([]);
  });
});

/* ───────────── false negatives: bare surnames, with evidence ───────────── */

describe("RONDE 72 — a bare surname is a person when the sentence says so", () => {
  it("Churchill is recognised", () => {
    expect(p("Churchill addresses the nation after Dunkirk.")).toContain("Churchill");
  });

  it("Hitler is recognised", () => {
    expect(p("Hitler retreats into the bunker.")).toContain("Hitler");
  });

  it("a possessive is evidence too", () => {
    expect(p("Hitler's final political testament was dictated at dawn.")).toContain("Hitler");
  });

  it("any surname works — the rule is not a list of famous names", () => {
    expect(p("Goebbels remained underground with his family.")).toContain("Goebbels");
    expect(p("Speer visited the bunker one last time.")).toContain("Speer");
    expect(p("Keitel signed the surrender.")).toContain("Keitel");
  });

  it("a bare capitalised word with NO person evidence is left alone", () => {
    // The pipeline must not claim to have identified something it has not.
    expect(p("Normandy in the summer of 1944.")).toEqual([]);
    expect(p("Stalingrad after the encirclement.")).toEqual([]);
    // A copula is not evidence: it is true of everything.
    expect(p("Dresden was a city of rubble.")).toEqual([]);
  });
});

/* ───────────── the cases that already worked must keep working ───────────── */

describe("RONDE 72 — nothing that worked was broken", () => {
  it("full names still resolve", () => {
    expect(p("Adolf Hitler dictated his testament.")).toContain("Adolf Hitler");
    expect(p("Eva Braun refused to leave.")).toContain("Eva Braun");
    expect(p("Kylie Jenner posted about the launch.")).toContain("Kylie Jenner");
    expect(p("Elon Musk announced the change.")).toContain("Elon Musk");
  });

  it("a surname that also names places still survives inside a full name", () => {
    // "washington" and "lincoln" are both in the place vocabulary. A run is only a place when
    // EVERY token is one, so the person survives and the place does not become a person.
    expect(p("George Washington crossed the Delaware.")).toContain("George Washington");
    expect(p("Abraham Lincoln gave the address.")).toContain("Abraham Lincoln");
    expect(p("Washington was cold that winter.")).toEqual([]);
  });

  it("the framing-word split from RONDE 518 still works", () => {
    expect(p("His Wife Eva Braun stayed with him.")).toContain("Eva Braun");
  });

  it("a bare surname is not duplicated beside the full name it belongs to", () => {
    const out = p("Adolf Hitler dictated his testament. Hitler then signed it.");
    expect(out).toContain("Adolf Hitler");
    expect(out).not.toContain("Hitler");
  });

  it("empty and junk input is still safe", () => {
    expect(p("")).toEqual([]);
    expect(p("   ")).toEqual([]);
    expect(() => p("... !!! ???")).not.toThrow();
  });
});

/* ───────────── the whole documentary case ───────────── */

describe("RONDE 72 — the Führerbunker beats, end to end", () => {
  const beats: Array<[string, string[]]> = [
    ["Berlin was under constant bombardment in the last week of April 1945.", []],
    ["Hitler retreats into the Fuhrerbunker in April 1945.", ["Hitler"]],
    ["Eva Braun came to the bunker against his wishes.", ["Eva Braun"]],
    ["German soldiers were defending the ruined capital.", []],
    ["Soviet forces were closing on the city from the east.", []],
    ["The Red Army raised its banner over the Reichstag.", []],
    ["Goebbels remained underground with his family.", ["Goebbels"]],
    ["The construction of the Eiffel Tower.", []],
    ["British Spitfire fighters scramble from an airfield.", []],
    ["Churchill addresses the nation after Dunkirk.", ["Churchill"]],
  ];

  for (const [beat, expected] of beats) {
    it(`"${beat.slice(0, 48)}…" -> ${expected.length ? expected.join(", ") : "no person"}`, () => {
      expect(p(beat)).toEqual(expected);
    });
  }

  it("no thing or place appears anywhere in the whole set", () => {
    const all = beats.flatMap(([b]) => p(b));
    for (const banned of ["Eiffel Tower", "British Spitfire", "Reichstag", "Red Army", "Berlin"]) {
      expect(all).not.toContain(banned);
    }
  });
});
