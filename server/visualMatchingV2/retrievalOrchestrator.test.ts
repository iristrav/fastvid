import { describe, expect, it, vi } from "vitest";
import { retrieveCandidatePool } from "./retrievalOrchestrator";
import type { CandidateSource, EmbeddingSearchProvider, RetrievalStrategy, VisualIntent } from "./types";

vi.mock("./candidateFetcher", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./candidateFetcher")>();
  return { ...actual };
});
// retrieveCandidatePool now computes this beat's ranked queries once up front (hybrid
// pipeline, queryGeneration.ts) regardless of strategy — mocked here so these tests never
// depend on API keys/DB being absent in the sandbox to stay fast and side-effect-free.
vi.mock("../_core/llm", () => ({ invokeLLM: vi.fn().mockRejectedValue(new Error("no LLM in tests")) }));
vi.mock("../db", () => ({
  createVisualQueryExpansionCache: vi.fn().mockResolvedValue(undefined),
  getVisualQueryExpansionCacheByIntentHash: vi.fn().mockResolvedValue(undefined),
}));

const intent: VisualIntent = {
  beatId: "b0",
  spokenText: "Elon Musk announced Grok 5",
  visualSubject: "Elon Musk",
  visualAction: "speaking",
  visualLocation: "stage",
  visualTime: "present",
  historicalContext: "",
  emotion: "confident",
  visualDescription: "Elon Musk on stage",
  primaryKeyword: "Elon Musk keynote",
  secondaryKeyword: "Elon Musk stage",
  negativeKeywords: [],
  secondaryVisualSubjects: [],
  objects: [],
  brands: [],
  companies: [],
  people: ["Elon Musk"],
  countries: [],
  events: [],
  intentHash: "hash",
  cacheHit: false,
};

function strategyWithEmbedding(): RetrievalStrategy {
  return {
    mode: "balanced",
    sources: [
      { source: "own_archive" as CandidateSource, priority: 1, maxCandidates: 5, timeoutMs: 5000, phase: "own_archive_embedding" },
    ],
    maxCandidates: 5,
    enableEmbedding: true,
    enableKeywordSearch: false,
    enableMetadataSearch: false,
    allowEarlyExit: false,
    allowFallback: true,
    retriesPerSource: 0,
    externalTimeoutMs: 5000,
    archiveTimeoutMs: 5000,
  };
}

describe("Retrieval Orchestrator — Phase 3 semantic-search-as-fallback wiring", () => {
  it("returns semantic hits from the embedding search provider", async () => {
    const embeddingSearch: EmbeddingSearchProvider = {
      search: vi.fn().mockResolvedValue({
        hits: [{ id: "42", similarity: 0.87, metadata: { title: "Elon Musk on stage", localPath: "/tmp/asset42.mp4" } }],
        cacheHit: false,
      }),
    };

    const pool = await retrieveCandidatePool(intent, {
      strategy: strategyWithEmbedding(),
      embeddingSearch,
      workDir: "/tmp",
      sceneIndex: 0,
    });

    expect(pool.candidates).toHaveLength(1);
    expect(pool.candidates[0]!.embeddingSimilarity).toBe(0.87);
    expect(pool.candidates[0]!.retrievalReasons).toContain("semantic");
  });

  it("degrades to an empty (not crashed) pool when the embedding provider throws — e.g. a missing API key", async () => {
    const embeddingSearch: EmbeddingSearchProvider = {
      search: vi.fn().mockRejectedValue(new Error("VoyageEmbeddingProvider: VOYAGE_API_KEY is not set")),
    };
    // Distinct beatId/query so this doesn't hit the previous test's cached search-cache entry.
    const throwingIntent: VisualIntent = { ...intent, beatId: "b1", primaryKeyword: "distinct query b1" };

    // Must not throw — this is the exact bug fixed in resolvePlanAdapter's synthetic
    // embedding adapter, which previously had no try/catch unlike every other adapter.
    const pool = await retrieveCandidatePool(throwingIntent, {
      strategy: strategyWithEmbedding(),
      embeddingSearch,
      workDir: "/tmp",
      sceneIndex: 0,
    });

    expect(pool.candidates).toEqual([]);
  });

  it("returns an empty pool (not a crash) when no embedding provider is supplied at all", async () => {
    const noProviderIntent: VisualIntent = { ...intent, beatId: "b2", primaryKeyword: "distinct query b2" };
    const pool = await retrieveCandidatePool(noProviderIntent, {
      strategy: strategyWithEmbedding(),
      workDir: "/tmp",
      sceneIndex: 0,
    });
    expect(pool.candidates).toEqual([]);
  });
});
