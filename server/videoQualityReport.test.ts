import { describe, expect, it } from "vitest";
import {
  buildVideoQualityReport,
  computeMeritQualityScore,
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

  it("archive-only wwii scores high with vision-tracked adopts", () => {
    const report = buildVideoQualityReport(
      [
        "/tmp/scene_0_b0_curated_a12.mp4",
        "/tmp/scene_1_b1_curated_a44.mp4",
        "/tmp/scene_2_b2_curated_a88.mp4",
      ],
      "Why Did Hitler Kill Himself?",
      {
        archiveOnly: true,
        fastShort: true,
        adoptAudit: [
          {
            sceneIndex: 0,
            beatIndex: 0,
            beatText: "In April 1945, Berlin was collapsing.",
            basename: "scene_0_b0_curated_a12.mp4",
            source: "archive",
            assetTitle: "Berlin street 1945 archival footage",
            visionScore10: 8,
          },
          {
            sceneIndex: 1,
            beatIndex: 0,
            beatText: "Allied forces closed in from every direction.",
            basename: "scene_1_b1_curated_a44.mp4",
            source: "archive",
            assetTitle: "Allied tanks advance Germany 1945",
            visionScore10: 9,
          },
          {
            sceneIndex: 2,
            beatIndex: 0,
            beatText: "Inside the bunker, the end was near.",
            basename: "scene_2_b2_curated_a88.mp4",
            source: "archive",
            assetTitle: "Hitler bunker documentary still",
            visionScore10: 8,
          },
        ],
      }
    );
    expect(report.visualTopic).toBe("wwii");
    expect(report.score).toBeGreaterThanOrEqual(85);
    expect(report.criticalGeoViolations ?? []).toHaveLength(0);
  });

  it("computeMeritQualityScore rewards strong vision averages", () => {
    const score = computeMeritQualityScore({
      totalClips: 3,
      archiveCount: 3,
      stockCount: 0,
      fallbackBeats: 0,
      offTopicCount: 0,
      geoViolationCount: 0,
      archiveOnly: true,
      fastShort: true,
      byMixKind: { real_video: 3, photo: 0, stock: 0, screenshot: 0, motion_graphics: 0 },
      adoptAudit: [
        { sceneIndex: 0, beatIndex: 0, beatText: "a", basename: "a.mp4", source: "archive", visionScore10: 8 },
        { sceneIndex: 0, beatIndex: 1, beatText: "b", basename: "b.mp4", source: "archive", visionScore10: 9 },
      ],
    });
    expect(score).toBeGreaterThanOrEqual(88);
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
