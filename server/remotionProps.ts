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
  type Obstacle,
} from "./captionLayout";

/** The style a graphic is measured at when it carries none of its own. */
const DEFAULT_GRAPHIC_STYLE: TextStyle = { ...DEFAULT_TEXT_STYLE, fontSizePx: 46 };

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
  const obstacles: Obstacle[] = [
    ...graphicsTrack(timeline)
      .filter((g) => !g.disabled && g.label?.trim())
      .map((g) => {
        const style = g.style ?? DEFAULT_GRAPHIC_STYLE;
        const size = measureText(g.label!, style, frame);
        return {
          id: g.id,
          kind: "graphic" as const,
          box: boxForPosition(style.position, size, frame, style),
          startSec: g.start,
          endSec: g.end,
        };
      }),
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
      .map((g) => ({
        id: g.id,
        graphicType: g.graphicType,
        data: g.data ?? {},
        label: g.label ?? null,
        fromFrame: toFrames(g.start, fps),
        durationInFrames: Math.max(1, toFrames(Math.max(0, g.end - g.start), fps)),
        style: g.style ?? null,
        reason: g.reason ?? null,
      })),
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
