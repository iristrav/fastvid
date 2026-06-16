import { describe, expect, it } from "vitest";
import {
  buildBlurFillStillVF,
  buildFitGrayVideoFilterComplex,
  buildMatFramedStillVF,
  buildPolaroidStillVF,
  buildPostGradeVF,
  buildPerClipDocumentaryGradeVF,
  buildMontageBranchNormVF,
  buildFinalSceneGradeVF,
  buildFitGrayGradedVideoVF,
  documentaryStyleEnabled,
  resolveStillCompositionVF,
  usePolaroidLayout,
} from "./documentaryStyle";

describe("documentaryStyle", () => {
  it("is enabled by default", () => {
    const prev = process.env.ENABLE_DOC_STYLE;
    delete process.env.ENABLE_DOC_STYLE;
    expect(documentaryStyleEnabled()).toBe(true);
    process.env.ENABLE_DOC_STYLE = "false";
    expect(documentaryStyleEnabled()).toBe(false);
    if (prev === undefined) delete process.env.ENABLE_DOC_STYLE;
    else process.env.ENABLE_DOC_STYLE = prev;
  });

  it("alternates polaroid layout", () => {
    expect(usePolaroidLayout(0, 0)).toBe(true);
    expect(usePolaroidLayout(1, 0)).toBe(false);
    expect(usePolaroidLayout(1, 1)).toBe(true);
  });

  it("builds blur-fill filter with ken burns", () => {
    const vf = buildBlurFillStillVF(4.0);
    expect(vf).toContain("gblur=sigma=38");
    expect(vf).toContain("zoompan=");
    expect(vf).toContain("overlay=");
  });

  it("builds fast fit-gray video filter without blur", () => {
    const vf = buildFitGrayVideoFilterComplex();
    expect(vf).toContain("force_original_aspect_ratio=decrease");
    expect(vf).toContain("color=0x2a2a2a");
    expect(vf).not.toContain("gblur");
    expect(vf).toContain("[vout]");
  });

  it("builds polaroid filter", () => {
    const vf = buildPolaroidStillVF(3.5);
    expect(vf).toContain("pad=960:1040");
    expect(vf).toContain("select='eq(n\\,0)'");
    expect(vf).toContain("[vout]");
  });

  it("builds gray mat framed still with ken burns", () => {
    const vf = buildMatFramedStillVF(4.0, 0.74, 1, 2);
    expect(vf).toContain("color=0xCFCFCF");
    expect(vf).toContain("zoompan=");
    expect(vf).toContain("[vout]");
  });

  it("film grain enabled by default", () => {
    const prev = process.env.ENABLE_FILM_GRAIN;
    delete process.env.ENABLE_FILM_GRAIN;
    expect(buildPostGradeVF()).toContain("noise=");
    process.env.ENABLE_FILM_GRAIN = "false";
    expect(buildPostGradeVF()).not.toContain("noise=");
    if (prev === undefined) delete process.env.ENABLE_FILM_GRAIN;
    else process.env.ENABLE_FILM_GRAIN = prev;
  });

  it("uses consistent gray-mat still composition", () => {
    const vf = resolveStillCompositionVF(4, 1, 0, false);
    expect(vf).toContain("color=0xCFCFCF");
    expect(vf).toContain("zoompan=");
    expect(vf).not.toContain("gblur");
    expect(vf).not.toContain("pad=960:1040");
  });

  it("builds post grade chain", () => {
    const vf = buildPostGradeVF();
    expect(vf).toContain("vignette=");
    expect(vf).toContain("eq=contrast");
  });

  it("builds per-clip and final scene grades", () => {
    expect(buildPerClipDocumentaryGradeVF()).toContain("eq=contrast");
    expect(buildPerClipDocumentaryGradeVF()).toContain("vignette=");
    expect(buildMontageBranchNormVF()).toContain("color=0x2a2a2a");
    expect(buildMontageBranchNormVF()).toContain("eq=contrast");
    expect(buildFitGrayGradedVideoVF()).toContain("eq=contrast");
    expect(buildFinalSceneGradeVF()).toMatch(/noise=|copy/);
  });
});
