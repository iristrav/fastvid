import { describe, expect, it } from "vitest";
import { buildEmergencyGeoStockQueries } from "./pipelineSelfHeal";
import { isArchiveGeoBlockedForBeat } from "./curatedMediaSourcing";

describe("pipelineSelfHeal", () => {
  it("buildEmergencyGeoStockQueries anchors on Singapore title", () => {
    const queries = buildEmergencyGeoStockQueries(
      "Public housing keeps rent affordable.",
      "Why Singapore is the Blueprint for Future Cities"
    );
    expect(queries.some((q) => /singapore/i.test(q))).toBe(true);
  });

  it("blocks Kansas City stock query on Singapore beat", () => {
    expect(
      isArchiveGeoBlockedForBeat(
        { title: "Kansas City map aerial", tags: [] },
        "Affordable housing across the island.",
        "Why Singapore is the Blueprint for Future Cities"
      )
    ).toBe(true);
  });
});
