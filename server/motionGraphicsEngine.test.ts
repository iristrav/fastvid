import { describe, expect, it } from "vitest";
import {
  buildMapCardVF,
  buildNewsCardStillVF,
  buildNewsCardVideoVF,
  buildPortraitCutoutStillVF,
  buildTextCardVF,
  extractMapTitle,
  extractNewsCardContent,
  extractNewsSource,
  motionGraphicNeedsSourceImage,
  motionGraphicSlotKind,
  planMotionGraphicBeat,
  wrapTextCardLines,
} from "./motionGraphicsEngine";

describe("motionGraphicsEngine", () => {
  it("wraps long narration into card lines", () => {
    const lines = wrapTextCardLines(
      "One city managed to get so many things right in urban planning and transit design"
    );
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(4);
    expect(lines.every((l) => l.length <= 38)).toBe(true);
  });

  it("assigns a rotating style to every beat slot", () => {
    expect(motionGraphicSlotKind(0, 0)).toBe("text_card");
    expect(motionGraphicSlotKind(0, 1)).toBe("news_card");
    expect(motionGraphicSlotKind(0, 2)).toBe("portrait_cutout");
    expect(motionGraphicSlotKind(0, 3)).toBe("map_card");
    expect(motionGraphicSlotKind(0, 4)).toBe("news_card");
    expect(motionGraphicSlotKind(2, 7)).toBeTruthy();
  });

  it("plans text card for opening beat on any topic", () => {
    const plan = planMotionGraphicBeat(
      "Why did Tesla become the most valuable car company in the world?",
      0,
      0,
      "Elon Musk and Tesla"
    );
    expect(plan?.kind).toBe("text_card");
    expect(plan?.lines.length).toBeGreaterThan(0);
  });

  it("plans map card from video title without geo keywords", () => {
    const plan = planMotionGraphicBeat(
      "He built rockets and electric cars while critics laughed at the idea.",
      0,
      3,
      "Elon Musk: Tesla and SpaceX"
    );
    expect(plan?.kind).toBe("map_card");
    expect(plan?.mapTitle).toContain("ELON MUSK");
  });

  it("plans news card on rhythm slot without news keywords", () => {
    const plan = planMotionGraphicBeat(
      "Tesla stock surged after the company posted record deliveries in the quarter.",
      0,
      1,
      "Elon Musk Documentary"
    );
    expect(plan?.kind).toBe("news_card");
    expect(plan?.source).toBe("Elon Musk Documentary");
    expect(plan?.headline).toBeTruthy();
    expect(motionGraphicNeedsSourceImage("news_card")).toBe(true);
  });

  it("plans portrait cutout on rhythm slot for any subject", () => {
    const plan = planMotionGraphicBeat(
      "Hitler rose to power in a fractured Germany after the First World War ended.",
      0,
      2,
      "The Rise of Hitler"
    );
    expect(plan?.kind).toBe("portrait_cutout");
    expect(motionGraphicNeedsSourceImage("portrait_cutout")).toBe(true);
  });

  it("plans every beat with enough narration text", () => {
    const text = "The factory expanded production across three continents in one decade.";
    for (let beatIndex = 0; beatIndex < 5; beatIndex++) {
      expect(planMotionGraphicBeat(text, 1, beatIndex, "Industrial Growth")?.kind).toBeTruthy();
    }
  });

  it("extractNewsCardContent uses explicit outlet when present", () => {
    const news = extractNewsCardContent(
      "The Guardian reported gum control kept chewing gum off Singapore streets. Officials defended the policy."
    );
    expect(news.source).toBe("The Guardian");
    expect(news.headline.length).toBeGreaterThan(10);
    expect(news.bodyLines.length).toBeGreaterThan(0);
  });

  it("extractNewsSource falls back to video title", () => {
    expect(extractNewsSource("Tesla posted record numbers this quarter.", "SpaceX Starship")).toBe(
      "SpaceX Starship"
    );
  });

  it("extractNewsSource normalizes SMH", () => {
    expect(extractNewsSource("SMH wrote about the incident")).toBe("SMH.com.au");
  });

  it("extractMapTitle prefers cities but accepts any title", () => {
    expect(extractMapTitle("Plans for Amsterdam expanded the district", "Urban Europe")).toBe(
      "AMSTERDAM"
    );
    expect(extractMapTitle("Nothing geographic here.", "Why Britain Struggles")).toBe(
      "WHY BRITAIN STRUGGLES"
    );
  });

  it("buildTextCardVF centers yellow uppercase text", () => {
    const vf = buildTextCardVF(["ONE CITY", "MANY THINGS RIGHT"]);
    expect(vf).toContain("drawtext=");
    expect(vf).toContain("0xFFD200");
    expect(vf).toContain("(w-text_w)/2");
  });

  it("buildMapCardVF draws mat card with grid", () => {
    const vf = buildMapCardVF("CHICAGO", ["Urban grid", "Rail corridor"]);
    expect(vf).toContain("drawgrid=");
    expect(vf).toContain("0xE8E4DC");
    expect(vf).toContain("CHICAGO");
  });

  it("buildNewsCardStillVF blurs bg and draws white card", () => {
    const plan = planMotionGraphicBeat(
      "The policy shocked America. Critics called it harsh and unfair to ordinary citizens.",
      0,
      1,
      "Singapore"
    )!;
    const vf = buildNewsCardStillVF(4, plan);
    expect(vf).toContain("gblur=sigma=34");
    expect(vf).toContain("color=white@0.97");
    expect(vf).toContain("0x1D4ED8");
    expect(vf).toContain("[thumb]overlay=");
    expect(vf).toContain("[vout]");
  });

  it("buildPortraitCutoutStillVF adds glow layer", () => {
    const vf = buildPortraitCutoutStillVF(4);
    expect(vf).toContain("gblur=sigma=30");
    expect(vf).toContain("0xD6EBFF");
    expect(vf).toContain("[vout]");
  });

  it("buildNewsCardVideoVF overlays card on blurred video", () => {
    const plan = extractNewsCardContent("Headline about the trial today.", "Crime Documentary");
    const vf = buildNewsCardVideoVF({
      kind: "news_card",
      lines: [plan.headline],
      ...plan,
    });
    expect(vf).toContain("gblur=sigma=28");
    expect(vf).toContain("drawbox=");
  });
});
