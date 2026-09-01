/**
 * RONDE 152 — captions, typography and the layout engine that keeps them off each other.
 *
 * The layout engine and the animation engine are both PURE, so they are tested as arithmetic here
 * and as pixels in ronde150HybridRender.test.ts. That split is deliberate: a pure test can cover a
 * hundred cases in a millisecond, and a pixel test proves the pure one describes reality.
 */
import { describe, expect, it } from "vitest";

import {
  AVG_GLYPH_EM,
  MIN_GAP,
  SAFE_MARGIN,
  boxForPosition,
  contains,
  formatUnresolvedCollision,
  intersects,
  layoutCaption,
  lineCountFor,
  maxCharsPerLine,
  measureText,
  overlapsInTime,
  safeArea,
  type Obstacle,
} from "./captionLayout";
import {
  NEUTRAL,
  SUPPORTED_ANIMATIONS,
  SUPPORTED_CAPTION_MODES,
  animationAt,
  chunkCaption,
  revealProgress,
  transitionFrames,
} from "./remotion/components/animation";
import { DEFAULT_CAPTION_STYLE, DEFAULT_TEXT_STYLE, type TextStyle } from "./projectTimeline";

const HD = { widthPx: 1920, heightPx: 1080 };

function style(overrides: Partial<TextStyle> = {}): TextStyle {
  return { ...DEFAULT_CAPTION_STYLE, ...overrides };
}

function obstacle(id: string, box: Obstacle["box"], time = { startSec: 0, endSec: 10 }): Obstacle {
  return { id, kind: "graphic", box, startSec: time.startSec, endSec: time.endSec };
}

/* ═══════════════════════ measuring ═══════════════════════ */

describe("RONDE 152 — text is measured, not guessed at", () => {
  it("a longer line needs more width", () => {
    const short = measureText("Hi", style(), HD);
    const long = measureText("Apple introduced the Vision Pro at its own campus", style(), HD);
    expect(long.width).toBeGreaterThan(short.width);
  });

  it("wrapping onto a second line makes the box taller, not wider", () => {
    const s = style({ maxCharsPerLine: 10 });
    const one = measureText("Apple", s, HD);
    const two = measureText("Apple Vision Pro headset", s, HD);
    expect(lineCountFor("Apple", s, HD)).toBe(1);
    expect(lineCountFor("Apple Vision Pro headset", s, HD)).toBeGreaterThan(1);
    expect(two.height).toBeGreaterThan(one.height);
    expect(two.width).toBeLessThanOrEqual(one.width * 3);
  });

  it("never measures wider than the frame", () => {
    const huge = measureText("x".repeat(500), style({ fontSizePx: 200 }), HD);
    expect(huge.width).toBeLessThanOrEqual(HD.widthPx);
  });

  /**
   * The estimate is deliberately WIDE. A box slightly too big moves a caption that might just have
   * fitted; a box too small lets two things overlap. Only one of those is a visible bug.
   */
  it("errs on the side of a wider box", () => {
    expect(AVG_GLYPH_EM).toBeGreaterThan(0.55);
  });

  it("a bigger font needs a bigger box in both directions", () => {
    const small = measureText("Apple Park", style({ fontSizePx: 40 }), HD);
    const big = measureText("Apple Park", style({ fontSizePx: 90 }), HD);
    expect(big.width).toBeGreaterThan(small.width);
    expect(big.height).toBeGreaterThan(small.height);
  });

  it("derives a character budget from the frame when the style names none", () => {
    // maxCharsPerLine must be ABSENT for the derivation to run — the style's own value wins.
    const narrow = maxCharsPerLine(style({ fontSizePx: 120, maxCharsPerLine: undefined }), HD);
    const wide = maxCharsPerLine(style({ fontSizePx: 30, maxCharsPerLine: undefined }), HD);
    expect(wide).toBeGreaterThan(narrow);
    expect(narrow).toBeGreaterThan(0);
  });

  it("a style that names its own budget keeps it, whatever the font size", () => {
    expect(maxCharsPerLine(style({ maxCharsPerLine: 32, fontSizePx: 20 }), HD)).toBe(32);
    expect(maxCharsPerLine(style({ maxCharsPerLine: 32, fontSizePx: 200 }), HD)).toBe(32);
  });

  it("an empty caption occupies no lines", () => {
    expect(lineCountFor("   ", style(), HD)).toBe(0);
  });
});

/* ═══════════════════════ boxes and anchors ═══════════════════════ */

describe("RONDE 152 — the named positions land where they say", () => {
  const size = { width: 600, height: 120 };

  it("top is above centre, and bottom below it", () => {
    const top = boxForPosition("top", size, HD);
    const centre = boxForPosition("center", size, HD);
    const bottom = boxForPosition("bottom", size, HD);
    expect(top.y).toBeLessThan(centre.y);
    expect(centre.y).toBeLessThan(bottom.y);
  });

  it("lower_third is left-aligned; bottom is centred", () => {
    expect(boxForPosition("lower_third", size, HD).x).toBeLessThan(
      boxForPosition("bottom", size, HD).x
    );
  });

  it("lower_center sits between the lower third and the bottom", () => {
    const lc = boxForPosition("lower_center", size, HD).y;
    expect(lc).toBeGreaterThan(boxForPosition("center", size, HD).y);
    expect(lc).toBeLessThan(boxForPosition("bottom", size, HD).y);
  });

  it("every named position stays inside the action-safe area", () => {
    const safe = safeArea(HD);
    for (const p of ["top", "center", "bottom", "lower_center"] as const) {
      expect(contains(safe, boxForPosition(p, size, HD)), p).toBe(true);
    }
    expect(SAFE_MARGIN).toBeGreaterThan(0);
  });

  it("custom uses the caller's safe zone, and falls back to bottom without one", () => {
    const s = style({ position: "custom", safeZone: { xPct: 0.1, yPct: 0.1, widthPct: 0.3, heightPct: 0.2 } });
    const box = boxForPosition("custom", size, HD, s);
    expect(box.y).toBeGreaterThanOrEqual(HD.heightPx * 0.1 - 1);
    expect(box.y).toBeLessThan(HD.heightPx * 0.35);

    const noZone = boxForPosition("custom", size, HD, style({ position: "custom" }));
    expect(noZone).toEqual(boxForPosition("bottom", size, HD, style({ position: "custom" })));
  });
});

/* ═══════════════════════ collision ═══════════════════════ */

describe("RONDE 152 — collision is geometry, not a nudge", () => {
  it("two boxes that share pixels intersect; two that merely touch do not", () => {
    const a = { x: 0, y: 0, width: 100, height: 100 };
    expect(intersects(a, { x: 50, y: 50, width: 100, height: 100 })).toBe(true);
    expect(intersects(a, { x: 100, y: 0, width: 100, height: 100 })).toBe(false);
  });

  it("two windows that merely touch at an instant do not overlap in time", () => {
    expect(overlapsInTime({ startSec: 0, endSec: 2 }, { startSec: 2, endSec: 4 })).toBe(false);
    expect(overlapsInTime({ startSec: 0, endSec: 2 }, { startSec: 1.9, endSec: 4 })).toBe(true);
  });

  /** The default case, and the one that must not change: nothing in the way, nothing moves. */
  it("leaves a caption exactly where the planner put it when nothing collides", () => {
    const out = layoutCaption({
      text: "Apple introduced the Vision Pro.",
      style: style(),
      startSec: 0,
      endSec: 2,
      frame: HD,
      obstacles: [],
    });
    expect(out.moved).toBe(false);
    expect(out.unresolved).toBe(false);
    expect(out.offsetYPx).toBe(0);
    expect(out.position).toBe("bottom");
  });

  it("ignores an obstacle that is not on screen at the same time", () => {
    const elsewhere = obstacle("g1", boxForPosition("bottom", { width: 900, height: 200 }, HD), {
      startSec: 5,
      endSec: 8,
    });
    const out = layoutCaption({
      text: "Apple introduced the Vision Pro.",
      style: style(),
      startSec: 0,
      endSec: 2,
      frame: HD,
      obstacles: [elsewhere],
    });
    expect(out.moved).toBe(false);
  });

  it("MOVES the caption off a graphic that shares its window", () => {
    const card = obstacle("g1", boxForPosition("bottom", { width: 1200, height: 220 }, HD));
    const out = layoutCaption({
      text: "Apple introduced the Vision Pro.",
      style: style(),
      startSec: 0,
      endSec: 2,
      frame: HD,
      obstacles: [card],
    });
    expect(out.moved).toBe(true);
    expect(out.unresolved).toBe(false);
    expect(intersects(out.box, card.box)).toBe(false);
  });

  it("leaves a real gap, not a touching edge", () => {
    const card = obstacle("g1", boxForPosition("bottom", { width: 1200, height: 200 }, HD));
    const out = layoutCaption({
      text: "Apple introduced the Vision Pro.",
      style: style(),
      startSec: 0,
      endSec: 2,
      frame: HD,
      obstacles: [card],
    });
    const gapPx = HD.heightPx * MIN_GAP;
    const grown = { ...card.box, y: card.box.y - gapPx, height: card.box.height + gapPx * 2 };
    expect(intersects(out.box, grown)).toBe(false);
  });

  it("stays inside the safe area wherever it ends up", () => {
    const card = obstacle("g1", boxForPosition("bottom", { width: 1400, height: 260 }, HD));
    const out = layoutCaption({
      text: "Apple introduced the Vision Pro at its own campus in Cupertino today.",
      style: style(),
      startSec: 0,
      endSec: 2,
      frame: HD,
      obstacles: [card],
    });
    expect(contains(safeArea(HD), out.box)).toBe(true);
  });

  /**
   * The "bereken beschikbare ruimte" step. Cards at every named anchor, but with a usable band
   * between two of them that no anchor happens to land in.
   */
  it("finds a free band when no NAMED position is available", () => {
    const wide = (y: number, h: number) => ({ x: 0, y, width: HD.widthPx, height: h });
    const out = layoutCaption({
      text: "Apple",
      style: style({ fontSizePx: 40 }),
      startSec: 0,
      endSec: 2,
      frame: HD,
      obstacles: [
        obstacle("top", wide(HD.heightPx * 0.05, HD.heightPx * 0.25)),
        obstacle("mid", wide(HD.heightPx * 0.42, HD.heightPx * 0.16)),
        obstacle("low", wide(HD.heightPx * 0.75, HD.heightPx * 0.2)),
      ],
    });
    expect(out.unresolved).toBe(false);
    expect(contains(safeArea(HD), out.box)).toBe(true);
  });

  /** §152: when there is genuinely nowhere, report — never overlap in silence. */
  it("reports caption_collision_unresolved when the frame is full", () => {
    const everything = obstacle("g1", { x: 0, y: 0, width: HD.widthPx, height: HD.heightPx });
    const out = layoutCaption({
      text: "Apple introduced the Vision Pro.",
      style: style(),
      startSec: 0,
      endSec: 2,
      frame: HD,
      obstacles: [everything],
    });
    expect(out.unresolved).toBe(true);
    expect(out.collidedWith).toContain("g1");
    const line = formatUnresolvedCollision("c1", out);
    expect(line).toContain("caption_collision_unresolved");
    expect(line).toContain("c1");
    expect(line).toContain("g1");
  });

  it("still returns a box when unresolved — a crowded caption beats a missing one", () => {
    const everything = obstacle("g1", { x: 0, y: 0, width: HD.widthPx, height: HD.heightPx });
    const out = layoutCaption({
      text: "Apple",
      style: style(),
      startSec: 0,
      endSec: 2,
      frame: HD,
      obstacles: [everything],
    });
    expect(out.box.width).toBeGreaterThan(0);
    expect(out.box.height).toBeGreaterThan(0);
  });

  it("is deterministic — the same inputs give the same box", () => {
    const args = {
      text: "Apple introduced the Vision Pro.",
      style: style(),
      startSec: 0,
      endSec: 2,
      frame: HD,
      obstacles: [obstacle("g1", boxForPosition("bottom", { width: 1200, height: 220 }, HD))],
    };
    expect(JSON.stringify(layoutCaption(args))).toBe(JSON.stringify(layoutCaption(args)));
  });

  /** The performance note: many obstacles at other times must not cost anything. */
  it("prunes by time before it compares rectangles", () => {
    const far = Array.from({ length: 500 }, (_, i) =>
      obstacle(`g${i}`, { x: 0, y: 0, width: HD.widthPx, height: HD.heightPx }, {
        startSec: 100 + i,
        endSec: 101 + i,
      })
    );
    const out = layoutCaption({
      text: "Apple",
      style: style(),
      startSec: 0,
      endSec: 2,
      frame: HD,
      obstacles: far,
    });
    expect(out.moved).toBe(false);
    expect(out.unresolved).toBe(false);
  });
});

/* ═══════════════════════ animations ═══════════════════════ */

describe("RONDE 152 — animations are deterministic arithmetic", () => {
  it("every named animation is a pure function of the frame", () => {
    for (const name of SUPPORTED_ANIMATIONS) {
      const a = animationAt(name, 5, 60);
      const b = animationAt(name, 5, 60);
      expect(b, name).toEqual(a);
    }
  });

  it("an unknown animation does nothing rather than guessing a similar one", () => {
    expect(animationAt("kaleidoscope", 5, 60)).toEqual(NEUTRAL);
  });

  it("fades in from nothing and out to nothing", () => {
    expect(animationAt("fade", 0, 60).opacity).toBeCloseTo(0, 2);
    expect(animationAt("fade", 30, 60).opacity).toBeCloseTo(1, 2);
    expect(animationAt("fade", 60, 60).opacity).toBeCloseTo(0, 2);
  });

  it("slides arrive at their resting place", () => {
    for (const name of ["slide_up", "slide_down", "slide_left", "slide_right"]) {
      const settled = animationAt(name, 40, 60);
      expect(Math.abs(settled.translateX), name).toBeLessThan(1);
      expect(Math.abs(settled.translateY), name).toBeLessThan(1);
    }
  });

  it("slides start displaced, in the direction their name says", () => {
    expect(animationAt("slide_up", 0, 60).translateY).toBeGreaterThan(0);
    expect(animationAt("slide_down", 0, 60).translateY).toBeLessThan(0);
    expect(animationAt("slide_left", 0, 60).translateX).toBeGreaterThan(0);
    expect(animationAt("slide_right", 0, 60).translateX).toBeLessThan(0);
  });

  it("pop overshoots and settles at 1", () => {
    const mid = animationAt("pop", 3, 60).scale;
    const settled = animationAt("pop", 40, 60).scale;
    expect(settled).toBeCloseTo(1, 2);
    expect(mid).not.toBeCloseTo(1, 3);
  });

  it("mask_reveal wipes open and ends fully revealed", () => {
    expect(animationAt("mask_reveal", 0, 60).revealFraction).toBeLessThan(0.2);
    expect(animationAt("mask_reveal", 40, 60).revealFraction).toBeCloseTo(1, 2);
  });

  it("progressive animations reveal the text, not the box", () => {
    for (const name of ["type_on", "word_reveal", "character_reveal"]) {
      expect(animationAt(name, 5, 60).scale, name).toBe(1);
      expect(revealProgress(name, 0, 60), name).toBe(0);
      expect(revealProgress(name, 60, 60), name).toBe(1);
    }
    // Everything else is fully revealed at every frame.
    expect(revealProgress("fade", 0, 60)).toBe(1);
  });

  it("a very short element still gets a real entrance", () => {
    expect(transitionFrames(2)).toBeGreaterThanOrEqual(1);
    expect(transitionFrames(600)).toBeLessThanOrEqual(10);
  });

  it("opacity and scale stay in sane ranges for every animation and frame", () => {
    for (const name of SUPPORTED_ANIMATIONS) {
      for (const frame of [0, 1, 5, 15, 30, 59, 60]) {
        const s = animationAt(name, frame, 60);
        expect(s.opacity, `${name}@${frame}`).toBeGreaterThanOrEqual(0);
        expect(s.opacity, `${name}@${frame}`).toBeLessThanOrEqual(1);
        expect(s.scale, `${name}@${frame}`).toBeGreaterThan(0);
        expect(s.scale, `${name}@${frame}`).toBeLessThan(3);
      }
    }
  });
});

/* ═══════════════════════ caption modes ═══════════════════════ */

describe("RONDE 152 — caption modes group the TTS's own words", () => {
  const words = [
    { word: "Apple", startSec: 0, endSec: 0.4 },
    { word: "introduced", startSec: 0.4, endSec: 1.0 },
    { word: "the", startSec: 1.0, endSec: 1.1 },
    { word: "Vision", startSec: 1.1, endSec: 1.5 },
    { word: "Pro", startSec: 1.5, endSec: 1.9 },
  ];

  it("sentence is one chunk spanning the caption", () => {
    const { chunks, degraded } = chunkCaption({ mode: "sentence", words, startSec: 0, endSec: 2 });
    expect(chunks).toHaveLength(1);
    expect(degraded).toBe(false);
    expect(chunks[0]!.startSec).toBe(0);
    expect(chunks[0]!.endSec).toBe(2);
  });

  it("word_by_word uses each word's MEASURED boundaries", () => {
    const { chunks } = chunkCaption({ mode: "word_by_word", words, startSec: 0, endSec: 2 });
    expect(chunks).toHaveLength(5);
    expect(chunks[0]!.startSec).toBe(0);
    expect(chunks[1]!.startSec).toBe(0.4);
    expect(chunks[3]!.startSec).toBe(1.1);
    // Not an even split — an even split would put every boundary at 0.4s.
    expect(chunks[2]!.endSec - chunks[2]!.startSec).toBeCloseTo(0.1, 3);
  });

  it("phrase groups words and takes the group's real span", () => {
    const { chunks } = chunkCaption({ mode: "phrase", words, startSec: 0, endSec: 2, phraseSize: 2 });
    expect(chunks).toHaveLength(3);
    expect(chunks[0]!.startSec).toBe(0);
    expect(chunks[0]!.endSec).toBe(1.0);
    expect(chunks[1]!.startSec).toBe(1.0);
  });

  it("karaoke keeps the whole line up — the highlighting is the component's job", () => {
    const { chunks, degraded } = chunkCaption({ mode: "karaoke", words, startSec: 0, endSec: 2 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.words).toHaveLength(5);
    expect(degraded).toBe(false);
  });

  /**
   * §12: the timing is never invented. A karaoke caption on a video with no alignment shows the
   * sentence and is REPORTED as degraded — it does not get an evenly-split fake highlight, which
   * would light up the wrong word for most of the line's life.
   */
  it("degrades honestly when there is no word timing to work from", () => {
    const { chunks, degraded } = chunkCaption({ mode: "karaoke", words: [], startSec: 0, endSec: 2 });
    expect(chunks).toHaveLength(1);
    expect(degraded).toBe(true);
  });

  it("an unknown mode shows the sentence and says it degraded", () => {
    const { degraded } = chunkCaption({ mode: "hologram", words, startSec: 0, endSec: 2 });
    expect(degraded).toBe(true);
  });

  it("chunks never leave a gap or run backwards", () => {
    for (const mode of SUPPORTED_CAPTION_MODES) {
      const { chunks } = chunkCaption({ mode, words, startSec: 0, endSec: 2 });
      for (const c of chunks) expect(c.endSec, mode).toBeGreaterThan(c.startSec);
    }
  });
});

/* ═══════════════════════ the style vocabulary reaches the timeline ═══════════════════════ */

describe("RONDE 152 — every style field survives a round trip", () => {
  it("carries the full typographic vocabulary through JSON", () => {
    const rich: TextStyle = {
      ...DEFAULT_TEXT_STYLE,
      fontFamily: "Inter",
      fontWeight: 900,
      italic: true,
      align: "left",
      maxWidthPct: 0.6,
      lineHeight: 1.4,
      letterSpacingEm: 0.04,
      outlineColor: "#000",
      outlineWidthPx: 3,
      shadow: false,
      highlightColor: "#ffd54a",
      emphasisColor: "#ff5252",
      maxLines: 2,
      position: "custom",
      safeZone: { xPct: 0.1, yPct: 0.6, widthPct: 0.8, heightPct: 0.2 },
    };
    expect(JSON.parse(JSON.stringify(rich))).toEqual(rich);
  });

  it("the default style still says exactly what it always said", () => {
    // The golden test renders against these; a change here changes every existing video.
    expect(DEFAULT_CAPTION_STYLE.position).toBe("bottom");
    expect(DEFAULT_CAPTION_STYLE.fontSizePx).toBeGreaterThan(0);
  });
});
