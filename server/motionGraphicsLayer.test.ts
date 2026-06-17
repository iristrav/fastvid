import { describe, expect, it } from "vitest";
import {
  buildWhiteTypewriterDrawtextFilterChain,
  extractMotionOverlayCandidates,
  mergeMotionGraphicsIntoMetadata,
  MG_OVERLAY_FONT_SIZE,
  MG_OVERLAY_MAX_WORDS,
  overlayFontDrawtextSuffix,
  parseMotionGraphicsScenesFromMetadata,
  planMotionGraphicsScene,
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
    const candidates = extractMotionOverlayCandidates(
      "In 1940 begon de invasie in Duitsland door Hitler."
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

  it("plans voice-synced scene output structure", () => {
    const plan = planMotionGraphicsScene(
      1,
      12.4,
      4.4,
      [{ text: "In 2025 groeide de omzet met 43 procent.", holdSec: 4.4 }],
      "Office workers at computers"
    );
    expect(plan.scene_id).toBe(1);
    expect(plan.start_time).toBe(12.4);
    expect(plan.end_time).toBeCloseTo(16.8, 1);
    expect(plan.image_animation).toBe(STANDARD_IMAGE_ANIMATION);
    expect(plan.transition).toBe(STANDARD_TRANSITION);
    expect(plan.visual_description).toBe("Office workers at computers");
    expect(plan.overlays.length).toBeGreaterThan(0);
    for (const o of plan.overlays) {
      expect(o.animation).toBe("typewriter");
      expect(o.position).toBe("center");
      expect(o.end_time).toBeGreaterThan(o.start_time);
    }
    const year = plan.overlays.find((o) => o.text === "2025");
    expect(year?.trigger_word).toBe("2025");
    expect(year!.start_time).toBeGreaterThanOrEqual(plan.start_time);
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

  it("round-trips motion graphics metadata", () => {
    const plan = planMotionGraphicsScene(2, 0, 5, [
      { text: "Revenue grew 25% in 2024.", holdSec: 5 },
    ]);
    const merged = mergeMotionGraphicsIntoMetadata({ foo: "bar" }, [plan]);
    const parsed = parseMotionGraphicsScenesFromMetadata(merged);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.scene_id).toBe(2);
    expect(parsed[0]?.overlays.length).toBeGreaterThan(0);
    expect(parsed[0]?.overlays[0]?.position).toBe("center");
  });
});
