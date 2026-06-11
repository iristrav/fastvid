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

  it("plans text card for hook beats with questions", () => {
    const plan = planMotionGraphicBeat(
      "Why is this city considered the best designed in America?",
      0,
      0,
      "The Best Designed City"
    );
    expect(plan?.kind).toBe("text_card");
    expect(plan?.lines.length).toBeGreaterThan(0);
  });

  it("plans map card when geo keywords appear", () => {
    const plan = planMotionGraphicBeat(
      "The city grid stretches north with blocks aligned to the rail route through downtown.",
      1,
      1,
      "Chicago Urban Plan"
    );
    expect(plan?.kind).toBe("map_card");
    expect(plan?.mapTitle).toBeTruthy();
  });

  it("plans news card when reporting language appears", () => {
    const plan = planMotionGraphicBeat(
      "According to The Guardian, Singapore hanged more people this year than it has in decades. Three were marched to the gallows in November.",
      1,
      1,
      "Singapore Crime Policy"
    );
    expect(plan?.kind).toBe("news_card");
    expect(plan?.source).toContain("Guardian");
    expect(plan?.headline).toBeTruthy();
    expect(motionGraphicNeedsSourceImage("news_card")).toBe(true);
  });

  it("plans portrait cutout for leader beats", () => {
    const plan = planMotionGraphicBeat(
      "Lee Kuan Yew said the city had to stay tough on crime to survive.",
      2,
      2,
      "Lee Kuan Yew vs America"
    );
    expect(plan?.kind).toBe("portrait_cutout");
    expect(motionGraphicNeedsSourceImage("portrait_cutout")).toBe(true);
  });

  it("extractNewsCardContent builds headline and source", () => {
    const news = extractNewsCardContent(
      "The Guardian reported gum control kept chewing gum off Singapore streets. Officials defended the policy."
    );
    expect(news.source).toBe("The Guardian");
    expect(news.headline.length).toBeGreaterThan(10);
    expect(news.bodyLines.length).toBeGreaterThan(0);
  });

  it("extractNewsSource normalizes SMH", () => {
    expect(extractNewsSource("SMH wrote about the incident")).toBe("SMH.com.au");
  });

  it("extractMapTitle prefers known cities", () => {
    expect(extractMapTitle("Plans for Amsterdam expanded the district", "Urban Europe")).toBe(
      "AMSTERDAM"
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
      "Reuters reported the policy shocked America. Critics called it harsh.",
      1,
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
    const plan = extractNewsCardContent("BBC News headline about the trial today.");
    const vf = buildNewsCardVideoVF({
      kind: "news_card",
      lines: [plan.headline],
      ...plan,
    });
    expect(vf).toContain("gblur=sigma=28");
    expect(vf).toContain("drawbox=");
  });
});
