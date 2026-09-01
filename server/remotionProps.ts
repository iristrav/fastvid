/**
 * RONDE 150 §5/§6 — ProjectTimeline → Remotion graphics props, and back-checkable.
 *
 * ── The one rule this file exists to enforce ─────────────────────────────────────────────────
 *
 * NOTHING EDITORIAL MAY BE LOST HERE.
 *
 * This adapter is the last place the caption and graphics planners' decisions pass through before
 * they become pixels, and it is the easiest place in the whole chain to drop something by accident:
 * a field that is not copied simply does not appear, no type complains, and the render comes out
 * missing a caption that three planners agreed on. So the shape below is deliberately close to the
 * timeline's own, the copying is explicit, and `missingEditorialFields` reads the RESULT back and
 * names anything that went in and did not come out.
 *
 * ── Why there are no clips in here ───────────────────────────────────────────────────────────
 *
 * Remotion renders the GRAPHICS layer and nothing else — the picture is ffmpeg's, from the same
 * timeline (§5, and see server/remotion/GraphicsOverlay.tsx for why the duplicate renderer went
 * away). So this adapter carries the three text-shaped tracks, the video's shape, and the measured
 * word boundaries. That is the whole surface.
 *
 * The nicest consequence is about §26. An earlier version carried clips with their media URLs and
 * relied on a `sanitiseIdentity` helper to strip anything that could hold a signed token before it
 * reached the browser bundle. A rule enforced by a helper is a rule someone can forget to call.
 * With no media in the props at all, "no credentials cross into the browser" stops being a rule and
 * becomes a property of the shape: there is no field one could travel in.
 *
 * ── This file makes no decisions ─────────────────────────────────────────────────────────────
 *
 * §29: planner ≠ renderer. Every value here is copied or converted between units. Nothing is
 * chosen. Where a default IS applied it is named and explained, so a reader can tell a copied value
 * from a filled-in one.
 */
import {
  DEFAULT_TEXT_STYLE,
  captionTrack,
  graphicsTrack,
  textTrackOf,
  type ProjectTimeline,
  type TextStyle,
} from "./projectTimeline";
import {
  boxForPosition,
  formatUnresolvedCollision,
  layoutCaption,
  measureText,
  safeArea,
  type Frame,
  type Obstacle,
} from "./captionLayout";

/**
 * The style a graphic is measured at when it carries none of its own.
 *
 * ── RONDE 185: the anchor here has to be the one the COMPONENT falls back to ─────────────────
 *
 * It used to inherit `DEFAULT_TEXT_STYLE.position`, which is `center`, while `Graphics.tsx` draws a
 * style-less graphic at `bottom` (or `lower_third` for a lower third). So the layout engine was
 * placing an obstacle in the middle of the frame for something the renderer drew along the bottom:
 * captions were moved out of the way of a box that was not there, and left sitting on top of the
 * graphic that was.
 *
 * One default, agreed with the drawing code. `graphicDefaultStyle` reproduces the component's own
 * two-branch fallback rather than approximating it with a single value.
 */
const DEFAULT_GRAPHIC_STYLE: TextStyle = { ...DEFAULT_TEXT_STYLE, fontSizePx: 46, position: "bottom" };

/** The style a graphic is laid out with — its own, or the one the renderer would fall back to. */
function graphicDefaultStyle(graphicType: string): TextStyle {
  return graphicType === "lower_third"
    ? { ...DEFAULT_GRAPHIC_STYLE, position: "lower_third" }
    : DEFAULT_GRAPHIC_STYLE;
}

/* ═══════════════════════ the props Remotion receives ═══════════════════════ */

export type RemotionTextElement = {
  id: string;
  text: string;
  /** Frames, not seconds — Remotion's unit. Seconds stay on the timeline. */
  fromFrame: number;
  durationInFrames: number;
  style: TextStyle;
  animation: string;
  /** Which family of text this is, so the component can style it: caption or free text. */
  role: "caption" | "text";
  /* ── RONDE 152 ── */
  /** How the caption is broken up over time. Absent means the whole sentence at once. */
  mode?: string;
  emphasisWordIndices?: number[];
  /**
   * Where `captionLayout` decided this goes, in pixels, after resolving collisions.
   *
   * Absent means "nothing was in the way, use the named position" — which is the common case and
   * keeps a video with no graphics rendering exactly as it did before this round.
   */
  layout?: { x: number; y: number; width: number; height: number };
};

export type RemotionGraphic = {
  id: string;
  graphicType: string;
  /** The planner's own payload, passed through untouched. The component reads it; nothing invents. */
  data: Record<string, unknown>;
  label: string | null;
  fromFrame: number;
  durationInFrames: number;
  style: TextStyle | null;
  /**
   * RONDE 185 — where the layout engine put it, when it had to move it out of another's way.
   *
   * Absent when nothing collided, which is the overwhelming majority of graphics and the reason a
   * video with no crowding produces byte-identical props to before this round. Same shape and same
   * meaning as `RemotionTextElement.layout`: one mechanism for both, not two.
   */
  layout?: { x: number; y: number; width: number; height: number };
  reason: string | null;
};

/**
 * Word-level caption timing, straight from the TTS alignment.
 *
 * §13: "Geen nieuwe timing berekenen." These are the measured word boundaries from ElevenLabs,
 * carried through so a caption can highlight a word at exactly the instant it is spoken.
 */
export type RemotionWordTiming = { word: string; startSec: number; endSec: number };

export type RemotionGraphicsProps = {
  fps: number;
  width: number;
  height: number;
  durationInFrames: number;
  durationSec: number;
  captions: RemotionTextElement[];
  texts: RemotionTextElement[];
  graphics: RemotionGraphic[];
  words: RemotionWordTiming[];
  /**
   * RONDE 152 — captions the layout engine could not place without an overlap.
   *
   * On the props rather than thrown, because the caption is still DRAWN: a viewer who has to read a
   * crowded caption is better served than one who gets none. What must not happen is the overlap
   * going unmentioned, so the renderer copies these into its `skipped` report.
   */
  unresolvedCollisions: string[];
  /** Carried for the render log and the report; never used to make a picture. */
  meta: { videoId: number; timelineVersion: number; schemaVersion: number };
};

/* ═══════════════════════ conversion ═══════════════════════ */

/** Seconds → frames, rounded to the nearest whole frame. Remotion cannot render half a frame. */
export function toFrames(sec: number, fps: number): number {
  if (!Number.isFinite(sec) || !Number.isFinite(fps) || fps <= 0) return 0;
  return Math.max(0, Math.round(sec * fps));
}

/**
 * How big a graphic actually is on screen, in the frame's own pixels.
 *
 * ── RONDE 185: why this had to exist before collisions could be detected at all ──────────────
 *
 * Two graphics cannot be found to overlap without boxes to compare, and only LABELLED graphics had
 * one — they were measured as text so that captions could be moved out of their way. A chart, a map
 * or a percentage ring was invisible to the layout engine entirely: nothing avoided it and it
 * avoided nothing.
 *
 * The sizes below are the components' OWN dimensions, not estimates: `Charts.tsx` draws its chart
 * and map SVGs at 900×520 and its ring at 140×140, and `Shape` uses the same 140 box. Reading them
 * from the drawing code is what keeps this honest — a guessed rectangle would move graphics out of
 * each other's way at the wrong moment and leave real overlaps alone.
 */
function graphicBoxSize(
  graphicType: string,
  label: string | null | undefined,
  style: TextStyle,
  frame: Frame
): { width: number; height: number } {
  /**
   * Bounded by the SAFE AREA, not by the raw frame.
   *
   * A chart's natural 900×520 does not fit inside the safe area of a small preview frame, and a box
   * the layout engine can never contain is rejected at every anchor — which made every chart come
   * back "no free position" with nothing listed as the thing it collided with. The component scales
   * its SVG to the space it is given, so the honest box is "its natural size, or the room there is".
   */
  const safe = safeArea(frame);
  /** The chart and map family: one SVG, drawn at its own natural size. */
  if (["bar_chart", "horizontal_bar", "line_chart", "pie_chart", "donut_chart",
       "map_point", "route", "multi_point"].includes(graphicType)) {
    return { width: Math.min(900, safe.width), height: Math.min(520, safe.height) };
  }
  /** The round ones and the shapes share a 140px box in the component. */
  if (["percentage_ring", "progress", "shape", "icon"].includes(graphicType)) {
    return { width: Math.min(140, safe.width), height: Math.min(140, safe.height) };
  }
  /** Everything else is words on screen, measured the way a caption is. */
  return measureText(label?.trim() || graphicType, style, frame);
}

/**
 * Build the graphics props for one timeline.
 *
 * There is no `resolveMedia` parameter and no injected downloader, because this layer needs no
 * media. Compare the ffmpeg renderer, which needs both — that asymmetry is the architecture, not
 * an oversight.
 */
export function timelineToRemotionProps(params: {
  timeline: ProjectTimeline;
  /** The measured TTS word boundaries, when the video has them. */
  words?: RemotionWordTiming[];
}): RemotionGraphicsProps {
  const { timeline } = params;
  const fps = timeline.format.fps;
  const unresolvedCollisions: string[] = [];

  const frame = { widthPx: timeline.format.widthPx, heightPx: timeline.format.heightPx };

  /**
   * RONDE 152 — the obstacles a caption must not cover, measured as real boxes.
   *
   * Graphics and free text are obstacles; captions are not obstacles to each other by default,
   * because two captions at once is a `caption_overlap` the validator already reports as advisory
   * and re-solving it here would move captions the planner deliberately stacked.
   */
  /**
   * RONDE 185 — the graphics are placed against EACH OTHER first, and then become the obstacles.
   *
   * ── The defect ────────────────────────────────────────────────────────────────────────────
   *
   * `translateEdl` writes no style onto a graphic, and `Graphics.tsx` falls back to `bottom` for
   * everything that is not a lower third. So every graphic on a beat landed on the same anchor: the
   * showcase's dated beat drew a timeline card, a highlight box and a brand icon on top of one
   * another, and nothing anywhere said so. Captions were laid out against graphics, but no graphic
   * was ever laid out against anything.
   *
   * ── Order, and why it is this way round ───────────────────────────────────────────────────
   *
   * Graphics settle FIRST and captions move around the result. That is the existing contract —
   * `layoutCaption` already treats a graphic as furniture — and reversing it would have the two
   * chasing each other. Within the graphics the order is by start time then id, so the same
   * timeline always produces the same placement; nothing here consults a clock or a random source.
   *
   * ── Nothing moves silently ────────────────────────────────────────────────────────────────
   *
   * Every relocation is recorded with the anchor it wanted, the anchor it got and what it collided
   * with, and an unresolvable one is still DRAWN and reported. A missing graphic is worse than a
   * crowded one; an unexplained move is worse than either.
   */
  const graphicMoves = new Map<string, { box: { x: number; y: number; width: number; height: number } }>();
  const placedGraphics: Obstacle[] = [];
  for (const g of graphicsTrack(timeline)
    .filter((x) => !x.disabled)
    .slice()
    .sort((a, b) => a.start - b.start || a.id.localeCompare(b.id))) {
    const style = g.style ?? graphicDefaultStyle(g.graphicType);
    const size = graphicBoxSize(g.graphicType, g.label, style, frame);
    const placed = layoutCaption({
      /** Its own words when it has them — the box comes from `size`, which is already correct. */
      text: g.label?.trim() || g.graphicType,
      style,
      startSec: g.start,
      endSec: g.end,
      frame,
      obstacles: placedGraphics,
      measuredSize: size,
    });
    placedGraphics.push({
      id: g.id,
      kind: "graphic",
      box: placed.box,
      startSec: g.start,
      endSec: g.end,
    });
    if (placed.unresolved) {
      unresolvedCollisions.push(
        `graphic_collision_unresolved ${g.id} (${g.graphicType}) at ${g.start.toFixed(2)}s — ` +
          `no free position; drawn at ${placed.position} over ${placed.collidedWith.join(", ")}`
      );
    } else if (placed.moved) {
      /**
       * The relocation, named the way it actually happened. The resolver answers in two forms: a
       * different ANCHOR when one is free, and a pixel OFFSET from the planned anchor when it had
       * to find a gap between obstacles instead. Reporting both as "bottom → bottom" — which an
       * anchor-only line does — would say a graphic moved and name no movement.
       */
      graphicMoves.set(g.id, { box: placed.box });
      unresolvedCollisions.push(
        `graphic_moved ${g.id} (${g.graphicType}) at ${g.start.toFixed(2)}s — ` +
          (placed.position !== style.position
            ? `${style.position} → ${placed.position}`
            : `${style.position} shifted ${placed.offsetYPx.toFixed(0)}px`) +
          ` to clear ${placed.collidedWith.join(", ") || "an earlier graphic"}`
      );
    }
  }

  const obstacles: Obstacle[] = [
    ...placedGraphics,
    ...textTrackOf(timeline, "TEXT")
      .filter((t) => !t.disabled && t.text.trim())
      .map((t) => ({
        id: t.id,
        kind: "text" as const,
        box: boxForPosition(t.style.position, measureText(t.text, t.style, frame), frame, t.style),
        startSec: t.start,
        endSec: t.end,
      })),
  ];

  const textElement = (
    el: {
      id: string;
      text: string;
      start: number;
      end: number;
      style: TextStyle;
      animation?: string;
      mode?: string;
      emphasisWordIndices?: number[];
    },
    role: "caption" | "text"
  ): RemotionTextElement => {
    /**
     * Only CAPTIONS are laid out against the obstacles. A free text element IS an obstacle — moving
     * it would mean moving the thing the caption was moved to avoid, and the two would chase each
     * other around the frame.
     */
    const placed =
      role === "caption"
        ? layoutCaption({
            text: el.text,
            style: el.style,
            startSec: el.start,
            endSec: el.end,
            frame,
            obstacles,
          })
        : null;
    if (placed?.unresolved) unresolvedCollisions.push(formatUnresolvedCollision(el.id, placed));

    return {
      id: el.id,
      text: el.text,
      fromFrame: toFrames(el.start, fps),
      durationInFrames: Math.max(1, toFrames(Math.max(0, el.end - el.start), fps)),
      style: el.style,
      /** The renderer's existing default when a planner expressed no preference. Named, not silent. */
      animation: el.animation ?? "fade",
      role,
      ...(el.mode ? { mode: el.mode } : {}),
      ...(el.emphasisWordIndices?.length ? { emphasisWordIndices: el.emphasisWordIndices } : {}),
      /**
       * Only carried when the layout actually MOVED it. An unmoved caption keeps its named
       * position, so a video with no graphics produces byte-identical props to before this round.
       */
      ...(placed && placed.moved && !placed.unresolved ? { layout: placed.box } : {}),
    };
  };

  return {
    fps,
    width: timeline.format.widthPx,
    height: timeline.format.heightPx,
    /**
     * The timeline's OWN duration, not the sum of the clips.
     *
     * The overlay must be exactly as long as the picture it will be composited onto, and the
     * picture's length comes from this same field. Deriving it from the graphics instead would end
     * the overlay at the last caption and leave the tail of the video uncovered.
     */
    durationInFrames: Math.max(1, toFrames(timeline.durationSec, fps)),
    durationSec: timeline.durationSec,
    captions: captionTrack(timeline)
      .filter((c) => !c.disabled)
      .map((c) => textElement(c, "caption")),
    texts: textTrackOf(timeline, "TEXT")
      .filter((t) => !t.disabled)
      .map((t) => textElement(t, "text")),
    graphics: graphicsTrack(timeline)
      .filter((g) => !g.disabled)
      .map((g) => {
        /**
         * RONDE 185 — a graphic the layout moved carries its new anchor, and only then.
         *
         * A graphic that did not have to move keeps `style` exactly as the timeline wrote it —
         * including `null` — so a video whose graphics never collide produces the same props it
         * produced before this round.
         */
        const move = graphicMoves.get(g.id);
        return {
          id: g.id,
          graphicType: g.graphicType,
          data: g.data ?? {},
          label: g.label ?? null,
          fromFrame: toFrames(g.start, fps),
          durationInFrames: Math.max(1, toFrames(Math.max(0, g.end - g.start), fps)),
          style: g.style ?? null,
          /**
           * RONDE 185 — the resolved BOX, exactly the way a moved caption already carries one.
           *
           * A pixel box says where the graphic ended up whether the resolver changed its anchor or
           * shifted it within one; an anchor alone cannot express the second case, which is the
           * resolver's answer whenever it had to find a gap. Carried only when it MOVED, so a video
           * whose graphics never collide produces the props it produced before this round.
           */
          ...(move ? { layout: move.box } : {}),
          reason: g.reason ?? null,
        };
      }),
    words: params.words ?? [],
    unresolvedCollisions,
    meta: {
      videoId: timeline.videoId,
      timelineVersion: timeline.version,
      schemaVersion: timeline.schemaVersion ?? 1,
    },
  };
}

/* ═══════════════════════ §5 — proving nothing was lost ═══════════════════════ */

/**
 * Compare the timeline with the props built from it, and name anything that went missing.
 *
 * ── Why this exists as production code and not only as a test ────────────────────────────────
 *
 * A test proves the adapter was lossless for the cases someone thought of. This runs on the REAL
 * timeline at render time, so a video whose planners produced a combination nobody tested still
 * gets an answer — and the answer appears in the render report rather than in a silence.
 *
 * It compares IDS rather than deep-equality, deliberately: a props object is a different shape by
 * design (frames instead of seconds), so a deep comparison would be all noise. What must hold is
 * that every element that was in the document is also in the props, by id.
 */
export function missingEditorialFields(
  timeline: ProjectTimeline,
  props: RemotionGraphicsProps
): string[] {
  const missing: string[] = [];

  const compare = (
    label: string,
    source: ReadonlyArray<{ id: string }>,
    made: ReadonlyArray<{ id: string }>
  ) => {
    const there = new Set(made.map((x) => x.id));
    for (const el of source) {
      if (!there.has(el.id)) missing.push(`${label} ${el.id} did not reach the renderer`);
    }
  };

  compare("caption", captionTrack(timeline).filter((c) => !c.disabled), props.captions);
  compare("text", textTrackOf(timeline, "TEXT").filter((t) => !t.disabled), props.texts);
  compare("graphic", graphicsTrack(timeline).filter((g) => !g.disabled), props.graphics);

  /**
   * The payload ON a graphic, which an id comparison cannot catch. Losing it is the failure §11
   * names by hand: a location card whose location was dropped renders as a card with no words, and
   * the temptation at that point is to draw the word "map".
   */
  const byId = new Map(props.graphics.map((g) => [g.id, g]));
  for (const g of graphicsTrack(timeline).filter((x) => !x.disabled)) {
    const made = byId.get(g.id);
    if (!made) continue;
    const sourceKeys = Object.keys(g.data ?? {}).length;
    if (sourceKeys > 0 && Object.keys(made.data).length !== sourceKeys) {
      missing.push(`graphic ${g.id} lost part of its payload`);
    }
    if (g.label && !made.label) missing.push(`graphic ${g.id} lost its label`);
  }

  return missing;
}

/** One line for the render log. Never a URL, never a payload — ids and counts only. */
export function formatRemotionProps(props: RemotionGraphicsProps): string {
  return (
    `[RemotionGraphics] video=${props.meta.videoId} timelineVersion=${props.meta.timelineVersion} ` +
    `${props.width}x${props.height}@${props.fps} frames=${props.durationInFrames} ` +
    `captions=${props.captions.length} texts=${props.texts.length} ` +
    `graphics=${props.graphics.length} words=${props.words.length}`
  );
}
