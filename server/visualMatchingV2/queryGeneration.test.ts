import { describe, expect, it, vi } from "vitest";
import {
  generateDeterministicQueries,
  generateLlmQueryExpansions,
  generateRankedSearchQueries,
  mergeDedupeAndRank,
} from "./queryGeneration";
import type { RankedQuery, VisualIntent } from "./types";

vi.mock("../_core/llm", () => ({ invokeLLM: vi.fn() }));
vi.mock("../db", () => ({
  createVisualQueryExpansionCache: vi.fn().mockResolvedValue(undefined),
  getVisualQueryExpansionCacheByIntentHash: vi.fn().mockResolvedValue(undefined),
}));

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

function mockLlmExpansion(queries: Array<{ query: string; category: string }>) {
  return async () => {
    const { invokeLLM } = await import("../_core/llm");
    vi.mocked(invokeLLM).mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ queries }) } }],
    } as never);
  };
}

describe("Deterministic query generation (step 2)", () => {
  it("generates the example queries from the spec (person + format noun) and never returns duplicates", () => {
    const queries = generateDeterministicQueries(makeIntent());
    const strings = queries.map((q) => q.query);

    expect(strings).toContain("Elon Musk keynote");
    expect(strings).toContain("Elon Musk interview");
    expect(strings).toContain("Elon Musk stage");
    expect(strings).toContain("Elon Musk conference");
    expect(strings).toContain("Elon Musk speaking");
    expect(strings).toContain("Elon Musk xAI");
    expect(new Set(strings.map((s) => s.toLowerCase())).size).toBe(strings.length);
  });

  it("prioritizes the shot plan's search query and alternatives when provided", () => {
    const queries = generateDeterministicQueries(makeIntent(), {
      beatIndex: 0,
      shotType: "close-up",
      action: "speaking",
      location: "stage",
      era: "present",
      visualStyle: "video",
      searchQuery: "Elon Musk close up speaking",
      alternatives: ["Elon Musk face closeup"],
      emotion: "confident",
    } as never);
    expect(queries[0]!.query).toBe("Elon Musk close up speaking");
    expect(queries[0]!.source).toBe("shot_plan");
  });
});

describe("LLM query expansion (step 3) — never replaces, only adds, never crashes", () => {
  it("returns LLM-generated aliases/related concepts/historical terms/context phrases, tagged by category", async () => {
    await mockLlmExpansion([
      { query: "Musk product reveal", category: "alias" },
      { query: "tech CEO on stage", category: "related_concept" },
      { query: "silicon valley keynote 2020s", category: "historical_term" },
      { query: "AI chatbot unveiling", category: "context_phrase" },
      { query: "audience reaction applause", category: "implicit_visual" },
    ])();

    const expansions = await generateLlmQueryExpansions(makeIntent());
    const sources = expansions.map((q) => q.source).sort();
    expect(sources).toEqual([
      "llm_alias",
      "llm_context_phrase",
      "llm_historical_term",
      "llm_implicit_visual",
      "llm_related_concept",
    ]);
  });

  it("infers implicit visual intent — B-roll/reaction/cutaway shots the sentence never names", async () => {
    // Mirrors the "Apple introduced the Vision Pro" example: not just entity restatements,
    // but footage a professional editor would naturally cut to.
    await mockLlmExpansion([
      { query: "audience reaction applause", category: "implicit_visual" },
      { query: "journalists photographing product", category: "implicit_visual" },
      { query: "person trying VR headset", category: "implicit_visual" },
      { query: "close-up product reveal", category: "implicit_visual" },
      { query: "stage lighting keynote", category: "implicit_visual" },
      { query: "Apple Park exterior", category: "implicit_visual" },
    ])();

    const expansions = await generateLlmQueryExpansions(
      makeIntent({
        spokenText: "Apple introduced the Vision Pro.",
        visualSubject: "Apple",
        visualDescription: "Apple unveiling the Vision Pro headset",
        brands: ["Vision Pro"],
        companies: ["Apple"],
      })
    );

    const implicitVisualQueries = expansions.filter((q) => q.source === "llm_implicit_visual").map((q) => q.query);
    expect(implicitVisualQueries).toEqual(
      expect.arrayContaining([
        "audience reaction applause",
        "journalists photographing product",
        "person trying VR headset",
        "close-up product reveal",
      ])
    );
    // Implicit-visual queries are still real, scored entries — not silently dropped by rank.
    expect(expansions.every((q) => q.score > 0)).toBe(true);
  });

  it("degrades to an empty list (not a crash) when the LLM call fails", async () => {
    const { invokeLLM } = await import("../_core/llm");
    vi.mocked(invokeLLM).mockRejectedValueOnce(new Error("no API key configured"));

    const expansions = await generateLlmQueryExpansions(makeIntent());
    expect(expansions).toEqual([]);
  });

  it("reuses a cached expansion instead of calling the LLM again for the same intentHash", async () => {
    const { invokeLLM } = await import("../_core/llm");
    const { getVisualQueryExpansionCacheByIntentHash } = await import("../db");
    vi.mocked(getVisualQueryExpansionCacheByIntentHash).mockResolvedValueOnce({
      queriesJson: [{ query: "cached alias query", category: "alias" }],
    } as never);
    vi.mocked(invokeLLM).mockClear();

    const expansions = await generateLlmQueryExpansions(makeIntent());
    expect(expansions.map((q) => q.query)).toContain("cached alias query");
    expect(invokeLLM).not.toHaveBeenCalled();
  });
});

describe("Merge / dedupe / rank (steps 4-6)", () => {
  it("merges two lists, removes duplicate query strings, and ranks by score", () => {
    const a: RankedQuery[] = [
      { query: "Elon Musk keynote", rank: 1, score: 0.9, source: "person_format" },
      { query: "shared query", rank: 2, score: 0.5, source: "primary_keyword" },
    ];
    const b: RankedQuery[] = [
      { query: "Shared Query", rank: 1, score: 0.7, source: "llm_alias" }, // dup of "shared query", different case
      { query: "silicon valley keynote 2020s", rank: 2, score: 0.8, source: "llm_historical_term" },
    ];

    const merged = mergeDedupeAndRank([a, b]);
    const strings = merged.map((q) => q.query);

    expect(strings.filter((s) => s.toLowerCase() === "shared query")).toHaveLength(1);
    expect(merged.map((q) => q.rank)).toEqual(merged.map((_, i) => i + 1));
    // Sorted by score descending.
    expect(merged[0]!.query).toBe("Elon Musk keynote");
    expect(merged[1]!.query).toBe("silicon valley keynote 2020s");
  });

  it("caps the merged, ranked result at 30 with contiguous 1-based ranks", () => {
    const many: RankedQuery[] = Array.from({ length: 40 }, (_, i) => ({
      query: `query ${i}`,
      rank: i + 1,
      score: Math.random(),
      source: "primary_keyword" as const,
    }));
    const merged = mergeDedupeAndRank([many]);
    expect(merged.length).toBe(30);
    expect(merged.map((q) => q.rank)).toEqual(merged.map((_, i) => i + 1));
  });
});

describe("generateRankedSearchQueries — full hybrid pipeline", () => {
  it("merges deterministic and LLM-expanded queries into one ranked, deduped list", async () => {
    await mockLlmExpansion([
      { query: "Musk product reveal", category: "alias" },
      { query: "Elon Musk keynote", category: "alias" }, // duplicate of a deterministic query
      { query: "audience reaction applause", category: "implicit_visual" },
    ])();

    const queries = await generateRankedSearchQueries(makeIntent());
    const strings = queries.map((q) => q.query);

    // Deterministic queries still present.
    expect(strings).toContain("Elon Musk keynote");
    expect(strings).toContain("Elon Musk xAI");
    // LLM-only additions present, including implicit visual intent (B-roll) the sentence
    // never literally names.
    expect(strings).toContain("Musk product reveal");
    expect(strings).toContain("audience reaction applause");
    // Cross-list duplicate collapsed to one entry.
    expect(strings.filter((s) => s.toLowerCase() === "elon musk keynote")).toHaveLength(1);
    // Still within the 10-30 target range for a rich intent.
    expect(queries.length).toBeGreaterThanOrEqual(10);
    expect(queries.length).toBeLessThanOrEqual(30);
    expect(queries.map((q) => q.rank)).toEqual(queries.map((_, i) => i + 1));
  });

  it("still produces a complete, valid query list when the LLM expansion fails entirely", async () => {
    const { invokeLLM } = await import("../_core/llm");
    vi.mocked(invokeLLM).mockRejectedValueOnce(new Error("LLM unavailable"));

    const queries = await generateRankedSearchQueries(makeIntent());
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.some((q) => q.query === "Elon Musk keynote")).toBe(true);
  });

  it("produces a smaller, still-valid list for a sparse intent (no named entities) even with no LLM expansions", async () => {
    await mockLlmExpansion([])();
    const sparse = makeIntent({
      secondaryVisualSubjects: [],
      objects: [],
      brands: [],
      companies: [],
      people: [],
      countries: [],
      events: [],
    });
    const queries = await generateRankedSearchQueries(sparse);
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.length).toBeLessThan(15);
    expect(queries.some((q) => q.query.includes("Elon Musk"))).toBe(true);
  });
});
