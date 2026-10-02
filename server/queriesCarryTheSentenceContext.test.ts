/**
 * OCTOBER 2026 — a search asks for the person IN the sentence's context, not the person alone.
 * See `extractContextPhrases` in searchQueryContract.ts.
 */
import { describe, expect, it } from "vitest";

import { buildPrioritisedQueries, extractContextPhrases, validateSearchQuery } from "./searchQueryContract";
import { buildVerifiedQueryContextForBeat } from "./videoPipeline";

const queries = (line: string) =>
  buildPrioritisedQueries(buildVerifiedQueryContextForBeat(line, { sceneText: line })).map((q) => q.query);

describe("what the sentence says about its subject", () => {
  it("reads the noun phrase behind a determiner, cut to its last two words", () => {
    expect(extractContextPhrases("Kris Jenner transformed her family into a global media empire.", ["Kris Jenner"])).toEqual(["media empire"]);
    expect(extractContextPhrases("Kim Kardashian signed a deal with E! to launch the reality show in 2007.", ["Kim Kardashian"])).toEqual(["reality show"]);
    expect(extractContextPhrases("Hitler dictated his final political testament in the bunker.", ["Hitler"])).toEqual(["political testament"]);
  });
  it("reads a company or product the sentence capitalises", () => {
    expect(extractContextPhrases("Elon Musk bought Twitter for 44 billion dollars.", ["Elon Musk"])).toEqual(["Twitter"]);
  });
  it("never a verb, the sentence's own subject, a month or a typed name", () => {
    expect(extractContextPhrases("Thousands of people crossed the border that night.")).toEqual([]);
    expect(extractContextPhrases("The city rebuilt its bridges after the war.")).toEqual([]);
    expect(extractContextPhrases("In 1987 Ronald Reagan stood at the Brandenburg Gate.", ["Ronald Reagan", "Brandenburg Gate"])).toEqual([]);
    expect(extractContextPhrases("The treaty was signed in March.", [])).toEqual([]);
  });
});

describe("the queries carry it, and the gate admits them", () => {
  it("Kris Jenner: the media empire first, the bare name right behind", () => {
    const q = queries("Kris Jenner transformed her family into a global media empire.");
    expect(q[0]).toBe("Kris Jenner media empire");
    expect(q[1]).toBe("Kris Jenner");
  });
  it("Elon Musk: Twitter", () => {
    expect(queries("Elon Musk bought Twitter for 44 billion dollars.")[0]).toBe("Elon Musk Twitter");
  });
  it("a person with a place keeps the place first", () => {
    const q = queries("Ronald Reagan spoke at the Brandenburg Gate about the cold war.");
    expect(q[0]).toBe("Ronald Reagan Brandenburg Gate");
    expect(q).toContain("Ronald Reagan cold war");
  });
  it("every new query passes the existing provider gate", () => {
    for (const line of [
      "Kris Jenner transformed her family into a global media empire.",
      "Elon Musk bought Twitter for 44 billion dollars.",
      "Kim Kardashian signed a deal with E! to launch the reality show in 2007.",
    ]) {
      const ctx = buildVerifiedQueryContextForBeat(line, { sceneText: line });
      for (const q of buildPrioritisedQueries(ctx)) expect(validateSearchQuery(q.query, ctx).ok, q.query).toBe(true);
    }
  });
  it("a sentence with nothing to add gets the queries it always had", () => {
    expect(queries("Napoleon Bonaparte crossed the mountains in 1800.")[0]).toBe("Napoleon Bonaparte");
  });
});
