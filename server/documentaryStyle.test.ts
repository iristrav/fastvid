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
  buildDocumentaryColorGradeVF,
  buildDocumentaryVignetteVF,
  buildFilmGrainVF,
  classifyDocGradeSourceKind,
  isAIGeneratedClip,
  isStockVideoClip,
  documentaryStyleEnabled,
  resolveStillCompositionVF,
  usePolaroidLayout,
} from "./documentaryStyle";

describe("documentaryStyle", () => {
  it("is off by default (opt-in via ENABLE_DOC_STYLE=true)", () => {
    // Phase 11: this test previously asserted the opposite of documentaryStyleEnabled()'s own
    // doc comment ("Off by default; set ENABLE_DOC_STYLE=true to enable") and of its actual
    // implementation (`=== "true"`) since the day both were added — never caught because no
    // caller relies on the default silently changing. The implementation is the real, deployed
    // behavior; the test was wrong, not the code, so the test is corrected to match it rather
    // than flipping a live production default as a side effect of a test fix.
    const prev = process.env.ENABLE_DOC_STYLE;
    delete process.env.ENABLE_DOC_STYLE;
    expect(documentaryStyleEnabled()).toBe(false);
    process.env.ENABLE_DOC_STYLE = "true";
    expect(documentaryStyleEnabled()).toBe(true);
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
    // buildPerClipDocumentaryGradeVF is unconditional; buildMontageBranchNormVF/
    // buildFitGrayGradedVideoVF/buildFinalSceneGradeVF gate on documentaryStyleEnabled(),
    // which is off by default (see "is off by default" above) — exercise the graded branch
    // explicitly here rather than relying on ambient env state.
    expect(buildPerClipDocumentaryGradeVF()).toContain("eq=contrast");
    expect(buildPerClipDocumentaryGradeVF()).toContain("vignette=");
    const prev = process.env.ENABLE_DOC_STYLE;
    process.env.ENABLE_DOC_STYLE = "true";
    expect(buildMontageBranchNormVF()).toContain("color=0x2a2a2a");
    expect(buildMontageBranchNormVF()).toContain("eq=contrast");
    expect(buildFitGrayGradedVideoVF()).toContain("eq=contrast");
    expect(buildFinalSceneGradeVF()).toMatch(/noise=|copy/);
    if (prev === undefined) delete process.env.ENABLE_DOC_STYLE;
    else process.env.ENABLE_DOC_STYLE = prev;
  });

  describe("Ken Burns easing (Phase 10)", () => {
    it("buildKenBurnsTail uses an eased sine progress curve, not a linear zoom+step increment", () => {
      const vf = buildKenBurnsTail(4, 1.1, "center", "zoom-in");
      expect(vf).toContain("sin(PI/2*min(on/");
      expect(vf).not.toContain("min(zoom+");
      expect(vf).not.toContain("max(zoom-");
    });

    /**
     * SUPERSEDED BY RONDE 111, in the curve's TAIL only.
     *
     * Phase 10's pure sin(PI/2*t) reaches its target with zero velocity — its derivative at t=1 is
     * cos(PI/2) = 0 — so every photo ended on a picture that had stopped moving. Measured on a
     * six-second still: 2.87 px/frame in the first second, 0.30 px/frame in the last. RONDE 111
     * blends 35% of that curve with 65% linear, which keeps a visible ease-out (1.20x average
     * velocity at the start, 0.65x at the end) without ever reaching zero.
     *
     * Start point, end point and total travel are all unchanged, which is what these assert.
     */
    it("zoom-in starts at 1.0 and eases toward zoomEnd", () => {
      const vf = buildKenBurnsTail(4, 1.2, "center", "zoom-in");
      expect(vf).toContain("z='(1.0000+(0.2000000)*(0.35*sin(PI/2*min(on/");
    });

    it("zoom-out starts at zoomEnd and eases toward 1.0 (negative delta)", () => {
      const vf = buildKenBurnsTail(4, 1.2, "center", "zoom-out");
      expect(vf).toContain("z='(1.2000+(-0.2000000)*(0.35*sin(PI/2*min(on/");
    });

    it("RONDE 111 — the progress term still runs exactly 0 → 1, so nothing is reframed", () => {
      const share = 0.35;
      const progress = (t: number) => share * Math.sin((Math.PI / 2) * t) + (1 - share) * t;
      expect(progress(0)).toBeCloseTo(0, 10);
      expect(progress(1)).toBeCloseTo(1, 10);
      // ...and it never stops, which is the whole point of the change.
      const velocity = (t: number) =>
        share * (Math.PI / 2) * Math.cos((Math.PI / 2) * t) + (1 - share);
      expect(velocity(1)).toBeGreaterThan(0.6);
      expect(velocity(0)).toBeGreaterThan(velocity(1));
    });

    it("pan-left/pan-right ease the same total pixel distance a linear pan would have covered", () => {
      const totalFrames = 100; // 4s @ 25fps
      const panStep = Math.max(1, Math.round(totalFrames * 0.06));
      const expectedDistance = panStep * totalFrames;
      const left = buildKenBurnsTail(4, 1.02, "center", "pan-left");
      const right = buildKenBurnsTail(4, 1.02, "center", "pan-right");
      // RONDE 111: same total distance, same direction — only the velocity curve's tail moved.
      expect(left).toContain(`-${expectedDistance}*(0.35*sin(PI/2*min(on/`);
      expect(right).toContain(`+${expectedDistance}*(0.35*sin(PI/2*min(on/`);
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

  describe("source-aware grading (Phase 10)", () => {
    it("classifies AI-generated, stock, and archive clips from their filename", () => {
      expect(classifyDocGradeSourceKind("/tmp/scene_1_b2_stability_abc.mp4")).toBe("ai_generated");
      expect(isAIGeneratedClip("/tmp/scene_1_b2_stability_abc.mp4")).toBe(true);
      expect(classifyDocGradeSourceKind("/tmp/scene_1_b2_pexels_abc.mp4")).toBe("stock");
      expect(isStockVideoClip("/tmp/scene_1_b2_pexels_abc.mp4")).toBe(true);
      // "_archive_" (e.g. Internet Archive footage) is itself classified as stock by
      // isStockVideoClip's existing pattern; a filename matching neither pattern (e.g. a
      // Wikimedia/own-archive clip) falls through to the "archive" default.
      expect(classifyDocGradeSourceKind("/tmp/scene_1_b2_archive_abc.mp4")).toBe("stock");
      expect(classifyDocGradeSourceKind("/tmp/scene_1_b2_wikimedia_abc.mp4")).toBe("archive");
    });

    it("pulls saturation/contrast harder for AI-generated and stock than real archive footage", () => {
      const archive = buildDocumentaryColorGradeVF("archive");
      const aiGenerated = buildDocumentaryColorGradeVF("ai_generated");
      const stock = buildDocumentaryColorGradeVF("stock");
      const uncategorized = buildDocumentaryColorGradeVF();
      expect(archive).toContain("saturation=0.88");
      expect(uncategorized).toBe(archive);
      expect(aiGenerated).toContain("saturation=0.78");
      expect(stock).toContain("saturation=0.82");
      expect(aiGenerated).not.toBe(archive);
      expect(stock).not.toBe(archive);
    });

    it("applies a stronger vignette to AI-generated/stock sources than real archive footage", () => {
      expect(buildDocumentaryVignetteVF("archive")).toContain("angle=0.62");
      expect(buildDocumentaryVignetteVF()).toContain("angle=0.62");
      expect(buildDocumentaryVignetteVF("ai_generated")).toContain("angle=0.55");
      expect(buildDocumentaryVignetteVF("stock")).toContain("angle=0.55");
    });

    it("adds more grain to clean digital sources than to already-grainy archive footage", () => {
      const prev = process.env.ENABLE_FILM_GRAIN;
      delete process.env.ENABLE_FILM_GRAIN;
      expect(buildFilmGrainVF("archive")).toBe(",noise=alls=6:allf=t+u");
      expect(buildFilmGrainVF()).toBe(",noise=alls=6:allf=t+u");
      expect(buildFilmGrainVF("ai_generated")).toBe(",noise=alls=9:allf=t+u");
      expect(buildFilmGrainVF("stock")).toBe(",noise=alls=9:allf=t+u");
      if (prev === undefined) delete process.env.ENABLE_FILM_GRAIN;
      else process.env.ENABLE_FILM_GRAIN = prev;
    });

    it("montage branch grade is not identical for an AI-generated clip vs. an archive clip", () => {
      const prev = process.env.ENABLE_DOC_STYLE;
      process.env.ENABLE_DOC_STYLE = "true";
      const archiveGrade = buildMontageBranchNormVF("archive");
      const aiGrade = buildMontageBranchNormVF("ai_generated");
      expect(archiveGrade).not.toBe(aiGrade);
      if (prev === undefined) delete process.env.ENABLE_DOC_STYLE;
      else process.env.ENABLE_DOC_STYLE = prev;
    });
  });
});
