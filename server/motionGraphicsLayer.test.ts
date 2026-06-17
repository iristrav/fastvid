import { describe, expect, it } from "vitest";
import {
  buildWhiteTypewriterDrawtextFilterChain,
  extractMotionOverlayCandidates,
  mergeMotionGraphicsIntoMetadata,
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

  it("limits each overlay to at most two words", () => {
    const candidates = extractMotionOverlayCandidates(
      "Revenue grew to 10 million people worldwide in 2025.",
      { powerWord: "innovation pipeline", highlightWords: ["worldwide expansion"] }
    );
    for (const c of candidates) {
      expect(c.text.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(2);
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
      expect(o.position).toBe("bottom_left");
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

  it("builds white typewriter drawtext chain without yellow box", () => {
    const chain = buildWhiteTypewriterDrawtextFilterChain("vmont", "vout", [
      {
        text: "2025",
        animation: "typewriter",
        position: "bottom_left",
        trigger_word: "2025",
        kind: "year",
        start_time: 1.2,
        end_time: 4.5,
      },
    ]);
    expect(chain).toContain("fontcolor=white");
    expect(chain).toContain(`fontsize=${68}`);
    expect(chain).toContain("shadowcolor=black");
    expect(chain).not.toContain("drawbox");
    expect(chain).not.toContain("0xFFCC00");
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
  });
});
