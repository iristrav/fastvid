import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { indefensibleExportConditions, type VideoQualityReport } from "./videoQualityReport";

/**
 * A QUALITY BLOCK MUST SAY WHICH FILE IT MEASURED.
 *
 * The stillness and repetition audits run at stage 6 on the compose montage — the first point a
 * finished MP4 exists. After the delivery cutover the viewer may instead receive the cinematic
 * timeline render, built later by a different renderer from its own clip list, and neither audit is
 * re-run on it. `postRenderSpotCheck` and the FINAL_VIDEO source audit both already correct
 * themselves at that moment; these two were left behind, so a report could state "the picture never
 * stands still for more than 8s" about a file nobody received.
 *
 * They cannot correct themselves — each is a multi-minute ffmpeg pass over the whole export — so
 * they withdraw the claim instead: `measuredOn` names the file, and the render log says so out loud.
 *
 * These tests guard three things, in order of what would hurt most if it broke:
 *   1. the flip actually happens on the cinematic-delivery path, in the same block as the spot
 *      check it mirrors;
 *   2. `measuredOn` is REQUIRED, so a future block cannot omit it and read as delivered by default;
 *   3. neither field reaches an export gate, because a claim about provenance must never become a
 *      lever on deliverability.
 */

const PIPELINE = path.join(__dirname, "videoPipeline.ts");
const REPORT = path.join(__dirname, "videoQualityReport.ts");

function read(file: string): string {
  return fs.readFileSync(file, "utf8");
}

describe("stillness and repetition name the file they measured", () => {
  it("both blocks are written as delivered_file where the audits actually run", () => {
    const src = read(PIPELINE);
    /**
     * The honest default. On the fallback path the compose montage IS the deliverable, so starting
     * here means that path needs no correction at all — only the cinematic path does.
     */
    expect(src).toContain(`measuredOn: "delivered_file",\n        durationSec: stillness.durationSec,`);
    expect(src).toContain(`measuredOn: "delivered_file",\n        distinctPictures: repeats.distinctPictures,`);
  });

  it("both are flipped to compose_montage when the cinematic render delivers", () => {
    const src = read(PIPELINE);
    expect(src).toContain(`qualityReport.stillness.measuredOn = "compose_montage";`);
    expect(src).toContain(`qualityReport.repeats.measuredOn = "compose_montage";`);
  });

  it("the flip sits in the same block as the spot check it mirrors", () => {
    /**
     * Position, not just presence. The correction is only correct where `jobOutcome.ok` is already
     * established — the spot-check overwrite is that block's anchor, and the flip must follow it
     * before the block ends. A flip that drifted out to an unconditional path would mark every
     * render's figures as compose-only, including the renders where they are exactly right.
     */
    const src = read(PIPELINE);
    /**
     * Anchored on the spot check's own DELIVERED-file warning rather than on the assignment:
     * `postRenderSpotCheck = {` is written twice — once at stage 6 from the compose file, once here
     * from the render job — and the first of those is the wrong end of the file to measure from.
     */
    const anchor = src.indexOf("qualityReport.warnings.push(`Delivered file: ${w}`);");
    const flip = src.indexOf(`qualityReport.stillness.measuredOn = "compose_montage";`);
    expect(anchor).toBeGreaterThan(-1);
    expect(flip).toBeGreaterThan(anchor);
    expect(flip - anchor).toBeLessThan(2_000);
  });

  it("the render log says out loud that the two figures describe another file", () => {
    const src = read(PIPELINE);
    expect(src).toContain("stillness/repetition were measured on the compose montage");
  });

  it("measuredOn is required on both blocks, so it cannot be omitted into a default", () => {
    const src = read(REPORT);
    /**
     * `measuredOn?:` would let a block omit the field, and an absent field reads as "no concern
     * here" — which is the exact reassurance this round removed. Required means a new writer has to
     * decide.
     */
    expect(src).not.toMatch(/measuredOn\?:/);
    expect(src.match(/measuredOn: "delivered_file" \| "compose_montage";/g)).toHaveLength(2);
  });
});

describe("naming the file changes no gate", () => {
  const base: VideoQualityReport = {
    warnings: [],
    totalClips: 0,
    bySource: {},
  } as unknown as VideoQualityReport;

  it("neither measuredOn value is read by the export gate", () => {
    const composeOnly = {
      ...base,
      stillness: { measuredOn: "compose_montage" },
      repeats: { measuredOn: "compose_montage" },
    } as unknown as VideoQualityReport;
    const delivered = {
      ...base,
      stillness: { measuredOn: "delivered_file" },
      repeats: { measuredOn: "delivered_file" },
    } as unknown as VideoQualityReport;

    /**
     * Same conditions either way. If marking a figure as compose-only ever REMOVED an export
     * condition, this round would have built a way to talk a render past the gate — which is the
     * opposite of what withdrawing a claim is for.
     */
    expect(indefensibleExportConditions(composeOnly).map((c) => c.code)).toEqual(
      indefensibleExportConditions(delivered).map((c) => c.code)
    );
  });

  it("the export gate module does not mention measuredOn at all", () => {
    const src = read(REPORT);
    const gateStart = src.indexOf("export function indefensibleExportConditions");
    expect(gateStart).toBeGreaterThan(-1);
    expect(src.slice(gateStart)).not.toContain("measuredOn");
  });
});
