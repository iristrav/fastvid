import { afterEach, describe, expect, it } from "vitest";
import { renderEffect } from "./effectsRenderer";
import type { EffectInstruction, VisualEffectType } from "./types";

function instruction(effectType: VisualEffectType, intensity = 0.5): EffectInstruction {
  return { effectType, intensity, reason: `test-${effectType}` };
}

const ORIGINAL_ENABLE_FILM_GRAIN = process.env.ENABLE_FILM_GRAIN;

afterEach(() => {
  if (ORIGINAL_ENABLE_FILM_GRAIN === undefined) delete process.env.ENABLE_FILM_GRAIN;
  else process.env.ENABLE_FILM_GRAIN = ORIGINAL_ENABLE_FILM_GRAIN;
});

describe("Effects Renderer (Phase 7)", () => {
  it("film_grain reuses buildFilmGrainVF with its leading comma stripped", () => {
    delete process.env.ENABLE_FILM_GRAIN;
    const [frag] = renderEffect(instruction("film_grain"));
    expect(frag!.filter).toBe("noise=alls=6:allf=t+u");
    expect(frag!.filter.startsWith(",")).toBe(false);
  });

  it("film_grain returns no fragment when ENABLE_FILM_GRAIN=false, deferring to the legacy toggle", () => {
    process.env.ENABLE_FILM_GRAIN = "false";
    expect(renderEffect(instruction("film_grain"))).toEqual([]);
  });

  it("vignette reuses buildDocumentaryVignetteVF verbatim", () => {
    const [frag] = renderEffect(instruction("vignette"));
    expect(frag!.filter).toBe("vignette=angle=0.62:mode=forward");
  });

  it("glow and bloom both use gblur, with bloom stronger than glow at equal intensity", () => {
    const glow = renderEffect(instruction("glow", 0.5))[0]!.filter;
    const bloom = renderEffect(instruction("bloom", 0.5))[0]!.filter;
    expect(glow).toBe("gblur=sigma=4.00");
    expect(bloom).toBe("gblur=sigma=8.00");
  });

  it("chromatic_aberration uses the native rgbashift filter with opposite R/B shifts", () => {
    const frag = renderEffect(instruction("chromatic_aberration", 0.5))[0]!.filter;
    expect(frag).toBe("rgbashift=rh=5:bh=-5");
  });

  it("lens_flare produces a warm brightness/color-balance pulse", () => {
    const frag = renderEffect(instruction("lens_flare", 0.5))[0]!.filter;
    expect(frag).toContain("eq=brightness=0.050:saturation=1.050");
    expect(frag).toContain("colorbalance=rs=0.075:gs=0.030");
  });

  it("noise uses a lighter alls value than particles/dust at equal intensity", () => {
    const noise = renderEffect(instruction("noise", 0.5))[0]!.filter;
    const particles = renderEffect(instruction("particles", 0.5))[0]!.filter;
    const dust = renderEffect(instruction("dust", 0.5))[0]!.filter;
    expect(noise).toBe("noise=alls=9:allf=t+u");
    expect(particles).toBe("noise=alls=20:allf=t+u");
    expect(dust).toBe(particles);
  });

  it("letterbox draws top and bottom black bars scaled by intensity", () => {
    const frag = renderEffect(instruction("letterbox", 0.5))[0]!.filter;
    expect(frag).toBe(
      "drawbox=x=0:y=0:w=iw:h=ih*0.0900:color=black:t=fill," +
        "drawbox=x=0:y=ih*(1-0.0900):w=iw:h=ih*0.0900:color=black:t=fill"
    );
  });

  it("intensity is clamped to [0,1] for effects that scale with it", () => {
    const overMax = renderEffect(instruction("glow", 5))[0]!.filter;
    const atMax = renderEffect(instruction("glow", 1))[0]!.filter;
    expect(overMax).toBe(atMax);

    const belowMin = renderEffect(instruction("glow", -5))[0]!.filter;
    const atMin = renderEffect(instruction("glow", 0))[0]!.filter;
    expect(belowMin).toBe(atMin);
  });

  it("carries the instruction's reason through unchanged", () => {
    const [frag] = renderEffect(instruction("bloom", 0.3));
    expect(frag!.reason).toBe("test-bloom");
  });
});
