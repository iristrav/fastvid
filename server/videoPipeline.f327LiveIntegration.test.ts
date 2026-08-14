import { describe, expect, it, vi, beforeEach } from "vitest";

// F3-27: activates the already-built F3-26 self-learning archive infrastructure in the LIVE
// pipeline by (a) flipping sceneCandidatePoolEnabled/retrievalFunnelEnabled/
// archiveFirstBeatsEnabled/externalAssetIngestionEnabled to default-on (server/sourcingPolicy.ts)
// and (b) wiring two new small, pure/mockable helpers into the funnel call sites in
// videoPipeline.ts: primeQueriesWithSearchMemory (Test E — self-learning query priming) and
// reportFunnelCoverageIfInsufficient (Test F — genuine-shortage user/admin warning). The
// funnel/ingestion call site itself (Test C/D) is unchanged F3-26 code, already covered by
// server/archiveIngestion.test.ts; Test A/B (archive sufficient vs insufficient) is the existing,
// untouched resolveStrategy()/archiveFirstBeatsEnabled() coverage logic in retrievalFunnel.ts —
// not new code, so not retested here (see the F3-27 final report for the full reasoning). Test G
// (cancellation) relies on the existing, unmodified cancellation suite — no new network/download
// code was added.
const getVisualSearchMemoryForEntityMock = vi.fn();
const applyCoverageWarningIfNeededMock = vi.fn();

vi.mock("./visualSearchMemory", () => ({
  getVisualSearchMemoryForEntity: (...args: unknown[]) => getVisualSearchMemoryForEntityMock(...args),
}));
vi.mock("./archiveCoverageWarning", () => ({
  applyCoverageWarningIfNeeded: (...args: unknown[]) => applyCoverageWarningIfNeededMock(...args),
}));

import { primeQueriesWithSearchMemory, reportFunnelCoverageIfInsufficient } from "./videoPipeline";
import type { RetrievalFunnelResult, FunnelCandidate } from "./retrievalFunnel";

function candidate(source: FunnelCandidate["source"]): FunnelCandidate {
  return { source } as FunnelCandidate;
}

describe("primeQueriesWithSearchMemory — F3-27 Test E (self-learning query priming)", () => {
  beforeEach(() => {
    getVisualSearchMemoryForEntityMock.mockReset();
    applyCoverageWarningIfNeededMock.mockReset();
  });

  it("prepends proven past queries (highest usageCount first) ahead of the normal query set", async () => {
    getVisualSearchMemoryForEntityMock.mockResolvedValue([
      { query: "Kylie Jenner red carpet", usageCount: 2, success: 1 },
      { query: "Kylie Jenner interview 2019", usageCount: 5, success: 1 },
    ]);
    const result = await primeQueriesWithSearchMemory("Kylie Jenner", ["kylie jenner makeup"]);
    expect(result).toEqual([
      "Kylie Jenner interview 2019",
      "Kylie Jenner red carpet",
      "kylie jenner makeup",
    ]);
  });

  it("falls back to the original queries, unmodified, when there is no memory for this entity (priming, not a hard filter)", async () => {
    getVisualSearchMemoryForEntityMock.mockResolvedValue([]);
    const result = await primeQueriesWithSearchMemory("Some New Topic", ["base query"]);
    expect(result).toEqual(["base query"]);
    expect(getVisualSearchMemoryForEntityMock).toHaveBeenCalledWith("Some New Topic", 3);
  });

  it("ignores unsuccessful memory rows", async () => {
    getVisualSearchMemoryForEntityMock.mockResolvedValue([
      { query: "bad query", usageCount: 9, success: 0 },
    ]);
    const result = await primeQueriesWithSearchMemory("X", ["base"]);
    expect(result).toEqual(["base"]);
  });

  it("never throws — a DB failure just returns the original queries so normal web sourcing proceeds", async () => {
    getVisualSearchMemoryForEntityMock.mockRejectedValue(new Error("db down"));
    const result = await primeQueriesWithSearchMemory("X", ["base"]);
    expect(result).toEqual(["base"]);
  });

  it("does nothing (no DB call) when there is no entity to key on", async () => {
    const result = await primeQueriesWithSearchMemory(undefined, ["base"]);
    expect(result).toEqual(["base"]);
    expect(getVisualSearchMemoryForEntityMock).not.toHaveBeenCalled();
  });
});

describe("reportFunnelCoverageIfInsufficient — F3-27 Test F (genuine-shortage warning wiring)", () => {
  beforeEach(() => {
    getVisualSearchMemoryForEntityMock.mockReset();
    applyCoverageWarningIfNeededMock.mockReset();
  });

  it("Test F — coverage below the recommended minimum fires the F3-26 warning with real archive/web counts", () => {
    const funnel: RetrievalFunnelResult = {
      candidates: [candidate("archive"), candidate("pexels")],
      archiveCoverage: 0.4,
      strategy: "hybrid",
    } as RetrievalFunnelResult;

    reportFunnelCoverageIfInsufficient(123, "Kylie Jenner", funnel);

    expect(applyCoverageWarningIfNeededMock).toHaveBeenCalledWith(123, {
      entity: "Kylie Jenner",
      archiveCount: 1,
      recommendedCount: 3,
      webSearchAttempted: true,
      webFoundCount: 1,
    });
  });

  it("does nothing when there is no active video id (never blocks/crashes outside a render)", () => {
    const funnel: RetrievalFunnelResult = { candidates: [], archiveCoverage: 0, strategy: "hybrid" } as RetrievalFunnelResult;
    reportFunnelCoverageIfInsufficient(null, "X", funnel);
    expect(applyCoverageWarningIfNeededMock).not.toHaveBeenCalled();
  });

  it("does nothing when there is no entity to attribute the warning to", () => {
    const funnel: RetrievalFunnelResult = { candidates: [], archiveCoverage: 0, strategy: "hybrid" } as RetrievalFunnelResult;
    reportFunnelCoverageIfInsufficient(123, undefined, funnel);
    expect(applyCoverageWarningIfNeededMock).not.toHaveBeenCalled();
  });
});
