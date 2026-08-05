import { describe, expect, it } from "vitest";
import { generateRankedSearchQueries } from "./queryGeneration";
import type { VisualIntent } from "./types";

function makeIntent(overrides: Partial<VisualIntent> = {}): VisualIntent {
  return {
    beatId: "b0",
    spokenText: "Elon Musk announced Grok 5",
    visualSubject: "Elon Musk",
    visualAction: "speaking on stage",
    visualLocation: "conference hall",
    visualTime: "present day",
    historicalContext: "AI product launch",
    emotion: "confident",
    visualDescription: "Elon Musk speaking into a microphone on a conference stage",
    primaryKeyword: "Elon Musk keynote",
    secondaryKeyword: "Elon Musk stage",
    negativeKeywords: [],
    secondaryVisualSubjects: ["audience"],
    objects: ["microphone"],
    brands: ["Grok"],
    companies: ["xAI"],
    people: ["Elon Musk"],
    countries: ["United States"],
    events: ["Grok 5 announcement"],
    intentHash: "hash",
    cacheHit: false,
    ...overrides,
  };
}

describe("Ranked query generation (Phase 3)", () => {
  it("generates the example queries from the spec (person + format noun) and ranks them highest", () => {
    const queries = generateRankedSearchQueries(makeIntent());
    const strings = queries.map((q) => q.query);

    expect(strings).toContain("Elon Musk keynote");
    expect(strings).toContain("Elon Musk interview");
    expect(strings).toContain("Elon Musk stage");
    expect(strings).toContain("Elon Musk conference");
    expect(strings).toContain("Elon Musk speaking");
    expect(strings).toContain("Elon Musk xAI");

    // Person+format queries should rank ahead of the generic fallback keyword queries.
    const personQueryRank = queries.find((q) => q.query === "Elon Musk keynote")!.rank;
    const fallbackRank = queries.find((q) => q.source === "primary_keyword")!.rank;
    expect(personQueryRank).toBeLessThan(fallbackRank);
  });

  it("never returns duplicate queries even when entities overlap", () => {
    const queries = generateRankedSearchQueries(makeIntent({ primaryKeyword: "Elon Musk keynote" }));
    const strings = queries.map((q) => q.query.toLowerCase());
    expect(new Set(strings).size).toBe(strings.length);
  });

  it("caps output at 30 and assigns contiguous 1-based ranks", () => {
    const queries = generateRankedSearchQueries(makeIntent());
    expect(queries.length).toBeLessThanOrEqual(30);
    expect(queries.map((q) => q.rank)).toEqual(queries.map((_, i) => i + 1));
  });

  it("produces a smaller, still-valid list for a sparse intent (no named entities)", () => {
    const sparse = makeIntent({
      secondaryVisualSubjects: [],
      objects: [],
      brands: [],
      companies: [],
      people: [],
      countries: [],
      events: [],
    });
    const queries = generateRankedSearchQueries(sparse);
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.length).toBeLessThan(15);
    expect(queries.some((q) => q.query.includes("Elon Musk"))).toBe(true);
  });

  it("prioritizes the shot plan's search query and alternatives when provided", () => {
    const queries = generateRankedSearchQueries(makeIntent(), {
      beatIndex: 0,
      shotType: "close-up",
      action: "speaking",
      location: "stage",
      era: "present",
      visualStyle: "video",
      searchQuery: "Elon Musk close up speaking",
      alternatives: ["Elon Musk face closeup"],
      emotion: "confident",
    });
    expect(queries[0]!.query).toBe("Elon Musk close up speaking");
    expect(queries[0]!.source).toBe("shot_plan");
  });
});
