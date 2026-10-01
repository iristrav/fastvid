/**
 * ONE ROUTE — every rule that may refuse to deliver a film lives in the DeliveryGate.
 *
 * The rules used to be spread over the quality report, the self-heal module, the screen-time count,
 * the YouTube footage count, the spot check and the published-file check. They moved here unchanged;
 * the callers still ask each one at the moment its evidence is complete.
 */
import { readFileSync, readdirSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { deliveryGate, finalVideoRefusals, visualCoverageFallsShort } from "./deliveryGate";

const RULES = [
  "assertVisualCoverageExportGate",
  "visionCoverageRefusal",
  "assertVisionCoverageExportGate",
  "indefensibleExportConditions",
  "enforceQualityExportGate",
  "finalTimelineFootageRefusal",
  "judgeYoutubeRequirement",
  "blankPictureFinding",
  "finalVideoRefusals",
  "visualCoverageFallsShort",
  "filmWithoutPictureRefusal",
];

const serverFiles = readdirSync(__dirname).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

describe("the DeliveryGate is the one owner of DELIVER / BLOCK", () => {
  it("no other module declares a delivery rule", () => {
    for (const file of serverFiles) {
      if (file === "deliveryGate.ts") continue;
      const src = readFileSync(path.join(__dirname, file), "utf8");
      for (const rule of RULES) {
        expect(src, `${file} declares ${rule}`).not.toMatch(
          new RegExp(`(function|const)\\s+${rule}\\b`)
        );
      }
    }
  });

  it("the readiness report asks the gate's own coverage rule instead of repeating it", () => {
    const report = readFileSync(path.join(__dirname, "videoQualityReport.ts"), "utf8");
    expect(report).toContain("blocking: visualCoverageFallsShort(report, sceneRescueColorFallbackCount),");
    expect(report).not.toContain("fallbackBeats / beatsFilled > 0.5");
  });

  it("the render job has one refusal for content, the gate's", () => {
    const worker = readFileSync(path.join(__dirname, "renderJobWorker.ts"), "utf8");
    expect(worker).not.toContain("`FINAL_PICTURE_IS_BLACK: ${blank}`");
    expect(worker).toContain("blankPicture: blankPictureFinding(spotCheck),");
  });
});

describe("the rules decide exactly as before", () => {
  it("coverage: one placeholder scene, or more than half the beats card-only", () => {
    const report = (beatsFilled: number, fallbackBeats: number) =>
      ({ adoptAuditSummary: { beatsFilled, fallbackBeats } }) as never;
    expect(visualCoverageFallsShort(report(10, 5), 0)).toBe(false);
    expect(visualCoverageFallsShort(report(10, 6), 0)).toBe(true);
    expect(visualCoverageFallsShort(report(10, 0), 1)).toBe(true);
  });

  it("a blank picture blocks the delivery, and is the first reason named", () => {
    const verdict = deliveryGate({
      videoId: 1,
      route: "cinematic_timeline",
      timelineExists: false,
      clips: [],
      delivered: null,
      blankPicture: "all 4 sampled frame(s) of the delivered file are black",
    });
    expect(verdict.allow).toBe(false);
    if (!verdict.allow) expect(verdict.failures[0]!.code).toBe("FINAL_PICTURE_IS_BLACK");
  });

  it("the published file: size, both streams and the shortest duration its length allows", () => {
    const ok = { sizeBytes: 50_000_000, hasVideo: true, hasAudio: true, durationSec: 300 };
    expect(finalVideoRefusals(ok, "8-10")).toEqual([]);
    expect(finalVideoRefusals({ ...ok, durationSec: 200 }, "8-10")[0]).toMatch(/too short/);
    expect(finalVideoRefusals({ ...ok, hasAudio: false }, "8-10")).toEqual(["Final video has no audio stream"]);
  });
});
