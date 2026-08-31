/**
 * RONDE 152 — caption layout as GEOMETRY, not as a nudge.
 *
 * ── What this replaces ───────────────────────────────────────────────────────────────────────
 *
 * RONDE 150 found a real collision — a lower third and a two-line caption drawn at their planned
 * positions struck through each other — and fixed it by lifting the card a derived 12% of the frame
 * height. That number was reasoned about, but it was still one constant applied to every case, and
 * §152 names the approach it wants instead:
 *
 *     graphic bounding box + caption bounding box → collision → compute the free space →
 *     choose a safe position; and when there is none, REPORT caption_collision_unresolved.
 *
 * So this module measures boxes. A caption that does not collide is not moved at all — the planner
 * put it where it wanted it — and a caption that cannot be placed anywhere is reported rather than
 * drawn on top of something.
 *
 * ── Why the measurement is approximate, and why that is honest ──────────────────────────────
 *
 * The exact pixel extent of a line of text is known only to whatever draws it: libass and a browser
 * disagree about kerning, and neither has run when the layout is decided. So this estimates from
 * the font size, the character count and the line count, using a conservative average glyph width.
 * The estimate is deliberately WIDE rather than tight: a box that is slightly too big moves a
 * caption that might just have fitted, while a box that is too small lets two things overlap. One
 * of those errors is invisible and one of them is the bug this module exists to prevent.
 *
 * ── Everything here is a pure function ──────────────────────────────────────────────────────
 *
 * No frame, no rendering, no clock. The same timeline produces the same layout every time, which is
 * what lets the ffmpeg route and the Remotion route agree about where a caption sits.
 */
import type { TextStyle } from "./projectTimeline";

/* ═══════════════════════ boxes ═══════════════════════ */

/** A rectangle in PIXELS, origin top-left, as the renderer's frame is. */
export type Box = { x: number; y: number; width: number; height: number };

export type Frame = { widthPx: number; heightPx: number };

/** An element already on screen that a caption must not cover. */
export type Obstacle = {
  id: string;
  kind: "graphic" | "text" | "caption";
  box: Box;
  startSec: number;
  endSec: number;
};

/**
 * The action-safe margin, as a fraction of the frame.
 *
 * 5% is the broadcast convention and the reason it exists here is not tradition: phone players,
 * TV overscan and social-platform chrome all eat the outermost few percent, and a caption placed
 * flush to the edge is a caption somebody's player will clip.
 */
export const SAFE_MARGIN = 0.05;

/** The gap left between two elements that would otherwise touch, as a fraction of frame height. */
export const MIN_GAP = 0.02;

export function safeArea(frame: Frame): Box {
  return {
    x: frame.widthPx * SAFE_MARGIN,
    y: frame.heightPx * SAFE_MARGIN,
    width: frame.widthPx * (1 - 2 * SAFE_MARGIN),
    height: frame.heightPx * (1 - 2 * SAFE_MARGIN),
  };
}

export function intersects(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

/** Do two half-open time windows overlap? Touching at an instant is not an overlap. */
export function overlapsInTime(
  a: { startSec: number; endSec: number },
  b: { startSec: number; endSec: number }
): boolean {
  return a.startSec < b.endSec && b.startSec < a.endSec;
}

export function contains(outer: Box, inner: Box): boolean {
  return (
    inner.x >= outer.x - 0.5 &&
    inner.y >= outer.y - 0.5 &&
    inner.x + inner.width <= outer.x + outer.width + 0.5 &&
    inner.y + inner.height <= outer.y + outer.height + 0.5
  );
}

/* ═══════════════════════ measuring text ═══════════════════════ */

/**
 * Average glyph advance as a fraction of the font size, for the bold sans the renderers use.
 *
 * MEASURED against DejaVu Sans Bold, which is the face both routes fall back to: its average
 * advance over mixed-case Latin text is close to 0.58em. Rounded UP to 0.62 deliberately — see the
 * module note on why an over-wide box is the safe error.
 */
export const AVG_GLYPH_EM = 0.62;

/** How tall one line is, as a multiple of the font size, when the style does not say. */
export const DEFAULT_LINE_HEIGHT = 1.25;

/**
 * How many lines this text needs at this width.
 *
 * Wraps on the same rule the ASS route already uses — a character budget per line — so the two
 * routes agree about line count even though they disagree about kerning.
 */
export function lineCountFor(text: string, style: TextStyle, frame: Frame): number {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;
  const maxChars = maxCharsPerLine(style, frame);
  if (maxChars <= 0) return 1;

  let lines = 1;
  let used = 0;
  for (const word of words) {
    const add = used === 0 ? word.length : word.length + 1;
    if (used + add > maxChars && used > 0) {
      lines++;
      used = word.length;
    } else {
      used += add;
    }
  }
  return lines;
}

/** The character budget per line: the style's own, or what the safe width allows. */
export function maxCharsPerLine(style: TextStyle, frame: Frame): number {
  if (style.maxCharsPerLine && style.maxCharsPerLine > 0) return style.maxCharsPerLine;
  const widthFraction = style.maxWidthPct != null ? style.maxWidthPct : 1 - 2 * SAFE_MARGIN;
  const usableWidthPx = frame.widthPx * Math.max(0.1, Math.min(1, widthFraction));
  const glyphPx = style.fontSizePx * AVG_GLYPH_EM * (1 + (style.letterSpacingEm ?? 0));
  return Math.max(1, Math.floor(usableWidthPx / Math.max(1, glyphPx)));
}

/** The box this text occupies, before any collision is considered. */
export function measureText(text: string, style: TextStyle, frame: Frame): { width: number; height: number } {
  const lines = Math.max(1, lineCountFor(text, style, frame));
  const chars = Math.min(text.trim().length, maxCharsPerLine(style, frame));
  const glyphPx = style.fontSizePx * AVG_GLYPH_EM * (1 + (style.letterSpacingEm ?? 0));
  const lineHeight = style.lineHeight ?? DEFAULT_LINE_HEIGHT;
  /** A boxed style has padding around it; an un-boxed one does not. */
  const padX = style.backgroundOpacity > 0 ? style.fontSizePx * 0.6 : 0;
  const padY = style.backgroundOpacity > 0 ? style.fontSizePx * 0.35 : 0;
  return {
    width: Math.min(frame.widthPx, chars * glyphPx + padX * 2),
    height: lines * style.fontSizePx * lineHeight + padY * 2,
  };
}

/* ═══════════════════════ where a position puts a box ═══════════════════════ */

export type ResolvedPosition = TextStyle["position"];

/**
 * The box a named position produces, for text of a known size.
 *
 * These are the SAME anchors `positionStyle` uses in the Remotion components and `assAlignment`
 * uses on the libass route — expressed here as arithmetic so a collision can be computed against
 * them. If the two ever disagree the captions move between routes, so a test pins them together.
 */
export function boxForPosition(
  position: ResolvedPosition,
  size: { width: number; height: number },
  frame: Frame,
  style?: TextStyle
): Box {
  const safe = safeArea(frame);
  const centreX = (frame.widthPx - size.width) / 2;

  switch (position) {
    case "top":
      return { x: centreX, y: frame.heightPx * 0.06, width: size.width, height: size.height };
    case "center":
      return {
        x: centreX,
        y: (frame.heightPx - size.height) / 2,
        width: size.width,
        height: size.height,
      };
    case "lower_third":
      /** Left-aligned, a fifth up from the bottom — the broadcast lower-third anchor. */
      return {
        x: frame.widthPx * 0.08,
        y: frame.heightPx * 0.78 - size.height,
        width: size.width,
        height: size.height,
      };
    case "lower_center":
      return {
        x: centreX,
        y: frame.heightPx * 0.72 - size.height,
        width: size.width,
        height: size.height,
      };
    case "custom": {
      /**
       * A caller-supplied safe zone, in fractions of the frame. Centred inside the zone rather
       * than pinned to its corner, so a zone slightly larger than the text still looks deliberate.
       */
      const z = style?.safeZone;
      if (!z) return boxForPosition("bottom", size, frame, style);
      const zx = frame.widthPx * z.xPct;
      const zy = frame.heightPx * z.yPct;
      const zw = frame.widthPx * z.widthPct;
      const zh = frame.heightPx * z.heightPct;
      return {
        x: zx + Math.max(0, (zw - size.width) / 2),
        y: zy + Math.max(0, (zh - size.height) / 2),
        width: size.width,
        height: size.height,
      };
    }
    case "bottom":
    default:
      return {
        x: centreX,
        y: safe.y + safe.height - size.height,
        width: size.width,
        height: size.height,
      };
  }
}

/* ═══════════════════════ resolving a collision ═══════════════════════ */

export type LayoutOutcome = {
  /** Where to draw it. Present even when unresolved — see `unresolved`. */
  box: Box;
  position: ResolvedPosition;
  /** The vertical shift applied to the planner's own position, in pixels. 0 when untouched. */
  offsetYPx: number;
  /** True when the planner's position had to change. */
  moved: boolean;
  /**
   * True when NO position was free. The caption is still drawn — a missing caption is worse than
   * a crowded one — but the render reports `caption_collision_unresolved` so it is never silent.
   */
  unresolved: boolean;
  /** Which obstacles it collided with, by id, for the report. */
  collidedWith: string[];
};

/**
 * The order alternative positions are tried in.
 *
 * Deliberately ordered by how little it changes the planner's intent: a caption that wanted to be
 * at the bottom is happier slightly higher than it is in the middle of the frame. Fixed rather than
 * searched, so the outcome is deterministic.
 */
const FALLBACK_ORDER: Record<ResolvedPosition, ResolvedPosition[]> = {
  bottom: ["bottom", "lower_center", "center", "top"],
  lower_center: ["lower_center", "bottom", "center", "top"],
  lower_third: ["lower_third", "lower_center", "top", "center"],
  center: ["center", "lower_center", "top", "bottom"],
  top: ["top", "center", "lower_center", "bottom"],
  custom: ["custom", "bottom", "lower_center", "center", "top"],
};

/**
 * Place one caption so it collides with nothing that shares its time window.
 *
 * ── The interval prune ──────────────────────────────────────────────────────────────────────
 *
 * Only obstacles whose time window overlaps the caption's can possibly collide, and that check is
 * one comparison against many rectangle intersections. Filtering by time FIRST is what keeps this
 * linear in practice on a video with hundreds of graphics, which is the performance note the brief
 * makes about not writing O(n²) where interval indexing will do.
 */
export function layoutCaption(params: {
  text: string;
  style: TextStyle;
  startSec: number;
  endSec: number;
  frame: Frame;
  obstacles: readonly Obstacle[];
}): LayoutOutcome {
  const { style, frame } = params;
  const size = measureText(params.text, style, frame);
  const safe = safeArea(frame);
  const gap = frame.heightPx * MIN_GAP;

  /** The cheap prune: everything that cannot be on screen at the same time is irrelevant. */
  const live = params.obstacles.filter((o) =>
    overlapsInTime({ startSec: params.startSec, endSec: params.endSec }, o)
  );

  const grown = (b: Box): Box => ({
    x: b.x,
    y: b.y - gap,
    width: b.width,
    height: b.height + gap * 2,
  });

  const hits = (box: Box): string[] =>
    live.filter((o) => intersects(box, grown(o.box))).map((o) => o.id);

  const wanted = style.position;
  const order = FALLBACK_ORDER[wanted] ?? FALLBACK_ORDER.bottom;
  const first = boxForPosition(wanted, size, frame, style);

  for (const candidate of order) {
    const box = boxForPosition(candidate, size, frame, style);
    if (!contains(safe, box)) continue;
    const collided = hits(box);
    if (collided.length === 0) {
      return {
        box,
        position: candidate,
        offsetYPx: Number((box.y - first.y).toFixed(2)),
        moved: candidate !== wanted,
        unresolved: false,
        collidedWith: [],
      };
    }
  }

  /**
   * No named position was free, so try the largest vertical GAP between obstacles.
   *
   * This is the "bereken beschikbare ruimte" step: the obstacles' vertical spans are merged, and
   * what is left inside the safe area is where a caption can still go. It catches the common real
   * case — a lower third and a card both low in the frame, leaving a usable band above them that no
   * named anchor happens to land in.
   */
  const spans = live
    .map((o) => ({ top: o.box.y - gap, bottom: o.box.y + o.box.height + gap }))
    .sort((a, b) => a.top - b.top);
  const merged: Array<{ top: number; bottom: number }> = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s.top <= last.bottom) last.bottom = Math.max(last.bottom, s.bottom);
    else merged.push({ ...s });
  }

  let cursor = safe.y;
  const free: Array<{ top: number; bottom: number }> = [];
  for (const m of merged) {
    if (m.top > cursor) free.push({ top: cursor, bottom: Math.min(m.top, safe.y + safe.height) });
    cursor = Math.max(cursor, m.bottom);
  }
  if (cursor < safe.y + safe.height) free.push({ top: cursor, bottom: safe.y + safe.height });

  /** The lowest band that fits, because a caption belongs as low as it safely can. */
  const fitting = free.filter((f) => f.bottom - f.top >= size.height).sort((a, b) => b.top - a.top)[0];
  if (fitting) {
    const box: Box = {
      x: (frame.widthPx - size.width) / 2,
      y: fitting.bottom - size.height,
      width: size.width,
      height: size.height,
    };
    return {
      box,
      position: wanted,
      offsetYPx: Number((box.y - first.y).toFixed(2)),
      moved: true,
      unresolved: false,
      collidedWith: [],
    };
  }

  /**
   * Nothing fits. The caption is still drawn at its planned position — a viewer who cannot read a
   * crowded caption is better served than one who gets no caption at all — and the caller reports
   * `caption_collision_unresolved` with the ids it clashes with.
   */
  return {
    box: first,
    position: wanted,
    offsetYPx: 0,
    moved: false,
    unresolved: true,
    collidedWith: hits(first),
  };
}

/** The report line for a collision that could not be solved. §152: never silent. */
export function formatUnresolvedCollision(id: string, outcome: LayoutOutcome): string {
  return (
    `caption_collision_unresolved ${id} — no position inside the safe area was free; ` +
    `overlaps ${outcome.collidedWith.join(", ") || "unknown elements"}`
  );
}
