import { describe, expect, it } from "vitest";
import {
  buildVideoQualityReport,
  inferClipSourceFromPath,
} from "./videoQualityReport";
import { wikimediaV1AdoptionThreshold, wikimediaMetadataPassesGeoGate } from "./visualMatchingEngine";

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
  it("flags geo off-topic stock for NL/US city docs", () => {
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
});

describe("wikimediaV1AdoptionThreshold", () => {
  it("uses lower threshold for geography docs", () => {
    expect(
      wikimediaV1AdoptionThreshold("Dutch cities vs American suburbs", "Amsterdam canal district")
    ).toBe(68);
    expect(wikimediaV1AdoptionThreshold("The sinking of the Titanic", "RMS Titanic departure")).toBe(78);
  });

  it("rejects ford dealer metadata for geo docs", () => {
    expect(
      wikimediaMetadataPassesGeoGate(
        "Ford dealer showroom classic car lot",
        "Netherlands vs United States cities",
        "American car culture"
      )
    ).toBe(false);
  });
});
