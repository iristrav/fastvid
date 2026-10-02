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
import { AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig } from "remotion";
import {
  animationAt,
  chunkCaption,
  revealProgress,
  type CaptionWord,
} from "./animation";
import { typedCount, typedLength } from "./typewriter";
import { anchorGeometry, maxCharsPerLine, wrapWordsBalanced } from "../../captionLayout";

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

/** OCTOBER 2026 — Inter is bundled (remotion/fonts.ts); DejaVu stays behind it, the face `measureText` assumes. */
const DEFAULT_FONT = "Inter, DejaVu Sans, Liberation Sans, sans-serif";
const DEFAULT_HIGHLIGHT = "#ffd54a";

/**
 * The vocabulary from projectTimeline's TextStyle, mapped to layout. Nothing invented.
 *
 * ── Why this takes the frame, and why the paddings are pixels ───────────────────────────────
 *
 * These anchors used to be written as CSS percentages — `paddingBottom: "22%"` for a lower third.
 * A percentage padding in CSS resolves against the containing block's WIDTH, vertical padding
 * included, so on a 1920×1080 frame the browser read that as 422px while `boxForPosition` and
 * `assMarginV` both meant 238px. See `ANCHOR_GEOMETRY` for what that cost: the collision engine
 * placed captions against a card that was not where it thought, found no overlap, and reported
 * none while the two struck through each other on screen.
 *
 * Pixels computed from the composition's real dimensions have no such ambiguity, and taking the
 * fractions from `ANCHOR_GEOMETRY` means this cannot drift from the engine that reasons about it.
 */
export function positionStyle(
  position: string,
  frame: { widthPx: number; heightPx: number }
): React.CSSProperties {
  if (position === "center") return { justifyContent: "center", alignItems: "center" };
  const anchor = anchorGeometry(position);
  if (anchor.topPct != null) {
    return {
      justifyContent: "flex-start",
      alignItems: "center",
      paddingTop: Math.round(frame.heightPx * anchor.topPct),
    };
  }
  return {
    justifyContent: "flex-end",
    alignItems: anchor.leftPct != null ? "flex-start" : "center",
    paddingBottom: Math.round(frame.heightPx * (anchor.bottomPct ?? 0)),
    ...(anchor.leftPct != null
      ? {
          paddingLeft: frame.widthPx * anchor.leftPct,
          paddingRight: frame.widthPx * anchor.leftPct,
        }
      : {}),
  };
}

/**
 * OCTOBER 2026 — the plate's colour WITH the style's opacity.
 *
 * `DEFAULT_CAPTION_STYLE` says `backgroundColor: "black", backgroundOpacity: 0.45`, and the colour
 * used to win outright: every default caption sat on a solid black slab. A named or hex colour now
 * takes the opacity; a colour that already carries its own alpha (`rgba(…)`, `hsla(…)`) is kept.
 */
export function plateColour(colour: string | undefined, opacity: number): string {
  const a = Math.max(0, Math.min(1, opacity)).toFixed(3);
  const c = (colour ?? "black").trim().toLowerCase();
  const named: Record<string, [number, number, number]> = { black: [0, 0, 0], white: [255, 255, 255] };
  if (named[c]) return `rgba(${named[c]!.join(",")},${a})`;
  const hex = c.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (hex) {
    const h = hex[1]!.length === 3 ? [...hex[1]!].map((x) => x + x).join("") : hex[1]!;
    return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})`;
  }
  return colour!;
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
function boxStyle(style: TextStyleLike, inLayoutBox = false): React.CSSProperties {
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
    /** OCTOBER 2026 — whole pixels, so a translucent plate has crisp edges wherever it sits. */
    lineHeight: `${Math.round(style.fontSizePx * (style.lineHeight ?? 1.25))}px`,
    letterSpacing: style.letterSpacingEm != null ? `${style.letterSpacingEm}em` : undefined,
    textAlign: style.align ?? "center",
    /**
     * OCTOBER 2026 — THE ROOT OF THE CAPTION-BOX BUG. A caption the layout engine moved is drawn
     * inside the box it measured for it, and the 84% limit was applied again INSIDE that box: the
     * plate came out 16% narrower than its own text and the words ran past its edges. The lines are
     * already fixed by the frame's character budget, so inside a measured box there is no second limit.
     */
    maxWidth: inLayoutBox ? "none" : `${(style.maxWidthPct ?? 0.84) * 100}%`,
    /**
     * OCTOBER 2026 — the plate is as wide as its longest line: the lines are fixed by
     * `wrapWordsBalanced` and drawn unwrapped, so this block shrinks to them instead of stretching
     * to `maxWidth`. The padding is the one `measureText` assumes (0.35em / 0.6em).
     */
    width: "fit-content",
    boxSizing: "border-box",
    padding: style.backgroundOpacity > 0 ? `${Math.round(style.fontSizePx * 0.35)}px ${Math.round(style.fontSizePx * 0.6)}px` : 0,
    borderRadius: 6,
    backgroundColor:
      style.backgroundOpacity > 0 ? plateColour(style.backgroundColor, style.backgroundOpacity) : "transparent",
    textShadow: [outline, shadow].filter(Boolean).join(", ") || undefined,
  };
}

/**
 * The words of one chunk, coloured by what is being spoken and what the planner emphasised.
 *
 * A highlight is a COLOUR change and never a size change: growing the active word reflows the line
 * on every syllable, and the whole caption jitters.
 */
/**
 * OCTOBER 2026 — tokens drawn on the lines `wrapWordsBalanced` fixed, each line unwrapped, words
 * separated by a real space. (Every word used to carry a right margin — the last one too — so the
 * plate always ran 0.28em past the text on the right and the line sat off-centre in it.)
 */
const Lines: React.FC<{
  lines: number[][];
  render: (index: number) => React.ReactNode;
}> = ({ lines, render }) => (
  <>
    {lines.map((line, l) => (
      <div key={l} style={{ whiteSpace: "nowrap" }}>
        {line.map((i, k) => (
          <React.Fragment key={i}>
            {k > 0 ? " " : null}
            {render(i)}
          </React.Fragment>
        ))}
      </div>
    ))}
  </>
);

const Words: React.FC<{
  words: CaptionWord[];
  lines: number[][];
  absoluteSec: number;
  style: TextStyleLike;
  mode: string;
  emphasisIndices: readonly number[];
  /** 0..1 — how much of the chunk a progressive animation has revealed. */
  reveal: number;
}> = ({ words, lines, absoluteSec, style, mode, emphasisIndices, reveal }) => {
  const highlights = mode === "karaoke" || mode === "highlight_word";
  const visibleCount = Math.ceil(words.length * reveal);

  return (
    <Lines
      lines={lines}
      render={(i) => {
        const w = words[i]!;
        const spoken = absoluteSec >= w.startSec && absoluteSec < w.endSec;
        const emphasised = emphasisIndices.includes(i);
        const colour = emphasised
          ? style.emphasisColor ?? style.highlightColor ?? DEFAULT_HIGHLIGHT
          : highlights && spoken
            ? style.highlightColor ?? DEFAULT_HIGHLIGHT
            : style.color;
        return (
          <span
            style={{
              color: colour,
              /** Emphasis is weight, not size — same anti-jitter rule as the highlight. */
              fontWeight: emphasised ? 900 : undefined,
              /** A word not yet revealed keeps its place, so the plate does not grow while it reveals. */
              visibility: reveal < 1 && i >= visibleCount ? "hidden" : undefined,
            }}
          >
            {w.word}
          </span>
        );
      }}
    />
  );
};

/** Plain text, on its fixed lines, revealed progressively when the animation asks for it. */
const PlainText: React.FC<{ tokens: string[]; lines: number[][]; animation: string; reveal: number }> = ({
  tokens,
  lines,
  animation,
  reveal,
}) => {
  /** Characters before each token, so a character-wise reveal runs across the lines in reading order. */
  const before: number[] = [];
  let total = 0;
  for (const t of tokens) {
    before.push(total);
    total += [...t].length + 1;
  }
  const byChar = animation === "character_reveal" || animation === "type_on" || animation === "typewriter";
  const shownChars = animation === "typewriter" ? Math.round(total * reveal) : Math.ceil(total * reveal);
  const shownWords = Math.ceil(tokens.length * reveal);
  return (
    <Lines
      lines={lines}
      render={(i) => {
        const t = tokens[i]!;
        if (reveal >= 1) return t;
        if (byChar) {
          /** RONDE 656 — the untyped rest is laid out but invisible, so the line does not grow as it types. */
          const chars = [...t];
          const shown = Math.max(0, Math.min(chars.length, shownChars - before[i]!));
          return (
            <>
              {chars.slice(0, shown).join("")}
              <span style={{ visibility: "hidden" }}>{chars.slice(shown).join("")}</span>
            </>
          );
        }
        if (animation === "word_reveal") return <span style={{ visibility: i < shownWords ? undefined : "hidden" }}>{t}</span>;
        return t;
      }}
    />
  );
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
  const { width: compositionWidth, height: compositionHeight } = useVideoConfig();
  const state = animationAt(animation, frame, chunkDurationInFrames);
  /** RONDE 656 — a typewriter types at its own fixed pace, not over the element's life. */
  const reveal =
    animation === "typewriter"
      ? typedLength(text) === 0
        ? 1
        : typedCount(text, frame / fps) / typedLength(text)
      : revealProgress(animation, frame, chunkDurationInFrames);

  /** Where we are in the VIDEO, so a word's own start/end compares directly. */
  const absoluteSec = (chunkFromFrame + frame) / fps;

  /** OCTOBER 2026 — the lines, fixed by the same character budget the layout engine measured with. */
  const maxChars = maxCharsPerLine(style as never, { widthPx: compositionWidth, heightPx: compositionHeight });
  const tokens = chunkWords.length > 0 ? chunkWords.map((w) => w.word) : text.trim().split(/\s+/).filter(Boolean);
  const lines = wrapWordsBalanced(tokens, maxChars);

  const inner = (
    <div
      style={{
        ...boxStyle(style, Boolean(layout)),
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
          lines={lines}
          absoluteSec={absoluteSec}
          style={style}
          mode={mode ?? "sentence"}
          emphasisIndices={emphasisWordIndices ?? []}
          reveal={reveal}
        />
      ) : (
        <PlainText tokens={tokens} lines={lines} animation={animation} reveal={reveal} />
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
            /** OCTOBER 2026 — whole pixels: a translucent plate at a fractional position loses an edge row. */
            left: Math.round(layout.x),
            top: Math.round(layout.y),
            width: Math.round(layout.width),
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
    <AbsoluteFill
      style={{
        ...positionStyle(style.position, {
          widthPx: compositionWidth,
          heightPx: compositionHeight,
        }),
        display: "flex",
      }}
    >
      {inner}
    </AbsoluteFill>
  );
};
