import { describe, expect, it } from "vitest";
import { archiveCrossVideoVarietyEnabled } from "./sourcingPolicy";

describe("archiveCrossVideoVarietyEnabled (Phase 10)", () => {
  const prev = process.env.ARCHIVE_CROSS_VIDEO_VARIETY;
  const restore = () => {
    if (prev === undefined) delete process.env.ARCHIVE_CROSS_VIDEO_VARIETY;
    else process.env.ARCHIVE_CROSS_VIDEO_VARIETY = prev;
  };

  it("is enabled by default for short/fast videos, not just long ones", () => {
    delete process.env.ARCHIVE_CROSS_VIDEO_VARIETY;
    expect(archiveCrossVideoVarietyEnabled("1")).toBe(true);
    expect(archiveCrossVideoVarietyEnabled("8-10")).toBe(true);
    restore();
  });

  it("respects the ARCHIVE_CROSS_VIDEO_VARIETY=false override regardless of video length", () => {
    process.env.ARCHIVE_CROSS_VIDEO_VARIETY = "false";
    expect(archiveCrossVideoVarietyEnabled("1")).toBe(false);
    expect(archiveCrossVideoVarietyEnabled("8-10")).toBe(false);
    restore();
  });
});
