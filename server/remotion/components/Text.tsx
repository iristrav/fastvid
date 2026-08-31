/**
 * RONDE 152 — text, captions and kinetic typography.
 *
 * ── §12/§152: the timing is the TTS's, never recomputed ─────────────────────────────────────
 *
 * `words` are the measured boundaries from the alignment that already ran. A word highlights at
 * exactly `word.startSec` because that is when it is spoken — not at an even share of the line's
 * length, which is what a renderer that recomputed timing would produce and what makes captions
 * feel a beat off without anyone being able to say why.
 *
 * ── §152: style is DATA, and so is the animation ────────────────────────────────────────────
 *
 * Position, size, colour, weight, outline, highlight and animation all come from the timeline's
 * `TextStyle` and the caption's own fields. This file contains no thresholds and no timing: the
 * arithmetic lives in `animation.ts` as pure functions, so an animation is deterministic and can be
 * tested without a browser.
 *
 * ── What this component does NOT decide ─────────────────────────────────────────────────────
 *
 * Where the text goes. `captionLayout.ts` measures boxes and resolves collisions before the render
 * begins, and passes the answer down as `layout`. A component that positioned itself would be a
 * second opinion about the same question, and the two would drift.
 */
import React from "react";
import { AbsoluteFill, Sequence, useCurrentFrame } from "remotion";
import {
  animationAt,
  chunkCaption,
  revealProgress,
  type CaptionWord,
} from "./animation";

export type TextStyleLike = {
  fontFamily?: string;
  fontSizePx: number;
  color: string;
  backgroundColor?: string;
  backgroundOpacity: number;
  position: string;
  maxCharsPerLine?: number;
  fontWeight?: number;
  italic?: boolean;
  align?: "left" | "center" | "right";
  maxWidthPct?: number;
  lineHeight?: number;
  letterSpacingEm?: number;
  outlineColor?: string;
  outlineWidthPx?: number;
  shadow?: boolean;
  highlightColor?: string;
  emphasisColor?: string;
  maxLines?: number;
};

export type WordTiming = CaptionWord;

/** Where the layout engine decided this element goes, in pixels. */
export type ResolvedLayout = { x: number; y: number; width: number; height: number };

const DEFAULT_FONT = "DejaVu Sans, Liberation Sans, sans-serif";
const DEFAULT_HIGHLIGHT = "#ffd54a";

/** The vocabulary from projectTimeline's TextStyle, mapped to layout. Nothing invented. */
export function positionStyle(position: string): React.CSSProperties {
  switch (position) {
    case "top":
      return { justifyContent: "flex-start", alignItems: "center", paddingTop: "6%" };
    case "center":
      return { justifyContent: "center", alignItems: "center" };
    case "lower_third":
      return { justifyContent: "flex-end", alignItems: "flex-start", padding: "0 8% 22% 8%" };
    case "lower_center":
      return { justifyContent: "flex-end", alignItems: "center", paddingBottom: "28%" };
    default:
      return { justifyContent: "flex-end", alignItems: "center", paddingBottom: "6%" };
  }
}

/**
 * The text's own appearance, from the style and nothing else.
 *
 * The outline is built from `text-shadow` rather than `-webkit-text-stroke`, because a stroke is
 * drawn centred on the glyph edge and eats into thin letterforms at caption sizes; four offset
 * shadows sit entirely outside them. The default when a style asks for neither an outline nor a box
 * is a soft drop shadow — without it, white text on bright archival footage is unreadable, which is
 * the same reason the ASS route gives an un-boxed style an outline.
 */
function boxStyle(style: TextStyleLike): React.CSSProperties {
  const outlineWidth = style.outlineWidthPx ?? 0;
  const outlineColour = style.outlineColor ?? "rgba(0,0,0,0.9)";
  const outline =
    outlineWidth > 0
      ? [
          `${outlineWidth}px 0 0 ${outlineColour}`,
          `-${outlineWidth}px 0 0 ${outlineColour}`,
          `0 ${outlineWidth}px 0 ${outlineColour}`,
          `0 -${outlineWidth}px 0 ${outlineColour}`,
        ].join(", ")
      : null;
  const shadow = style.shadow !== false ? "0 2px 6px rgba(0,0,0,0.85)" : null;

  return {
    fontSize: style.fontSizePx,
    color: style.color,
    fontFamily: style.fontFamily ?? DEFAULT_FONT,
    fontWeight: style.fontWeight ?? 700,
    fontStyle: style.italic ? "italic" : "normal",
    lineHeight: style.lineHeight ?? 1.25,
    letterSpacing: style.letterSpacingEm != null ? `${style.letterSpacingEm}em` : undefined,
    textAlign: style.align ?? "center",
    maxWidth: `${(style.maxWidthPct ?? 0.84) * 100}%`,
    padding: style.backgroundOpacity > 0 ? "0.35em 0.6em" : 0,
    borderRadius: 6,
    backgroundColor:
      style.backgroundOpacity > 0
        ? style.backgroundColor ??
          `rgba(0,0,0,${Math.max(0, Math.min(1, style.backgroundOpacity)).toFixed(3)})`
        : "transparent",
    textShadow: [outline, shadow].filter(Boolean).join(", ") || undefined,
  };
}

/**
 * The words of one chunk, coloured by what is being spoken and what the planner emphasised.
 *
 * A highlight is a COLOUR change and never a size change: growing the active word reflows the line
 * on every syllable, and the whole caption jitters.
 */
const Words: React.FC<{
  words: CaptionWord[];
  absoluteSec: number;
  style: TextStyleLike;
  mode: string;
  emphasisIndices: readonly number[];
  /** 0..1 — how much of the chunk a progressive animation has revealed. */
  reveal: number;
}> = ({ words, absoluteSec, style, mode, emphasisIndices, reveal }) => {
  const highlights = mode === "karaoke" || mode === "highlight_word";
  const visibleCount = Math.ceil(words.length * reveal);

  return (
    <>
      {words.map((w, i) => {
        if (reveal < 1 && i >= visibleCount) return null;
        const spoken = absoluteSec >= w.startSec && absoluteSec < w.endSec;
        const emphasised = emphasisIndices.includes(i);
        const colour = emphasised
          ? style.emphasisColor ?? style.highlightColor ?? DEFAULT_HIGHLIGHT
          : highlights && spoken
            ? style.highlightColor ?? DEFAULT_HIGHLIGHT
            : style.color;
        return (
          <span
            key={`${w.word}-${i}`}
            style={{
              color: colour,
              marginRight: "0.28em",
              /** Emphasis is weight, not size — same anti-jitter rule as the highlight. */
              fontWeight: emphasised ? 900 : undefined,
            }}
          >
            {w.word}
          </span>
        );
      })}
    </>
  );
};

/** Plain text, revealed progressively when the animation asks for it. */
const PlainText: React.FC<{ text: string; animation: string; reveal: number }> = ({
  text,
  animation,
  reveal,
}) => {
  if (reveal >= 1) return <>{text}</>;
  if (animation === "character_reveal" || animation === "type_on") {
    return <>{text.slice(0, Math.ceil(text.length * reveal))}</>;
  }
  if (animation === "word_reveal") {
    const words = text.split(/\s+/);
    return <>{words.slice(0, Math.ceil(words.length * reveal)).join(" ")}</>;
  }
  return <>{text}</>;
};

export const TextElement: React.FC<{
  text: string;
  fromFrame: number;
  durationInFrames: number;
  style: TextStyleLike;
  animation: string;
  /** Present only for captions with measured word timing. */
  words?: WordTiming[];
  fps: number;
  /** RONDE 152 — how the caption is broken up over time. Absent means the whole sentence. */
  mode?: string;
  emphasisWordIndices?: number[];
  /** RONDE 152 — where `captionLayout` decided this goes. Absent means use the named position. */
  layout?: ResolvedLayout;
}> = (props) => {
  const { chunks } = chunkCaption({
    mode: props.mode,
    words: props.words ?? [],
    startSec: props.fromFrame / props.fps,
    endSec: (props.fromFrame + props.durationInFrames) / props.fps,
  });

  return (
    <>
      {chunks.map((chunk, i) => {
        /**
         * Each chunk is its own Sequence, so `word_by_word` and `phrase` really do appear and
         * disappear on the TTS's boundaries rather than being hidden with opacity while occupying
         * the layout. A hidden-but-present chunk would still push its neighbours around.
         */
        const from = Math.round(chunk.startSec * props.fps);
        const until = Math.round(chunk.endSec * props.fps);
        const durationInFrames = Math.max(1, until - from);
        return (
          <Sequence
            key={`${props.text.slice(0, 12)}-${i}`}
            from={from}
            durationInFrames={durationInFrames}
            name={chunk.words.map((w) => w.word).join(" ").slice(0, 24) || props.text.slice(0, 24)}
          >
            <TextBody
              {...props}
              chunkWords={chunk.words}
              chunkFromFrame={from}
              chunkDurationInFrames={durationInFrames}
            />
          </Sequence>
        );
      })}
    </>
  );
};

const TextBody: React.FC<
  React.ComponentProps<typeof TextElement> & {
    chunkWords: CaptionWord[];
    chunkFromFrame: number;
    chunkDurationInFrames: number;
  }
> = ({
  text,
  style,
  animation,
  fps,
  mode,
  emphasisWordIndices,
  layout,
  chunkWords,
  chunkFromFrame,
  chunkDurationInFrames,
}) => {
  const frame = useCurrentFrame();
  const state = animationAt(animation, frame, chunkDurationInFrames);
  const reveal = revealProgress(animation, frame, chunkDurationInFrames);

  /** Where we are in the VIDEO, so a word's own start/end compares directly. */
  const absoluteSec = (chunkFromFrame + frame) / fps;

  const inner = (
    <div
      style={{
        ...boxStyle(style),
        opacity: state.opacity,
        transform:
          `translate(${state.translateX}px, ${state.translateY}px) scale(${state.scale})`,
        /** `mask_reveal` wipes the box open from the left. Nothing else clips. */
        clipPath:
          state.revealFraction < 1
            ? `inset(0 ${((1 - state.revealFraction) * 100).toFixed(2)}% 0 0)`
            : undefined,
      }}
    >
      {chunkWords.length > 0 ? (
        <Words
          words={chunkWords}
          absoluteSec={absoluteSec}
          style={style}
          mode={mode ?? "sentence"}
          emphasisIndices={emphasisWordIndices ?? []}
          reveal={reveal}
        />
      ) : (
        <PlainText text={text} animation={animation} reveal={reveal} />
      )}
    </div>
  );

  /**
   * A resolved layout wins over the named position.
   *
   * `captionLayout` measured the boxes and settled any collision before the render started; using
   * the named anchor here as well would undo that work for exactly the captions that needed it.
   */
  if (layout) {
    return (
      <AbsoluteFill>
        <div
          style={{
            position: "absolute",
            left: layout.x,
            top: layout.y,
            width: layout.width,
            display: "flex",
            justifyContent: style.align === "left" ? "flex-start" : "center",
          }}
        >
          {inner}
        </div>
      </AbsoluteFill>
    );
  }

  return (
    <AbsoluteFill style={{ ...positionStyle(style.position), display: "flex" }}>{inner}</AbsoluteFill>
  );
};
