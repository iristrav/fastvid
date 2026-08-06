import { describe, expect, it } from "vitest";
import {
  buildBlurFillStillVF,
  buildFitGrayVideoFilterComplex,
  buildKenBurnsTail,
  buildMatFramedStillVF,
  buildPolaroidStillVF,
  buildPostGradeVF,
  buildPerClipDocumentaryGradeVF,
  buildMontageBranchNormVF,
  buildFinalSceneGradeVF,
  buildFitGrayGradedVideoVF,
  buildSimpleKenBurnsVF,
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
    expect(vf).toContain("gblur=sigma=42");
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

  it("uses blur-fill still composition by default", () => {
    const vf = resolveStillCompositionVF(4, 1, 0, false);
    expect(vf).toContain("gblur=sigma=42");
    expect(vf).toContain("zoompan=");
    expect(vf).toContain("overlay=");
    expect(vf).not.toContain("pad=960:1040");
  });

  it("falls back to gray mat when ARCHIVE_BLUR_FILL_STILLS=false", () => {
    const prev = process.env.ARCHIVE_BLUR_FILL_STILLS;
    process.env.ARCHIVE_BLUR_FILL_STILLS = "false";
    const vf = resolveStillCompositionVF(4, 1, 0, false);
    expect(vf).toContain("color=0xCFCFCF");
    expect(vf).not.toContain("gblur");
    if (prev === undefined) delete process.env.ARCHIVE_BLUR_FILL_STILLS;
    else process.env.ARCHIVE_BLUR_FILL_STILLS = prev;
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

  describe("Ken Burns easing (Phase 10)", () => {
    it("buildKenBurnsTail uses an eased sine progress curve, not a linear zoom+step increment", () => {
      const vf = buildKenBurnsTail(4, 1.1, "center", "zoom-in");
      expect(vf).toContain("sin(PI/2*min(on/");
      expect(vf).not.toContain("min(zoom+");
      expect(vf).not.toContain("max(zoom-");
    });

    it("zoom-in starts at 1.0 and eases toward zoomEnd", () => {
      const vf = buildKenBurnsTail(4, 1.2, "center", "zoom-in");
      expect(vf).toContain("z='(1.0000+(0.2000000)*sin(PI/2*min(on/");
    });

    it("zoom-out starts at zoomEnd and eases toward 1.0 (negative delta)", () => {
      const vf = buildKenBurnsTail(4, 1.2, "center", "zoom-out");
      expect(vf).toContain("z='(1.2000+(-0.2000000)*sin(PI/2*min(on/");
    });

    it("pan-left/pan-right ease the same total pixel distance a linear pan would have covered", () => {
      const totalFrames = 100; // 4s @ 25fps
      const panStep = Math.max(1, Math.round(totalFrames * 0.06));
      const expectedDistance = panStep * totalFrames;
      const left = buildKenBurnsTail(4, 1.02, "center", "pan-left");
      const right = buildKenBurnsTail(4, 1.02, "center", "pan-right");
      expect(left).toContain(`-${expectedDistance}*sin(PI/2*min(on/`);
      expect(right).toContain(`+${expectedDistance}*sin(PI/2*min(on/`);
    });

    it("center variant has no pan term regardless of easing", () => {
      const vf = buildKenBurnsTail(4, 1.05, "center", "center");
      expect(vf).toContain("x='iw/2-(iw/zoom/2)'");
    });

    it("buildSimpleKenBurnsVF fallback also eases instead of using a linear zoom+step", () => {
      const vf = buildSimpleKenBurnsVF(4, false);
      expect(vf).toContain("sin(PI/2*min(on/");
      expect(vf).not.toContain("min(zoom+");
    });

    it("buildSimpleKenBurnsVF uses a smaller zoom target for portraits than non-portraits", () => {
      const portrait = buildSimpleKenBurnsVF(4, true);
      const nonPortrait = buildSimpleKenBurnsVF(4, false);
      expect(portrait).toContain("0.1000000");
      expect(nonPortrait).toContain("0.1500000");
    });
  });
});
