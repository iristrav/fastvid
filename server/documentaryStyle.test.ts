import { describe, expect, it } from "vitest";
import {
  buildBlurFillStillVF,
  buildPolaroidStillVF,
  buildPostGradeVF,
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

  it("builds polaroid filter", () => {
    const vf = buildPolaroidStillVF(3.5);
    expect(vf).toContain("pad=960:1040");
    expect(vf).toContain("select='eq(n\\,0)'");
    expect(vf).toContain("[vout]");
  });

  it("resolves portrait vs landscape still composition", () => {
    const blur = resolveStillCompositionVF(4, 1, 0, false);
    expect(blur).toContain("gblur");
    const polaroid = resolveStillCompositionVF(4, 0, 0, false);
    expect(polaroid).toContain("pad=960:1040");
  });

  it("builds post grade chain", () => {
    const vf = buildPostGradeVF();
    expect(vf).toContain("vignette=");
    expect(vf).toContain("eq=contrast");
  });
});
