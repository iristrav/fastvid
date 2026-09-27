import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { computeMeritQualityScore,  } from "./videoQualityReport";
import { healQualityReportForExport } from "./pipelineSelfHeal";
import type { VideoQualityReport } from "./videoQualityReport";
import type { ScreenTimeFinding } from "./deliveredScreenTime";
import { tallyBeatVisualStatuses, type BeatVisualTally } from "./beatVisualStatus";

/**
 * WHY A 43/100 RENDER WAS STORED AS 85/100.
 *
 * Render 578 delivered a 76-second film that spent 36.3 seconds — 47.6% — on one piece of footage,
 * held a single shot for 17.4 seconds, and reported three scenes short of footage. It measured 43.
 *
 * Two separate things then happened, and both are fixed here.
 *
 *   1. The 43 was blind to the two faults a viewer would name first. Every input to the score
 *      counts BEATS and CLIPS; a 36-second clip and a 2-second clip weigh the same, so the one
 *      measurement taken on the cut itself — screen time in seconds — reached the warnings and
 *      stopped there.
 *
 *   2. The export-availability policy raised the 43 to 85, because `archiveMontageOk` reads
 *      nothing but source type: thirteen archive clips, no fallback beats, no stock. The comment
 *      in `enforceQualityExportGate` had said so for rounds — "a montage of real archive clips
 *      with no fallback beats reaches 85 on source type alone, which says nothing about whether
 *      the pictures fit the narration."
 *
 * Neither fix blocks an export. One makes the measurement see the cut; the other stops a raise
 * from making a claim the render's own verification status forbids.
 */

/** A tally whose beats were filled and approved — the good case, so nothing here is a free pass. */
function verifiedTally(beats: number): BeatVisualTally {
  return tallyBeatVisualStatuses(
    Array.from({ length: beats }, (_, i) => ({
      sceneIndex: 0,
      beatIndex: i,
      coverage: "own_footage" as const,
      verification: "verified_fit" as const,
      verifiedOwnVisual: true,
    })) as never
  );
}

/** Beats that got nothing at all — the failing case render 578 was closer to. */
function emptyTally(beats: number): BeatVisualTally {
  return tallyBeatVisualStatuses(
    Array.from({ length: beats }, (_, i) => ({
      sceneIndex: 0,
      beatIndex: i,
      coverage: "none" as const,
      verification: "never_asked" as const,
      verifiedOwnVisual: false,
    })) as never
  );
}

const baseScore = {
  totalClips: 13,
  archiveCount: 13,
  stockCount: 0,
  fallbackBeats: 0,
  offTopicCount: 0,
  geoViolationCount: 0,
  archiveOnly: true,
  fastShort: false,
  byMixKind: { real_video: 12, photo: 1, graphic: 0, generated: 0 } as never,
};

const finding = (code: ScreenTimeFinding["code"]): ScreenTimeFinding => ({ code, detail: "measured" });

describe("the delivered mix reaches the score", () => {
  it("ONE SHOT FILLING THE FILM COSTS POINTS", () => {
    const tally = verifiedTally(13);
    const clean = computeMeritQualityScore({ ...baseScore, beatVisuals: tally });
    const dominated = computeMeritQualityScore({
      ...baseScore,
      beatVisuals: tally,
      screenTime: [finding("ONE_CLIP_DOMINATES")],
    });
    expect(dominated.score).toBeLessThan(clean.score);
  });

  it("A SHOT HELD TOO LONG COSTS POINTS", () => {
    const tally = verifiedTally(13);
    const clean = computeMeritQualityScore({ ...baseScore, beatVisuals: tally });
    const held = computeMeritQualityScore({
      ...baseScore,
      beatVisuals: tally,
      screenTime: [finding("SHOT_HELD_TOO_LONG")],
    });
    expect(held.score).toBeLessThan(clean.score);
  });

  it("one source dominating is NOT charged for — it is a sourcing policy, not a fault", () => {
    /**
     * The operator runs archive-led documentaries on purpose, and `archiveOnly` twenty lines up
     * in the same function REWARDS that. Charging for it here would have one decision both earn
     * and lose points, and would fine every render in the mode the product is built around.
     */
    const tally = verifiedTally(13);
    const clean = computeMeritQualityScore({ ...baseScore, beatVisuals: tally });
    const oneSource = computeMeritQualityScore({
      ...baseScore,
      beatVisuals: tally,
      screenTime: [finding("ONE_SOURCE_DOMINATES")],
    });
    expect(oneSource.score).toBe(clean.score);
  });

  it("both faults together cost more than either alone", () => {
    const tally = verifiedTally(13);
    const one = computeMeritQualityScore({
      ...baseScore,
      beatVisuals: tally,
      screenTime: [finding("ONE_CLIP_DOMINATES")],
    });
    const both = computeMeritQualityScore({
      ...baseScore,
      beatVisuals: tally,
      screenTime: [finding("ONE_CLIP_DOMINATES"), finding("SHOT_HELD_TOO_LONG")],
    });
    expect(both.score).toBeLessThan(one.score);
  });

  it("holding a shot costs less than filling the film with one — the ordering is the point", () => {
    const tally = verifiedTally(13);
    const held = computeMeritQualityScore({
      ...baseScore,
      beatVisuals: tally,
      screenTime: [finding("SHOT_HELD_TOO_LONG")],
    });
    const dominated = computeMeritQualityScore({
      ...baseScore,
      beatVisuals: tally,
      screenTime: [finding("ONE_CLIP_DOMINATES")],
    });
    expect(dominated.score).toBeLessThan(held.score);
  });

  it("NOTHING MEASURED COSTS NOTHING", () => {
    // A caller outside a render has no clip durations. "Nothing was measured" is not a fault.
    const tally = verifiedTally(13);
    const absent = computeMeritQualityScore({ ...baseScore, beatVisuals: tally });
    const empty = computeMeritQualityScore({ ...baseScore, beatVisuals: tally, screenTime: [] });
    expect(empty.score).toBe(absent.score);
  });

  it("the penalty can never push a score below zero", () => {
    const floored = computeMeritQualityScore({
      ...baseScore,
      beatVisuals: emptyTally(4),
      fallbackBeats: 4,
      screenTime: [finding("ONE_CLIP_DOMINATES"), finding("SHOT_HELD_TOO_LONG")],
    });
    expect(floored.score).toBeGreaterThanOrEqual(0);
  });
});

describe("the render carries the measurement forward", () => {
  const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");
  const QR = readFileSync(join(__dirname, "videoQualityReport.ts"), "utf8");

  it("the findings reach the report as values, not only as prose", () => {
    expect(PIPE).toContain("deliveredScreenTimeFindings.push(f)");
    expect(PIPE).toContain("screenTime: deliveredScreenTimeFindings,");
  });

  it("EVERY RE-SCORE READS THE SAME FINDINGS", () => {
    /**
     * The signature failure this guards: a value computed once and then dropped by the readers
     * that run later. `computeMeritQualityScore` is called four times per render — once at build,
     * twice after the post-render spot check, once on a delivered-clip recount. A penalty applied
     * at only the first would vanish minutes later without a line in any log.
     */
    /**
     * RONDE 661 — the two pipeline re-scores ran after the compose montage's spot check and went
     * with it. The one re-score left is the delivered-clip recount, which reads the timeline's
     * spot check and the same screen-time findings.
     */
    expect((PIPE.match(/computeMeritQualityScore\(\{/g) ?? []).length).toBe(0);
    expect(QR, "the delivered-clip recount").toContain("screenTime: report.screenTime");
    expect(QR).toContain("postRenderOk: report.postRenderSpotCheck?.ok");
  });

  it("the report stores the findings so a later reader can charge for them", () => {
    expect(QR).toContain("screenTime?: ScreenTimeFinding[]");
    expect(QR).toContain("screenTime: opts?.screenTime ? [...opts.screenTime] : undefined");
  });
});
