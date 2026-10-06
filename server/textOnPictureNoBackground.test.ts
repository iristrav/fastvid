/**
 * OCTOBER 2026 — TEXT OVER THE PICTURE WITHOUT A BOX, AND THE CARD'S GROUND STAYS INVISIBLE.
 *
 *   1  subtitles have no plate by default — white type, a dark outline and a shadow instead
 *   2  the lower third has no band — its name, its halo and its thin gold rule stay
 *   3  unchanged: the neighbouring shot under a sentence's card is drawn at opacity 0, on
 *      PRIMARY_GROUND (an unjudged neighbour is never visible)
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

import { placePrimaryGraphics } from "./edlToTimeline";
import { DEFAULT_CAPTION_STYLE, type TimelineGraphic, type TimelineVideoClip } from "./projectTimeline";

const GRAPHICS_TSX = fs.readFileSync(path.join(__dirname, "remotion", "components", "Graphics.tsx"), "utf8");

describe("text over the picture without a box", () => {
  it("1 — subtitles: no plate, white type, a dark outline and the shadow", () => {
    expect(DEFAULT_CAPTION_STYLE.backgroundOpacity).toBe(0);
    expect(DEFAULT_CAPTION_STYLE.color).toBe("white");
    expect(DEFAULT_CAPTION_STYLE.outlineWidthPx).toBeGreaterThan(0);
    expect(DEFAULT_CAPTION_STYLE.outlineColor).toMatch(/^rgba\(0,0,0,/);
    expect(DEFAULT_CAPTION_STYLE.shadow).not.toBe(false);
  });

  it("2 — the lower third: no band behind the name; the gold rule and the halo stay", () => {
    const lowerThird = GRAPHICS_TSX.slice(GRAPHICS_TSX.indexOf("const LowerThird"), GRAPHICS_TSX.indexOf("const DateCard"));
    expect(lowerThird).not.toMatch(/background:/);
    expect(lowerThird).toContain("borderLeft: `3px solid ${ACCENT}`");
    expect(lowerThird).toContain("textShadow: HALO");
  });

  it("3 — unchanged: the shot under a sentence's card stays invisible, the card keeps PRIMARY_GROUND", () => {
    const shot = {
      id: "shot",
      source: { provider: "youtube", archiveAssetId: 60140 },
      timelineStart: 0,
      timelineEnd: 4,
      sourceIn: 0,
      sourceOut: 4,
    } as TimelineVideoClip;
    const clips: TimelineVideoClip[] = [shot];
    const graphics: TimelineGraphic[] = [];
    const placed = placePrimaryGraphics(clips, graphics, [
      { beatId: "s0b1", startSec: 4, endSec: 8, graphic: { graphicType: "chapter_card", data: { text: "The Wall falls" }, reason: "CHAPTER_CARD_FALLBACK" } },
    ]);
    expect(placed).toHaveLength(1);
    expect(placed[0]!.backdrop.transform?.opacity).toBe(0);
    expect(GRAPHICS_TSX).toContain("export const PRIMARY_GROUND");
    expect(GRAPHICS_TSX).toContain("background: PRIMARY_GROUND");
  });
});
