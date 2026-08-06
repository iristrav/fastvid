import { describe, expect, it } from "vitest";
import { buildAspectRatioFilter, buildScaleCropFilter, buildScalePadFilter, chooseCropMode, dimensionsFor } from "./aspectRatio";

describe("Aspect Ratio (Phase 7)", () => {
  it("returns the correct dimensions for each supported format", () => {
    expect(dimensionsFor("16:9")).toEqual({ width: 1920, height: 1080 });
    expect(dimensionsFor("9:16")).toEqual({ width: 1080, height: 1920 });
    expect(dimensionsFor("1:1")).toEqual({ width: 1080, height: 1080 });
  });

  it("buildScalePadFilter matches the legacy SCALE_PAD_VF template shape", () => {
    const filter = buildScalePadFilter({ width: 1920, height: 1080 });
    expect(filter).toBe("scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x2a2a2a");
  });

  it("buildScaleCropFilter matches the legacy CROP_FILL_VF template shape", () => {
    const filter = buildScaleCropFilter({ width: 1080, height: 1920 });
    expect(filter).toBe("scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920:(iw-1080)/2:(ih-1920)/2");
  });

  it("chooses fill (crop) when the source aspect ratio is close to the target", () => {
    // 1920x1080 (16:9) source into a 16:9 target — near-identical ratio.
    expect(chooseCropMode({ width: 1920, height: 1080 }, "16:9")).toBe("fill");
  });

  it("chooses fit (pad) when the source aspect ratio is far from the target", () => {
    // 1920x1080 (landscape, 16:9) source into a 9:16 (portrait) target — large mismatch.
    expect(chooseCropMode({ width: 1920, height: 1080 }, "9:16")).toBe("fit");
  });

  it("buildAspectRatioFilter falls back to fit (never crops blind) when source dimensions are unknown", () => {
    const filter = buildAspectRatioFilter(null, "9:16");
    expect(filter).toContain("pad=");
    expect(filter).not.toContain("crop=");
  });

  it("buildAspectRatioFilter falls back to fit for zero/invalid source dimensions", () => {
    const filter = buildAspectRatioFilter({ width: 0, height: 0 }, "1:1");
    expect(filter).toContain("pad=");
  });

  it("buildAspectRatioFilter picks crop for a well-matched source/target pair", () => {
    const filter = buildAspectRatioFilter({ width: 1080, height: 1920 }, "9:16");
    expect(filter).toContain("crop=");
  });
});
