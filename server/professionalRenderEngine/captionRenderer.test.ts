import { describe, expect, it } from "vitest";
import { renderCaption } from "./captionRenderer";
import type { CaptionInstruction, CaptionPosition, CaptionType } from "./types";

function instruction(overrides: Partial<CaptionInstruction> = {}): CaptionInstruction {
  return {
    captionType: "title",
    text: "The Cold War",
    startSec: 2,
    endSec: 6,
    animation: "fade",
    position: "center",
    reason: "test",
    ...overrides,
  };
}

describe("Caption Renderer (Phase 7)", () => {
  it("renders a single drawtext fragment for a non-boxed caption type with no subtitle", () => {
    const frags = renderCaption(instruction());
    expect(frags).toHaveLength(1);
    expect(frags[0]!.filter).toContain("drawtext=text='The Cold War'");
    expect(frags[0]!.filter).toContain("fontsize=88");
    expect(frags[0]!.reason).toBe("test");
  });

  it("boxed caption types (lower_third/name/callout/timeline_label) emit a drawbox before the drawtext", () => {
    const boxedTypes: CaptionType[] = ["lower_third", "name", "callout", "timeline_label"];
    for (const captionType of boxedTypes) {
      const frags = renderCaption(instruction({ captionType }));
      expect(frags[0]!.filter).toContain("drawbox=");
      expect(frags[1]!.filter).toContain("drawtext=");
    }
  });

  it("non-boxed caption types never emit a drawbox", () => {
    const nonBoxed: CaptionType[] = ["title", "subtitle", "date", "location", "statistic", "quote", "animated_text", "chapter_title"];
    for (const captionType of nonBoxed) {
      const frags = renderCaption(instruction({ captionType }));
      expect(frags.every((f) => !f.filter.startsWith("drawbox="))).toBe(true);
    }
  });

  it("escapes special drawtext characters in the text", () => {
    const frags = renderCaption(instruction({ text: "It's 3:00, right?" }));
    expect(frags[0]!.filter).toContain("text='It\\'s 3\\:00, right?'");
  });

  it("appends a second drawtext fragment when a subtitle is present", () => {
    const frags = renderCaption(instruction({ subtitle: "1962" }));
    expect(frags).toHaveLength(2);
    expect(frags[1]!.filter).toContain("drawtext=text='1962'");
  });

  it("positions each CaptionPosition using the expected FFmpeg coordinate expression", () => {
    const cases: Record<CaptionPosition, { x: string; y: string }> = {
      center: { x: "(w-text_w)/2", y: "(h-text_h)/2" },
      top: { x: "(w-text_w)/2", y: "h*0.08" },
      bottom: { x: "(w-text_w)/2", y: "h-text_h-h*0.08" },
      "bottom-left": { x: "48", y: "h-text_h-52" },
      "bottom-right": { x: "w-text_w-48", y: "h-text_h-52" },
      "lower-third": { x: "48", y: "h*0.78" },
    };
    for (const [position, expected] of Object.entries(cases) as [CaptionPosition, { x: string; y: string }][]) {
      const [frag] = renderCaption(instruction({ position, animation: "none" }));
      expect(frag!.filter).toContain(`x=${expected.x}:y=${expected.y}:`);
    }
  });

  it("animation=none uses a hard between() cut, not a fade", () => {
    const [frag] = renderCaption(instruction({ animation: "none", startSec: 2, endSec: 6 }));
    expect(frag!.filter).toContain("alpha='between(t,2.000,6.000)'");
  });

  it("animation=fade uses the alpha fade-in/fade-out expression", () => {
    const [frag] = renderCaption(instruction({ animation: "fade" }));
    expect(frag!.filter).toContain("if(gt(t,6.000),0,if(gt(t,5.550),");
  });

  it("animation=slide offsets y with an easing term that shrinks to 0", () => {
    const [frag] = renderCaption(instruction({ animation: "slide", position: "bottom-left" }));
    expect(frag!.filter).toContain("y=h-text_h-52+40*(1-sin(PI/2*min(max((t-2.000)/0.450,0),1)))");
  });

  it("animation=scale drives fontsize with an easing expression instead of a fixed number", () => {
    const [frag] = renderCaption(instruction({ animation: "scale", captionType: "title" }));
    expect(frag!.filter).toContain("fontsize=round(88*sin(PI/2*min(max((t-2.000)/0.450,0),1)))");
  });

  it("animation=typewriter falls back to the same fade expression as animation=fade", () => {
    const typewriter = renderCaption(instruction({ animation: "typewriter" }))[0]!.filter;
    const fade = renderCaption(instruction({ animation: "fade" }))[0]!.filter;
    const stripAlpha = (f: string) => f.match(/alpha='([^']*)'/)?.[1];
    expect(stripAlpha(typewriter)).toBe(stripAlpha(fade));
  });

  it("animation=blur fades slower than animation=fade (approximation, not a real blur)", () => {
    const blurAlpha = renderCaption(instruction({ animation: "blur", startSec: 0, endSec: 10 }))[0]!.filter;
    const fadeAlpha = renderCaption(instruction({ animation: "fade", startSec: 0, endSec: 10 }))[0]!.filter;
    expect(blurAlpha).not.toBe(fadeAlpha);
    expect(blurAlpha).toContain("0.720"); // BLUR_FADE_DUR = 0.45 * 1.6
  });

  it("statistic and location use the accent color", () => {
    const stat = renderCaption(instruction({ captionType: "statistic" }))[0]!.filter;
    const loc = renderCaption(instruction({ captionType: "location" }))[0]!.filter;
    expect(stat).toContain("fontcolor=0xFFD54F");
    expect(loc).toContain("fontcolor=0xFFD54F");
  });
});
