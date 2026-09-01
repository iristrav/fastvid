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
    // RONDE 30: criticalGeoViolations is produced by isArchiveGeoBlockedForBeat, which opens
    // with `if (!metadataVisualBlocksEnabled()) return false;` — and that flag is off by
    // default, so with shipped settings the quality report can never report a geo violation at
    // all. The case is about the detection logic, so it enables the gate explicitly.
    const prevBlocks = process.env.ENABLE_METADATA_VISUAL_BLOCKS;
    process.env.ENABLE_METADATA_VISUAL_BLOCKS = "true";
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
    if (prevBlocks === undefined) delete process.env.ENABLE_METADATA_VISUAL_BLOCKS;
    else process.env.ENABLE_METADATA_VISUAL_BLOCKS = prevBlocks;
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
    /**
     * SUPERSEDED BY RONDE 105, deliberately — this asserted the defect.
     *
     * The claim was "archive-only WWII with vision-tracked adopts scores high", and the score it
     * measured was `45 + avg*5.5 + min*0.5` over CLIP's `visionScore10`. RONDE 103 removed CLIP as
     * the content decider because its verdicts on exactly this material are inverted (RONDE 58:
     * a white-lives-matter sticker 0.2226 against a signed photograph of Hitler 0.2116, same
     * beat), and the report went on grading renders with it. A production render shipped
     * `100/100 (Excellent)` on a montage the vision model had approved not one frame of.
     *
     * This call supplies no relevance ledger, so nothing here was ever checked by the one content
     * decider this pipeline has. The honest score for that is a floor with a status attached, and
     * that is now what it gets. The geo assertion below is untouched and is what this case was
     * really about.
     */
    expect(report.qualityStatus).toBe("INSUFFICIENT_VERIFICATION");
    expect(report.score).toBeLessThan(85);
    expect(report.qualityReason).toContain("beats");
    expect(report.criticalGeoViolations ?? []).toHaveLength(0);
  });

  it("computeMeritQualityScore no longer rewards strong CLIP averages", () => {
    /**
     * SUPERSEDED BY RONDE 105, deliberately — the rule is inverted, on purpose.
     *
     * This asserted that two adopts with CLIP scores of 8 and 9 earn at least 88. That is the
     * mechanism that produced `100/100` for a render nobody had looked at: only four of the
     * pipeline's adopt sites record a CLIP score at all, so the average was over a handful of
     * clips and the base term reached its ceiling whenever those few scored well.
     *
     * The base is now the share of beats with their OWN footage that the vision model approved.
     * A high CLIP average with no relevance verdicts must not move it.
     */
    const verdict = computeMeritQualityScore({
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
    expect(verdict.status).toBe("INSUFFICIENT_VERIFICATION");
    expect(verdict.score).toBeLessThan(85);

    // A perfect CLIP score changes nothing, which is the whole point.
    const perfect = computeMeritQualityScore({
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
        { sceneIndex: 0, beatIndex: 0, beatText: "a", basename: "a.mp4", source: "archive", visionScore10: 10 },
        { sceneIndex: 0, beatIndex: 1, beatText: "b", basename: "b.mp4", source: "archive", visionScore10: 10 },
      ],
    });
    expect(perfect.score).toBe(verdict.score);
  });

  it("Singapore geo violations are detected in report", () => {
    // RONDE 30: criticalGeoViolations is produced by isArchiveGeoBlockedForBeat, which opens
    // with `if (!metadataVisualBlocksEnabled()) return false;` — and that flag is off by
    // default, so with shipped settings the quality report can never report a geo violation at
    // all. The case is about the detection logic, so it enables the gate explicitly.
    const prevBlocks = process.env.ENABLE_METADATA_VISUAL_BLOCKS;
    process.env.ENABLE_METADATA_VISUAL_BLOCKS = "true";
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
    if (prevBlocks === undefined) delete process.env.ENABLE_METADATA_VISUAL_BLOCKS;
    else process.env.ENABLE_METADATA_VISUAL_BLOCKS = prevBlocks;
  });

  it("reports no geo violations with the shipped default — the metadata gate is off", () => {
    // Recorded on purpose: with ENABLE_METADATA_VISUAL_BLOCKS unset, a Kansas City map adopted
    // on a Singapore documentary produces an EMPTY violation list. If that default is ever
    // changed, this fails and forces a second look.
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
    expect(report.criticalGeoViolations).toBeUndefined();
  });
});

describe("wikimediaV1AdoptionThreshold", () => {
  it("uses one universal default for all topics", () => {
    expect(
      wikimediaV1AdoptionThreshold("Dutch cities vs American suburbs", "Amsterdam canal district")
    ).toBe(55);
    // RONDE 30: was 70. The universal default is 55 now (see visualMatchingEngine.ts). What the
    // case is really about is that the threshold does not vary by topic — asserted directly.
    expect(wikimediaV1AdoptionThreshold("The sinking of the Titanic", "RMS Titanic departure")).toBe(55);
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
