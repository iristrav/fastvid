/**
 * RONDE 150 §5/§6 — the graphics layer, and ONLY the graphics layer.
 *
 * ── What changed, and why it is a subtraction ────────────────────────────────────────────────
 *
 * This composition used to draw the whole video: clips, camera moves, colour grade, film grain,
 * transitions, audio. It worked. It was also a SECOND renderer for every one of those things —
 * a second camera implementation, a second grade, a second effects engine — each one free to
 * disagree with the ffmpeg chain that already existed and was already tuned.
 *
 * §5 is "FFmpeg + Remotion", not "FFmpeg OF Remotion". So the picture belongs to ffmpeg, which
 * owns `timelineFilters.ts`, `documentaryStyle.ts` and `cinematicAudio/`, and the graphics belong
 * here, where a browser can lay out a lower third with a role underneath a name and ffmpeg's
 * drawtext cannot (the bundled ffmpeg-static has no drawtext at all).
 *
 *     VIDEO track  → ffmpeg  → the picture
 *     GRAPHICS     → THIS    → a transparent overlay
 *                  → ffmpeg  → composited on top
 *
 * ── The transparent background is the whole point ────────────────────────────────────────────
 *
 * There is no `backgroundColor` below, and no `<AbsoluteFill>` wrapper painting one. Every pixel
 * this composition does not draw stays fully transparent, travels through ProRes 4444's alpha
 * channel, and lets ffmpeg's `overlay` show the picture underneath. A single opaque fill anywhere
 * in this tree would black out the film and produce a video that is nothing but captions.
 *
 * ── §29: it assembles, it does not decide ────────────────────────────────────────────────────
 *
 * Every value comes from the props, the props came from the timeline, the timeline came from the
 * planners. No branch here reads a scene index or a threshold. The components know how a location
 * card LOOKS; they do not know when one should appear.
 */
import React from "react";
import { AbsoluteFill, useVideoConfig } from "remotion";
import { TextElement } from "./components/Text";
import { Graphic } from "./components/Graphics";

/**
 * The props shape, structurally identical to `RemotionGraphicsProps` in server/remotionProps.ts.
 *
 * Declared independently rather than imported: this file is compiled into a BROWSER bundle by
 * Remotion's webpack, and importing the server module would drag its fs/path dependencies in. A
 * test asserts the two shapes stay compatible.
 *
 * Note what is NOT here: no clips, no media URLs, no audio. Not an omission — the graphics layer
 * has no use for them, and §26's "no credentials into the browser bundle" stops being a rule that
 * a sanitiser has to enforce and becomes a fact about the shape.
 */
export type GraphicsOverlayProps = {
  fps: number;
  width: number;
  height: number;
  durationInFrames: number;
  durationSec: number;
  captions: Array<Record<string, unknown>>;
  texts: Array<Record<string, unknown>>;
  graphics: Array<Record<string, unknown>>;
  words: Array<{ word: string; startSec: number; endSec: number }>;
  /** RONDE 152 — reported by the layout engine, carried for the render report only. */
  unresolvedCollisions?: string[];
  meta: { videoId: number; timelineVersion: number; schemaVersion: number };
};

/** The words spoken inside one caption's window — its own slice of the measured alignment. */
function wordsWithin(
  words: GraphicsOverlayProps["words"],
  fromFrame: number,
  durationInFrames: number,
  fps: number
): GraphicsOverlayProps["words"] {
  const start = fromFrame / fps;
  const end = (fromFrame + durationInFrames) / fps;
  return words.filter((w) => w.endSec > start && w.startSec < end);
}

type TextLike = {
  id: string;
  text: string;
  fromFrame: number;
  durationInFrames: number;
  style: never;
  animation: string;
  /** RONDE 152 — set by remotionProps; absent means the defaults this file already had. */
  mode?: string;
  emphasisWordIndices?: number[];
  layout?: { x: number; y: number; width: number; height: number };
};

export const GraphicsOverlay: React.FC<GraphicsOverlayProps> = (props) => {
  const { fps } = useVideoConfig();

  return (
    /**
     * Layer order: graphics, then text, then captions.
     *
     * Captions sit on top deliberately. A caption is the narration itself, and a decorative card
     * covering the words being spoken is the one overlap that is never acceptable.
     */
    <AbsoluteFill>
      {props.graphics.map((raw, i) => (
        <Graphic key={(raw.id as string) ?? `g${i}`} g={raw as never} />
      ))}

      {props.texts.map((raw, i) => {
        const t = raw as never as TextLike;
        return (
          <TextElement
            key={t.id ?? `t${i}`}
            text={t.text}
            fromFrame={t.fromFrame}
            durationInFrames={t.durationInFrames}
            style={t.style}
            animation={t.animation}
            fps={fps}
            layout={t.layout}
          />
        );
      })}

      {props.captions.map((raw, i) => {
        const c = raw as never as TextLike;
        return (
          <TextElement
            key={c.id ?? `c${i}`}
            text={c.text}
            fromFrame={c.fromFrame}
            durationInFrames={c.durationInFrames}
            style={c.style}
            animation={c.animation}
            fps={fps}
            /** §13 — the caption gets the MEASURED word boundaries for its own window. */
            words={wordsWithin(props.words, c.fromFrame, c.durationInFrames, fps)}
            /** RONDE 152 — the caption's own mode, emphasis and resolved position. */
            mode={c.mode}
            emphasisWordIndices={c.emphasisWordIndices}
            layout={c.layout}
          />
        );
      })}
    </AbsoluteFill>
  );
};
