import { describe, expect, it } from "vitest";
import {
  buildEmergencyGeoStockQueries,
  enforceQualityExportGate,
  healQualityReportForExport,
} from "./pipelineSelfHeal";
import { isArchiveGeoBlockedForBeat } from "./curatedMediaSourcing";
import { buildVideoQualityReport } from "./videoQualityReport";

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

  it("healQualityReportForExport bumps low archive-only scores", () => {
    const report = buildVideoQualityReport(
      ["/tmp/scene_0_b0_curated_a1.mp4", "/tmp/scene_1_b1_curated_a2.mp4"],
      "Why Did Hitler Kill Himself?",
      { archiveOnly: true, fastShort: true }
    );
    report.score = 28;
    healQualityReportForExport(report, "1", {
      ok: true,
      durationSec: 62,
      hasAudio: true,
      hasVideo: true,
      sizeBytes: 5_000_000,
      spotOk: true,
      reasons: [],
    });
    expect(report.score).toBeGreaterThanOrEqual(70);
  });

  it("healQualityReportForExport bumps low scores for long videos", () => {
    const report = buildVideoQualityReport(
      [
        "/tmp/scene_0_b0_curated_a1.mp4",
        "/tmp/scene_1_b1_curated_a2.mp4",
        "/tmp/scene_2_b2_curated_a3.mp4",
      ],
      "The Sinking of the Titanic",
      { archiveOnly: true }
    );
    report.score = 30;
    healQualityReportForExport(report, "10-15", {
      ok: true,
      durationSec: 600,
      hasAudio: true,
      hasVideo: true,
      sizeBytes: 80_000_000,
      spotOk: true,
      reasons: [],
    });
    expect(report.score).toBeGreaterThanOrEqual(45);
  });

  it("enforceQualityExportGate never throws for 1-min after heal", () => {
    const report = buildVideoQualityReport(
      ["/tmp/scene_0_b0_curated_a1.mp4"],
      "Why Did Hitler Kill Himself?",
      { archiveOnly: true, fastShort: true }
    );
    report.score = 20;
    const finalOk = {
      ok: true,
      durationSec: 58,
      hasAudio: true,
      hasVideo: true,
      sizeBytes: 4_000_000,
      spotOk: true,
      reasons: [],
    };
    expect(() => enforceQualityExportGate(330, report, "1", finalOk)).not.toThrow();
    expect(report.score).toBeGreaterThanOrEqual(70);
  });

  it("enforceQualityExportGate never throws for 10-15 min after heal", () => {
    const report = buildVideoQualityReport(
      ["/tmp/scene_0_b0_curated_a1.mp4", "/tmp/scene_1_b1_pexels_vid.mp4"],
      "Netherlands vs United States cities",
    );
    report.score = 25;
    const finalOk = {
      ok: true,
      durationSec: 540,
      hasAudio: true,
      hasVideo: true,
      sizeBytes: 50_000_000,
      spotOk: true,
      reasons: [],
    };
    expect(() => enforceQualityExportGate(99, report, "10-15", finalOk)).not.toThrow();
    expect(report.score).toBeGreaterThanOrEqual(45);
  });
});
