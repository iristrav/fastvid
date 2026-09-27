import { describe, expect, it, vi } from "vitest";
import {
  buildEmergencyGeoStockQueries,
  enforceQualityExportGate,
  healQualityReportForExport,
} from "./pipelineSelfHeal";
import { isArchiveGeoBlockedForBeat } from "./curatedMediaSourcing";
import { buildVideoQualityReport, qualityStatusCeiling } from "./videoQualityReport";

describe("pipelineSelfHeal", () => {
  it("buildEmergencyGeoStockQueries anchors on Singapore title", () => {
    const queries = buildEmergencyGeoStockQueries(
      "Public housing keeps rent affordable.",
      "Why Singapore is the Blueprint for Future Cities"
    );
    expect(queries.some((q) => /singapore/i.test(q))).toBe(true);
  });

  it("blocks Kansas City stock query on Singapore beat — when metadata blocks are on", () => {
    // RONDE 30: this had been failing because isArchiveGeoBlockedForBeat opens with
    // `if (!metadataVisualBlocksEnabled()) return false;` and ENABLE_METADATA_VISUAL_BLOCKS is
    // off by default. The test is about the geo logic, so it now turns the gate on explicitly
    // rather than depending on an ambient default.
    const prev = process.env.ENABLE_METADATA_VISUAL_BLOCKS;
    process.env.ENABLE_METADATA_VISUAL_BLOCKS = "true";
    try {
      expect(
        isArchiveGeoBlockedForBeat(
          { title: "Kansas City map aerial", tags: [] },
          "Affordable housing across the island.",
          "Why Singapore is the Blueprint for Future Cities"
        )
      ).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.ENABLE_METADATA_VISUAL_BLOCKS;
      else process.env.ENABLE_METADATA_VISUAL_BLOCKS = prev;
    }
  });

  it("does NOT block it with the shipped default — the metadata gate is off", () => {
    // Documented on purpose rather than left implicit: with ENABLE_METADATA_VISUAL_BLOCKS unset
    // (the shipped default) every geo pre-block is inert and only the CLIP vision gate judges
    // location. If that default is ever changed, this case fails and forces a second look.
    expect(
      isArchiveGeoBlockedForBeat(
        { title: "Kansas City map aerial", tags: [] },
        "Affordable housing across the island.",
        "Why Singapore is the Blueprint for Future Cities"
      )
    ).toBe(false);
  });
});
