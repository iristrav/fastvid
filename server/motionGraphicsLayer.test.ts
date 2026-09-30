import { describe, expect, it } from "vitest";
import {
  buildWhiteTypewriterDrawtextFilterChain,
  extractMotionOverlayCandidates,
  mergeMotionGraphicsIntoMetadata,
  MG_OVERLAY_FONT_SIZE,
  MG_OVERLAY_MAX_WORDS,
  overlayFontDrawtextSuffix,
  parseMotionGraphicsScenesFromMetadata,
  STANDARD_CROSSFADE_MS,
  STANDARD_IMAGE_ANIMATION,
  STANDARD_TRANSITION,
  standardMontageCrossfadeSec,
  standardMontageTransitionName,
} from "./motionGraphicsLayer";

describe("motionGraphicsLayer", () => {
  it("detects years, percentages, euro amounts, and keywords", () => {
    const text = "In 2025 gebruikt al 78% van de bedrijven AI voor €10.000 investeringen.";
    const candidates = extractMotionOverlayCandidates(text, {
      powerWord: "innovatie",
      highlightWords: ["bedrijven"],
    });
    const texts = candidates.map((c) => c.text);
    expect(texts).toContain("2025");
    expect(texts).toContain("78%");
    expect(texts.some((t) => t.includes("€"))).toBe(true);
  });

  it("normalizes procent to percentage display", () => {
    const candidates = extractMotionOverlayCandidates(
      "In 2025 groeide de omzet met 43 procent."
    );
    expect(candidates.some((c) => c.text === "43%")).toBe(true);
  });

  it("detects countries, people, and events", () => {
    /**
     * VIDEO 623 — a person's label comes from the one name reader every person goes through, which
     * reads a full name; a table of fifteen surnames (Hitler, Stalin, … Musk) gave those alone a
     * label from one word. So the sentence names the person the way any other name is named.
     */
    const candidates = extractMotionOverlayCandidates(
      "In 1940 begon de invasie in Duitsland door Adolf Hitler."
    );
    const texts = candidates.map((c) => c.text);
    expect(texts).toContain("1940");
    expect(texts.some((t) => t.includes("DUITS") || t.includes("GERMAN"))).toBe(true);
    expect(texts).toContain("HITLER");
    expect(texts).toContain("INVASIE");
  });

  it("limits each overlay to at most three words", () => {
    const candidates = extractMotionOverlayCandidates(
      "Revenue grew to 10 million people worldwide in 2025.",
      { powerWord: "innovation pipeline growth", highlightWords: ["worldwide expansion now"] }
    );
    for (const c of candidates) {
      expect(c.text.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(MG_OVERLAY_MAX_WORDS);
    }
  });

  it("uses fixed crossfade duration in standard range", () => {
    expect(standardMontageCrossfadeSec()).toBeCloseTo(STANDARD_CROSSFADE_MS / 1000, 3);
    expect(standardMontageTransitionName()).toBe("dissolve");
  });

  it("builds centered V3 typewriter drawtext chain without box or shadow", () => {
    const chain = buildWhiteTypewriterDrawtextFilterChain("vmont", "vout", [
      {
        text: "2025",
        animation: "typewriter",
        position: "center",
        trigger_word: "2025",
        kind: "year",
        start_time: 1.2,
        end_time: 4.5,
      },
    ]);
    expect(chain).toContain("fontcolor=white");
    expect(chain).toContain(`fontsize=${MG_OVERLAY_FONT_SIZE}`);
    expect(chain).toContain("(w-text_w)/2");
    expect(chain).toContain("(h-text_h)/2");
    expect(chain).toContain("alpha=");
    expect(chain).not.toContain("shadowcolor");
    expect(chain).not.toContain("drawbox");
    expect(chain).not.toContain("0xFFCC00");
    if (overlayFontDrawtextSuffix()) {
      expect(chain).toContain("fontfile=");
    }
  });
});
