import { describe, expect, it } from "vitest";
import { isInformationalSpotWarning } from "./postRenderSpotCheck";

describe("isInformationalSpotWarning", () => {
  it("blocks when the final video is missing or too small (pre-existing behavior)", () => {
    expect(isInformationalSpotWarning("Final video missing or too small")).toBe(false);
  });

  it("blocks a fully black final video (worstMeanLuma < 1) — F3-02", () => {
    expect(isInformationalSpotWarning("Final video appears fully black (worst luma 0)")).toBe(false);
  });

  it("does NOT block a video with some dark frames but not fully black", () => {
    expect(
      isInformationalSpotWarning(
        "2/4 spot-check frames are dark (worst luma 12 — expected for dark archive footage)"
      )
    ).toBe(true);
  });

  it("does NOT block ordinary blackdetect/freezedetect/silencedetect segment warnings", () => {
    expect(
      isInformationalSpotWarning("blackdetect: 3 dark/black segment(s) in final video (expected for dark archive scenes)")
    ).toBe(true);
    expect(
      isInformationalSpotWarning("freezedetect: 1 frozen segment(s) in final video (expected for archive montage holds)")
    ).toBe(true);
    expect(isInformationalSpotWarning("silencedetect: 4 silent gap(s) in audio track")).toBe(true);
  });

  it("does NOT block unrelated informational warnings", () => {
    expect(isInformationalSpotWarning("ffprobe could not read final video duration")).toBe(true);
    expect(isInformationalSpotWarning("Final video very short (5.0s)")).toBe(true);
  });
});
