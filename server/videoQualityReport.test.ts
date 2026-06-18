import { describe, expect, it } from "vitest";
import {
  buildVideoQualityReport,
  inferClipSourceFromPath,
  assertQualityReportExportGate,
} from "./videoQualityReport";
import { wikimediaV1AdoptionThreshold, wikimediaMetadataPassesBeatGate } from "./visualMatchingEngine";

describe("inferClipSourceFromPath", () => {
  it("classifies wikimedia v1 stills", () => {
    expect(inferClipSourceFromPath("/tmp/scene_0_wiki0_v1wiki_b1.mp4")).toBe("wikimedia");
  });

  it("classifies archive curated clips", () => {
    expect(inferClipSourceFromPath("/tmp/scene_1_b0_hist_archive_titanic.mp4")).toBe("archive");
  });

  it("classifies pexels stock", () => {
    expect(inferClipSourceFromPath("/tmp/scene_0_b0_pexels_vid123.mp4")).toBe("pexels");
  });
});

describe("buildVideoQualityReport", () => {
  it("flags off-topic stock for any documentary with geo title", () => {
    const report = buildVideoQualityReport(
      [
        "/tmp/scene_0_b0_hist_archive_amsterdam.mp4",
        "/tmp/scene_1_b0_pexels_vid99.mp4",
        "/tmp/scene_2_force_serp_columbus_city_council.mp4",
      ],
      "Netherlands vs United States: urban planning"
    );
    expect(report.visualTopic).toBe("geography_urban");
    expect(report.archiveCount).toBeGreaterThanOrEqual(1);
    expect(report.offTopicSuspects.length).toBeGreaterThanOrEqual(1);
    expect(report.score).toBeLessThan(100);
  });

  it("assertQualityReportExportGate records violations without blocking pipeline", () => {
    const report = buildVideoQualityReport(
      ["/tmp/scene_0_b0_hist_archive_kansas.mp4"],
      "Why the Netherlands Is the Opposite of the U.S.",
      {
        adoptAudit: [
          {
            sceneIndex: 0,
            beatIndex: 0,
            beatText: "In cities across the Netherlands, bike lanes are everywhere.",
            basename: "scene_0_b0_hist_archive_kansas.mp4",
            source: "archive",
            assetTitle: "Kansas City metropolitan area map 1972",
            segmentGeoLock: "nl",
          },
        ],
      }
    );
    expect(report.criticalGeoViolations?.length).toBeGreaterThanOrEqual(1);
    expect(() => assertQualityReportExportGate(report)).not.toThrow();
  });

  it("Singapore geo violations are detected in report", () => {
    const report = buildVideoQualityReport(
      ["/tmp/scene_0_b0_hist_archive_kansas.mp4"],
      "Why Singapore is the Blueprint for Future Cities",
      {
        adoptAudit: [
          {
            sceneIndex: 0,
            beatIndex: 0,
            beatText: "Affordable public housing shapes daily life.",
            basename: "scene_0_b0_hist_archive_kansas.mp4",
            source: "archive",
            assetTitle: "Historical Map of Kansas City with Railroads",
          },
        ],
      }
    );
    expect(report.criticalGeoViolations?.length).toBeGreaterThanOrEqual(1);
  });
});

describe("wikimediaV1AdoptionThreshold", () => {
  it("uses one universal default for all topics", () => {
    expect(
      wikimediaV1AdoptionThreshold("Dutch cities vs American suburbs", "Amsterdam canal district")
    ).toBe(70);
    expect(wikimediaV1AdoptionThreshold("The sinking of the Titanic", "RMS Titanic departure")).toBe(70);
  });

  it("rejects ford dealer metadata unless beat allows", () => {
    expect(
      wikimediaMetadataPassesBeatGate(
        "Ford dealer showroom classic car lot",
        "Netherlands vs United States cities",
        "American car culture and dealers"
      )
    ).toBe(true);
    expect(
      wikimediaMetadataPassesBeatGate(
        "Ford dealer showroom classic car lot",
        "Netherlands vs United States cities",
        "Dutch cycling infrastructure"
      )
    ).toBe(false);
  });
});
