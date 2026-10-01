import { describe, expect, it, vi } from "vitest";
import { buildEmergencyGeoStockQueries, healQualityReportForExport } from "./pipelineSelfHeal";
import { buildVideoQualityReport, qualityStatusCeiling } from "./videoQualityReport";
import { judgeArchiveAsset, judgeArchiveAssetCountry } from "./visualJudge";
import { enforceQualityExportGate } from "./deliveryGate";

/** The archive judge's yes/no, in the shape these cases were written against. */
const assetPassesBeatMinimum = (
  asset: Parameters<typeof judgeArchiveAsset>[0]["asset"],
  beatText: string,
  score: number,
  topScore: number,
  semantic?: Parameters<typeof judgeArchiveAsset>[0]["semantic"],
  videoVisualTopic?: Parameters<typeof judgeArchiveAsset>[0]["videoVisualTopic"],
  segmentLock?: Parameters<typeof judgeArchiveAsset>[0]["segmentLock"],
  literalVisualTags?: string[],
  videoTitle?: string
): boolean =>
  judgeArchiveAsset({ asset, beatText, score, topScore, semantic, videoVisualTopic, segmentLock, literalVisualTags, videoTitle })
    .decision === "ACCEPT";
const isArchiveGeoBlockedForBeat = (
  asset: Parameters<typeof judgeArchiveAssetCountry>[0],
  beatText: string,
  videoTitle?: string,
  segmentLock?: Parameters<typeof judgeArchiveAssetCountry>[3]
): boolean => judgeArchiveAssetCountry(asset, beatText, videoTitle, segmentLock).decision === "REJECT";

describe("pipelineSelfHeal", () => {

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
