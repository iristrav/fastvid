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
  captionTrack,
  graphicsTrack,
  textTrackOf,
  type ProjectTimeline,
  type TextStyle,
} from "./projectTimeline";

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

  const textElement = (
    el: { id: string; text: string; start: number; end: number; style: TextStyle; animation?: string },
    role: "caption" | "text"
  ): RemotionTextElement => ({
    id: el.id,
    text: el.text,
    fromFrame: toFrames(el.start, fps),
    durationInFrames: Math.max(1, toFrames(Math.max(0, el.end - el.start), fps)),
    style: el.style,
    /** The renderer's existing default when a planner expressed no preference. Named, not silent. */
    animation: el.animation ?? "fade",
    role,
  });

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
